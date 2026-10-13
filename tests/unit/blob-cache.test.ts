import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createBlobCache, trimBlobCache } from '../../lib/content/blob-cache';
import { blobSha } from '../../lib/sync/github';
import { LIMITS } from '../../lib/limits';
import { deleteCatalogSnapshot, stageGeneration } from '../../lib/content/generations';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup(maximum = LIMITS.maxSnapshotBytes) {
  const root = await mkdtemp(join(tmpdir(), 'librarian-blob-cache-'));
  roots.push(root);
  const id = randomUUID();
  const signal = new AbortController();
  const canWrite = vi.fn(async () => true);
  const cache = createBlobCache(root, id, 1, maximum, signal.signal, canWrite);
  const directory = join(root, id, 'blob-cache');
  return { root, id, signal, canWrite, cache, directory };
}

it('persists verified raw bytes across adapter restarts and isolates catalogs/revisions', async () => {
  const f = await setup();
  const bytes = Buffer.from('---\r\ntitle: Original\r\n---\r\n# Original\r\n');
  const sha = blobSha(bytes);
  expect(await f.cache.get(sha, bytes.length)).toBeUndefined();
  await f.cache.put(sha, bytes);
  expect(await createBlobCache(f.root, f.id, 1, LIMITS.maxSnapshotBytes, f.signal.signal, f.canWrite).get(sha, bytes.length)).toEqual(bytes);
  expect(await createBlobCache(f.root, randomUUID(), 1, LIMITS.maxSnapshotBytes, f.signal.signal, f.canWrite).get(sha, bytes.length)).toBeUndefined();
  expect(await createBlobCache(f.root, f.id, 2, LIMITS.maxSnapshotBytes, f.signal.signal, f.canWrite).get(sha, bytes.length)).toBeUndefined();
  expect(await trimBlobCache(f.root, f.id, 2, LIMITS.maxSnapshotBytes)).toBe(0);
  expect(await readdir(f.directory)).toEqual([]);
});

it('rejects wrong-sized and corrupted bytes, then repairs the cache', async () => {
  const f = await setup();
  const bytes = Buffer.from('verified');
  const sha = blobSha(bytes);
  await f.cache.put(sha, bytes);
  expect(await f.cache.get(sha, bytes.length + 1)).toBeUndefined();
  await writeFile(join(f.directory, `1-${sha}`), 'corrupt!');
  expect(await f.cache.get(sha, bytes.length)).toBeUndefined();
  await f.cache.put(sha, bytes);
  expect(await f.cache.get(sha, bytes.length)).toEqual(bytes);
  await expect(f.cache.put('a'.repeat(40), bytes)).rejects.toThrow('generation_invalid_path');
});

it('serializes concurrent writes and evicts oldest entries within the byte budget', async () => {
  const f = await setup(8);
  const a = Buffer.from('aaaa'); const b = Buffer.from('bbbb'); const c = Buffer.from('cccc');
  await Promise.all([f.cache.put(blobSha(a), a), f.cache.put(blobSha(b), b)]);
  await utimes(join(f.directory, `1-${blobSha(a)}`), new Date(0), new Date(0));
  await f.cache.put(blobSha(c), c);
  expect(await f.cache.get(blobSha(a), a.length)).toBeUndefined();
  expect(await trimBlobCache(f.root, f.id, 1, 8)).toBe(8);
  expect(await trimBlobCache(f.root, f.id, 1, 0)).toBe(0);
  expect(await readdir(f.directory)).toEqual([]);
});

it('enforces the file-count bound, including zero-byte blobs', async () => {
  const f = await setup();
  await mkdir(f.directory, { recursive: true });
  await Promise.all(Array.from({ length: LIMITS.maxFiles }, (_, i) => writeFile(join(f.directory, `1-${i.toString(16).padStart(40, '0')}`), '')));
  const bytes = Buffer.from('new');
  await f.cache.put(blobSha(bytes), bytes);
  expect((await readdir(f.directory)).length).toBe(LIMITS.maxFiles);
  expect(await f.cache.get(blobSha(bytes), bytes.length)).toEqual(bytes);
});

it('fails safely when cache storage is not a directory', async () => {
  const f = await setup();
  const fileRoot = join(f.root, 'not-a-directory');
  await writeFile(fileRoot, 'synthetic');
  const bytes = Buffer.from('blob');
  const cache = createBlobCache(fileRoot, f.id, 1, 50, f.signal.signal, f.canWrite);
  await cache.put(blobSha(bytes), bytes);
  expect(await cache.get(blobSha(bytes), bytes.length)).toBeUndefined();
  await expect(trimBlobCache(fileRoot, f.id, 1, 50)).resolves.toBe(0);
});

it('rejects cache directories that exceed the bounded entry scan', async () => {
  const f = await setup();
  await mkdir(f.directory, { recursive: true });
  for (let i = 0; i < LIMITS.maxFiles * 2 + 3; i++) await writeFile(join(f.directory, `tmp-${randomUUID()}`), '');
  await expect(trimBlobCache(f.root, f.id, 1, LIMITS.maxSnapshotBytes)).rejects.toThrow('generation_invalid_path');
});

it('rejects a directory substituted for the cache lock', async () => {
  const f = await setup();
  await mkdir(join(f.directory, 'lock'), { recursive: true });
  await expect(trimBlobCache(f.root, f.id, 1, 50)).rejects.toThrow('generation_invalid_path');
});

