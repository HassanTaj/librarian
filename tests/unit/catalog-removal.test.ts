import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { deleteCatalogSnapshot } from '../../lib/content/generations';

let root: string;
let contentRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'librarian-removal-'));
  contentRoot = join(root, 'content');
  await mkdir(contentRoot);
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('removes only the selected catalog directory and allows an idempotent retry', async () => {
  const catalogId = randomUUID();
  await mkdir(join(contentRoot, catalogId, 'generations', randomUUID()), { recursive: true });
  await writeFile(join(contentRoot, 'other-catalog'), 'keep');

  await deleteCatalogSnapshot(contentRoot, catalogId);
  await deleteCatalogSnapshot(contentRoot, catalogId);

  expect(await readdir(contentRoot)).toEqual(['other-catalog']);
});

it('refuses to remove an unsafe non-directory catalog path', async () => {
  const catalogId = randomUUID();
  const path = join(contentRoot, catalogId);
  await writeFile(path, 'synthetic sentinel');

  await expect(deleteCatalogSnapshot(contentRoot, catalogId)).rejects.toThrow('generation_storage_unavailable');
  expect(await readFile(path, 'utf8')).toBe('synthetic sentinel');
});

it('rejects non-UUID content identities', async () => {
  await expect(deleteCatalogSnapshot(contentRoot, '../outside')).rejects.toThrow();
});
