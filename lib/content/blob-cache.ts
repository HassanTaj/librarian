import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { LIMITS } from '../limits';
import { blobSha, type BlobCache } from '../sync/github';
import { openSafeFile } from './paths';

const key = /^[1-9]\d*-([a-f0-9]{40})$/;
const temporary = /^tmp-[a-f0-9-]{36}$/;
const unsafe = () => new Error('generation_invalid_path');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

function contained(root: string, target: string) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function cacheDirectory(contentRoot: string, catalogId: string, create: boolean) {
  z.uuidv4().parse(catalogId);
  const root = await realpath(contentRoot);
  const publicRoot = await realpath(resolve('public')).catch(() => resolve('public'));
  if (root === publicRoot || contained(publicRoot, root)) throw unsafe();
  let path = root;
  for (const segment of [catalogId, 'blob-cache']) {
    path = join(path, segment);
    if (create) await mkdir(path, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || !contained(root, await realpath(path))) throw unsafe();
  }
  return path;
}

async function entries(directory: string) {
  const names = await readdir(directory);
  if (names.length > LIMITS.maxFiles * 2 + 2) throw unsafe();
  return Promise.all(names.map(async name => {
    if (!key.test(name) && !temporary.test(name) && name !== 'lock') throw unsafe();
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink()) throw unsafe();
    return { name, size: info.size, modified: info.mtimeMs };
  }));
}

async function withLock<T>(directory: string, signal: AbortSignal | undefined, work: () => Promise<T>) {
  signal?.throwIfAborted();
  const lockPath = join(directory, 'lock');
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
    .catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined; throw error; });
  if (!lock) {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) throw unsafe();
    return undefined;
  }
  try { signal?.throwIfAborted(); return await work(); }
  finally { await lock.close(); await unlink(lockPath); }
}

async function recoverLock(directory: string) {
  const info = await lstat(join(directory, 'lock')).catch(error => { if (missing(error)) return undefined; throw error; });
  if (!info) return;
  if (info.isSymbolicLink() || !info.isFile()) throw unsafe();
  // A cache operation is bounded by the sync deadline; leave recent locks to their owner.
  if (Date.now() - info.mtimeMs > LIMITS.attemptTimeoutMs * 2) await unlink(join(directory, 'lock'));
}

async function prune(directory: string, revision: number, maximum: number, reserve = 0, reserveFile = false,
  inventory?: Map<string, Awaited<ReturnType<typeof entries>>[number]>) {
  const all = inventory ? [...inventory.values()] : await entries(directory);
  let bytes = all.reduce((total, file) => total + file.size, 0);
  let count = all.filter(file => key.test(file.name)).length;
  for (const file of all.filter(file => file.name !== 'lock').sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name))) {
    const reusable = file.name.startsWith(`${revision}-`) && key.test(file.name);
    if (reusable && bytes + reserve <= maximum && count + Number(reserveFile) <= LIMITS.maxFiles) continue;
    await unlink(join(directory, file.name));
    inventory?.delete(file.name);
    bytes -= file.size;
    if (key.test(file.name)) count--;
  }
  return bytes;
}

function fallback(error: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (error instanceof Error && error.message === 'generation_invalid_path') throw error;
}

/** Evict disposable cache bytes before reserving room for a complete generation. */
export async function trimBlobCache(contentRoot: string, catalogId: string, revision: number, maximum: number, signal?: AbortSignal) {
  z.number().int().positive().parse(revision);
  const budget = Math.max(0, Math.min(LIMITS.maxSnapshotBytes, maximum));
  let directory: string;
  try { directory = await cacheDirectory(contentRoot, catalogId, false); }
  catch (error) { if (missing(error)) return 0; throw error; }
  await recoverLock(directory);
  const trimmed = await withLock(directory, signal, () => prune(directory, revision, budget));
  if (trimmed !== undefined) return trimmed;
  return (await entries(directory)).reduce((total, file) => total + file.size, 0);
}

export function createBlobCache(contentRoot: string, catalogId: string, revision: number, maximum: number,
  signal: AbortSignal, canWrite: () => Promise<boolean>): BlobCache {
  z.uuidv4().parse(catalogId);
  z.number().int().positive().parse(revision);
  const budget = Math.max(0, Math.min(LIMITS.maxSnapshotBytes, maximum));
  let queue = Promise.resolve();
  // One fenced worker writes each catalog; the per-write lock still serializes and fences mutations.
  let inventory: Map<string, Awaited<ReturnType<typeof entries>>[number]> | undefined;
  return {
    async get(sha, size) {
      if (!/^[a-f0-9]{40}$/.test(sha) || !Number.isSafeInteger(size) || size < 0 || size > LIMITS.maxSnapshotBytes) throw unsafe();
      signal.throwIfAborted();
      let handle;
      try {
        await cacheDirectory(contentRoot, catalogId, false);
        handle = await openSafeFile(contentRoot, `${catalogId}/blob-cache/${revision}-${sha}`);
        if ((await handle.stat()).size !== size) return undefined;
        const bytes = await handle.readFile();
        signal.throwIfAborted();
        return bytes.length === size && blobSha(bytes) === sha ? bytes : undefined;
      } catch (error) {
        // Unsafe filesystem entries are not ordinary cache misses.
        if (error instanceof Error && error.message === 'invalid_path') throw unsafe();
        fallback(error, signal);
        return undefined;
      } finally { await handle?.close(); }
    },
    async put(sha, bytes) {
      if (!/^[a-f0-9]{40}$/.test(sha) || blobSha(bytes) !== sha) throw unsafe();
      const write = async () => {
        signal.throwIfAborted();
        if (!budget || bytes.length > budget || !await canWrite()) return;
        let directory: string;
        try {
          directory = await cacheDirectory(contentRoot, catalogId, true);
          await withLock(directory, signal, async () => {
            inventory ??= new Map((await entries(directory)).map(file => [file.name, file]));
            const target = `${revision}-${sha}`;
            const existing = inventory.get(target);
            if (existing) {
              const current = await lstat(join(directory, target)).catch(error => { if (!missing(error)) throw error; return undefined; });
              if (current && (current.isSymbolicLink() || !current.isFile())) throw unsafe();
              if (current) await unlink(join(directory, target));
              inventory.delete(target);
            }
            const used = await prune(directory, revision, budget, bytes.length, true, inventory);
            if (used + bytes.length > budget) return;
            const temp = `tmp-${randomUUID()}`;
            try {
              const handle = await open(join(directory, temp), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
              try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
              signal.throwIfAborted();
              if (!await canWrite()) return;
              signal.throwIfAborted();
              await rename(join(directory, temp), join(directory, target));
              inventory.set(target, { name: target, size: bytes.length, modified: Date.now() });
            } finally { await unlink(join(directory, temp)).catch(error => { if (!missing(error)) throw error; }); }
          });
        } catch (error) { fallback(error, signal); }
      };
      const pending = queue.then(write);
      queue = pending.catch(() => {});
      await pending;
    },
  };
}
