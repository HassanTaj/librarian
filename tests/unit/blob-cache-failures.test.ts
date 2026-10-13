import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBlobCache, trimBlobCache } from '../../lib/content/blob-cache';
import { blobSha } from '../../lib/sync/github';
import { LIMITS } from '../../lib/limits';
import { stageGeneration } from '../../lib/content/generations';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof fs>();
  return { ...original, mkdir: vi.fn(original.mkdir), open: vi.fn(original.open),
    lstat: vi.fn(original.lstat), realpath: vi.fn(original.realpath), readdir: vi.fn(original.readdir),
    rename: vi.fn(original.rename), unlink: vi.fn(original.unlink) };
});
const original = await vi.importActual<typeof fs>('node:fs/promises');
const denied = Object.assign(new Error('Synthetic disk failure'), { code: 'EACCES' });
const roots: string[] = [];
beforeEach(() => {
  vi.mocked(fs.mkdir).mockImplementation(original.mkdir);
  vi.mocked(fs.open).mockImplementation(original.open);
  vi.mocked(fs.lstat).mockImplementation(original.lstat);
  vi.mocked(fs.realpath).mockImplementation(original.realpath);
  vi.mocked(fs.readdir).mockImplementation(original.readdir);
  vi.mocked(fs.rename).mockImplementation(original.rename);
  vi.mocked(fs.unlink).mockImplementation(original.unlink);
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => original.rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await original.mkdtemp(join(tmpdir(), 'librarian-cache-fault-'));
  roots.push(root);
  const id = randomUUID();
  const directory = join(root, id, 'blob-cache');
  const signal = new AbortController().signal;
  const cache = createBlobCache(root, id, 1, 50, signal, async () => true);
  const bytes = Buffer.from('blob');
  return { root, id, directory, cache, bytes, sha: blobSha(bytes) };
}

it('falls back on unavailable cache reads and directory creation', async () => {
  const f = await setup();
  vi.mocked(fs.realpath).mockRejectedValueOnce(denied);
  expect(await f.cache.get(f.sha, 4)).toBeUndefined();
  vi.mocked(fs.mkdir).mockRejectedValueOnce(denied);
  await f.cache.put(f.sha, f.bytes);
  expect(await f.cache.get(f.sha, 4)).toBeUndefined();
});

it('falls back on lock/open failures and failed atomic rename without leaving partial files', async () => {
  const f = await setup();
  vi.mocked(fs.open).mockRejectedValueOnce(denied);
  await f.cache.put(f.sha, f.bytes);
  expect(await original.readdir(f.directory)).toEqual([]);
  vi.mocked(fs.rename).mockRejectedValueOnce(denied);
  await f.cache.put(f.sha, f.bytes);
  expect(await original.readdir(f.directory)).toEqual([]);
  await f.cache.put(f.sha, f.bytes);
  expect(await f.cache.get(f.sha, 4)).toEqual(f.bytes);
});

it('fails closed if a cache lock is a directory or lock inspection fails', async () => {
  const f = await setup();
  await original.mkdir(join(f.directory, 'lock'), { recursive: true });
  await expect(f.cache.put(f.sha, f.bytes)).rejects.toThrow('generation_invalid_path');
  await expect(trimBlobCache(f.root, f.id, 1, 50)).rejects.toThrow('generation_invalid_path');
  await original.rm(join(f.directory, 'lock'), { recursive: true });
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    if (String(path).endsWith(`${join('blob-cache', 'lock')}`)) throw denied;
    return original.lstat(path, options);
  });
  await expect(trimBlobCache(f.root, f.id, 1, 50)).rejects.toThrow('Synthetic disk failure');
});

it('rejects oversized directory inventories and non-missing storage errors', async () => {
  const f = await setup();
  await original.mkdir(f.directory, { recursive: true });
  vi.mocked(fs.readdir).mockResolvedValueOnce(Array(LIMITS.maxFiles * 2 + 3).fill('entry'));
  await expect(trimBlobCache(f.root, f.id, 1, 50)).rejects.toThrow('generation_invalid_path');
  vi.mocked(fs.realpath).mockRejectedValueOnce(denied);
  await expect(trimBlobCache(f.root, f.id, 1, 50)).rejects.toThrow('Synthetic disk failure');
});

it('uses the resolved public-path fallback and preserves cleanup errors without publishing a cache entry', async () => {
  const f = await setup();
  vi.mocked(fs.realpath).mockImplementation(async path => {
    if (String(path) === resolve('public')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return original.realpath(path);
  });
  await f.cache.put(f.sha, f.bytes);
  expect(await f.cache.get(f.sha, 4)).toEqual(f.bytes);
  vi.mocked(fs.unlink).mockImplementation(async path => {
    if (String(path).includes('tmp-')) throw denied;
    return original.unlink(path);
  });
  await f.cache.put(f.sha, f.bytes);
  expect(await f.cache.get(f.sha, 4)).toEqual(f.bytes);
});

it('counts lock-file bytes before reserving space for a temporary blob write', async () => {
  const f = await setup();
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await original.open(...args);
    if (String(args[0]).endsWith(join('blob-cache', 'lock'))) await handle.writeFile(Buffer.alloc(50));
    return handle;
  });
  await f.cache.put(f.sha, f.bytes);
  expect(await original.readdir(f.directory)).toEqual([]);
  expect(await f.cache.get(f.sha, f.bytes.length)).toBeUndefined();
});

it('rejects staging when cache/catalog accounting leaves no room and cleans the staging directory', async () => {
  const f = await setup();
  const owner = randomUUID();
  const input = { catalogId: f.id, configRevision: 1, owner, fence: 1, jobId: `manual:${f.id}:${randomUUID()}`,
    commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), files: [{ path: 'index.md', mode: '100644', content: Buffer.from('# Safe') }] };
  await expect(stageGeneration(f.root, input, LIMITS.maxCatalogPayloadBytes)).rejects.toThrow('retention_pressure');
  expect(await original.readdir(join(f.root, f.id))).toEqual([]);
  vi.mocked(fs.mkdir).mockRejectedValueOnce(denied);
  await expect(stageGeneration(f.root, input)).rejects.toThrow('generation_storage_unavailable');
  expect(await original.readdir(join(f.root, f.id))).toEqual([]);
});
