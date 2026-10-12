import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorageHarness } from './http-harness';
import { validateCandidate } from '../../lib/content/validate';

it('invalid repository content cannot change an existing last-valid snapshot', async () => {
  const storage = await createStorageHarness();
  try {
    const path = join(storage.contentRoot, 'last-valid.md');
    await writeFile(path, '# Synthetic last valid');
    expect(() => validateCandidate([{ path: 'index.md', mode: '100644', content: Buffer.from('{globalThis.syntheticExecuted = true}') }])).toThrow();
    expect(await readFile(path, 'utf8')).toBe('# Synthetic last valid');
    expect(Reflect.get(globalThis, 'syntheticExecuted')).toBeUndefined();
  } finally { await storage.close(); }
});