it('cleans abandoned temporary files and expired locks, but leaves active writers alone', async () => {
  const f = await setup();
  await mkdir(f.directory, { recursive: true });
  const temp = `tmp-${randomUUID()}`;
  await writeFile(join(f.directory, temp), 'partial');
  await writeFile(join(f.directory, 'lock'), '');
  expect(await trimBlobCache(f.root, f.id, 1, 0)).toBe(7);
  const bytes = Buffer.from('blob');
  await f.cache.put(blobSha(bytes), bytes);
  expect(await f.cache.get(blobSha(bytes), bytes.length)).toBeUndefined();
  await utimes(join(f.directory, 'lock'), new Date(0), new Date(0));
  expect(await trimBlobCache(f.root, f.id, 1, 0)).toBe(0);
  expect(await readdir(f.directory)).toEqual([]);
});

it('does not write after lease loss, and removes a staged cache write if the lease expires', async () => {
  const f = await setup();
  const bytes = Buffer.from('blob');
  f.canWrite.mockResolvedValueOnce(false);
  await f.cache.put(blobSha(bytes), bytes);
  expect(await f.cache.get(blobSha(bytes), bytes.length)).toBeUndefined();
  f.canWrite.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await f.cache.put(blobSha(bytes), bytes);
  expect(await readdir(f.directory)).toEqual([]);
});

it('honors cancellation before reading/writing/trimming and cleans an interrupted write', async () => {
  const f = await setup();
  const bytes = Buffer.from('blob');
  f.canWrite.mockImplementationOnce(async () => true).mockImplementationOnce(async () => { f.signal.abort(); return true; });
  await expect(f.cache.put(blobSha(bytes), bytes)).rejects.toThrow();
  expect(await readdir(f.directory)).toEqual([]);
  await expect(f.cache.get(blobSha(bytes), bytes.length)).rejects.toThrow();
  await expect(f.cache.put(blobSha(bytes), bytes)).rejects.toThrow();
  await expect(trimBlobCache(f.root, f.id, 1, 0, f.signal.signal)).rejects.toThrow();
});

it('skips oversized blobs and disabled caches without creating storage', async () => {
  const f = await setup(0);
  const bytes = Buffer.from('blob');
  await f.cache.put(blobSha(bytes), bytes);
  expect(await trimBlobCache(f.root, f.id, 1, 0)).toBe(0);
  await createBlobCache(f.root, f.id, 1, 1, f.signal.signal, f.canWrite).put(blobSha(bytes), bytes);
  expect(await f.cache.get(blobSha(bytes), bytes.length)).toBeUndefined();
});

it('fails closed for invalid keys, unsafe cache entries and directory links', async () => {
  const f = await setup();
  await expect(f.cache.get('../escape', 1)).rejects.toThrow('generation_invalid_path');
  await expect(f.cache.get('a'.repeat(40), -1)).rejects.toThrow('generation_invalid_path');
  await mkdir(f.directory, { recursive: true });
  await mkdir(join(f.directory, `1-${'a'.repeat(40)}`));
  await expect(f.cache.get('a'.repeat(40), 1)).rejects.toThrow('generation_invalid_path');
  await expect(trimBlobCache(f.root, f.id, 1, 50)).rejects.toThrow('generation_invalid_path');
  await rm(f.directory, { recursive: true });
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, f.directory, 'junction');
  await expect(f.cache.get('a'.repeat(40), 1)).rejects.toThrow('generation_invalid_path');
  await expect(f.cache.put(blobSha(Buffer.from('x')), Buffer.from('x'))).rejects.toThrow('generation_invalid_path');
  expect(await readdir(outside)).toEqual([]);
});

it('rejects unexpected entries and refuses public content storage', async () => {
  const f = await setup();
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, 'unexpected'), '');
  await expect(trimBlobCache(f.root, f.id, 1, 50)).rejects.toThrow('generation_invalid_path');
  const publicCache = createBlobCache(join(process.cwd(), 'public'), f.id, 1, 50, f.signal.signal, f.canWrite);
  await expect(publicCache.get('a'.repeat(40), 1)).rejects.toThrow('generation_invalid_path');
  await expect(trimBlobCache(join(process.cwd(), 'public'), f.id, 1, 50)).rejects.toThrow('generation_invalid_path');
  expect(await readFile(join(f.directory, 'unexpected'), 'utf8')).toBe('');
});

it('removes disposable catalog cache on deletion and fails closed for unavailable or unsafe storage', async () => {
  const f = await setup();
  const bytes = Buffer.from('blob');
  await f.cache.put(blobSha(bytes), bytes);
  await deleteCatalogSnapshot(f.root, f.id);
  expect(await f.cache.get(blobSha(bytes), bytes.length)).toBeUndefined();
  await deleteCatalogSnapshot(f.root, f.id);
  await expect(deleteCatalogSnapshot(join(f.root, 'missing'), f.id)).rejects.toThrow('generation_storage_unavailable');
  await writeFile(join(f.root, f.id), 'preserved unsafe file');
  await expect(deleteCatalogSnapshot(f.root, f.id)).rejects.toThrow('generation_storage_unavailable');
  expect(await readFile(join(f.root, f.id), 'utf8')).toBe('preserved unsafe file');
});

it('rejects missing/public storage and a replaced catalog directory before staging a snapshot', async () => {
  const f = await setup();
  const owner = randomUUID();
  const input = { catalogId: f.id, configRevision: 1, owner, fence: 1, jobId: `manual:${f.id}:${randomUUID()}`,
    commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), files: [{ path: 'index.md', mode: '100644', content: Buffer.from('# Safe') }] };
  await expect(stageGeneration(join(f.root, 'missing'), input)).rejects.toThrow('generation_storage_unavailable');
  await expect(stageGeneration(join(process.cwd(), 'public'), input)).rejects.toThrow('generation_invalid_path');
  await writeFile(join(f.root, f.id), 'unsafe catalog directory');
  await expect(stageGeneration(f.root, input)).rejects.toThrow('generation_invalid_path');
  expect(await readFile(join(f.root, f.id), 'utf8')).toBe('unsafe catalog directory');
});
