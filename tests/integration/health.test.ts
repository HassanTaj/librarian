import { expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createStorageHarness } from './http-harness';
import { checkHealth } from '../../lib/operations/health';

it('checks real Mongo and filesystem health without revealing internal locations or provider errors', async () => {
  const storage = await createStorageHarness();
  try {
    expect(await checkHealth(storage.db, storage.contentRoot)).toEqual({ status: 'ok' });
    expect(await checkHealth(storage.db, join(storage.contentRoot, 'missing'))).toEqual({ status: 'unavailable' });
    const file = join(storage.contentRoot, 'file.txt');
    await writeFile(file, 'Synthetic');
    expect(await checkHealth(storage.db, file)).toEqual({ status: 'unavailable' });
    await storage.client.close();
    expect(await checkHealth(storage.db, storage.contentRoot)).toEqual({ status: 'unavailable' });
  } finally {
    // Reconnect only to dispose this harness's database after the closed-client case.
    await storage.client.connect();
    await storage.close();
  }
});
