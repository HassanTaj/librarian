import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { writeFile, mkdir, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorageHarness } from './http-harness';
import { openSafeFile } from '../../lib/content/paths';

vi.mock('node:fs/promises', { spy: true });

it('opens only a regular contained file and rejects filesystem symlinks and directory reads', async () => {
  const storage = await createStorageHarness();
  try {
    await writeFile(join(storage.contentRoot, 'guide.md'), '# Synthetic');
    const handle = await openSafeFile(storage.contentRoot, 'guide.md');
    try { expect(await handle.readFile('utf8')).toBe('# Synthetic'); } finally { await handle.close(); }
    await mkdir(join(storage.root, 'outside'));
    await writeFile(join(storage.root, 'outside/private.md'), 'SYNTHETIC_OUTSIDE');
    await symlink(join(storage.root, 'outside'), join(storage.contentRoot, 'escape'), 'junction');
    await expect(openSafeFile(storage.contentRoot, 'escape/private.md')).rejects.toThrow();
    await expect(openSafeFile(storage.contentRoot, '../outside/private.md')).rejects.toThrow();
    await expect(openSafeFile(storage.contentRoot, '.')).rejects.toThrow();
    await expect(openSafeFile(storage.contentRoot, 'escape')).rejects.toThrow();
    await expect(openSafeFile(storage.contentRoot, 'missing.md')).rejects.toThrow();
    await expect(openSafeFile(storage.contentRoot, 'guide.md/child')).rejects.toThrow();
  } finally { await storage.close(); }
});

it('closes the opened handle if an ancestor is swapped between stat and the no-follow open', async () => {
  const storage = await createStorageHarness();
  const originalOpen = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  let closed = false;
  try {
    await mkdir(join(storage.contentRoot, 'nested'));
    await writeFile(join(storage.contentRoot, 'nested/guide.md'), 'Synthetic contained');
    await mkdir(join(storage.root, 'outside'));
    await writeFile(join(storage.root, 'outside/guide.md'), 'SYNTHETIC_OUTSIDE');
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await rename(join(storage.contentRoot, 'nested'), join(storage.contentRoot, 'saved'));
      await symlink(join(storage.root, 'outside'), join(storage.contentRoot, 'nested'), 'junction');
      const handle = await originalOpen(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => { closed = true; await close(); };
      return handle;
    });
    await expect(openSafeFile(storage.contentRoot, 'nested/guide.md')).rejects.toThrow('invalid_path');
    expect(closed).toBe(true);
  } finally { vi.restoreAllMocks(); await storage.close(); }
});
