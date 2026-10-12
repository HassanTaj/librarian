import { vi, expect, it } from 'vitest';
import { startSyncWorker } from '../../lib/sync/worker';
import { GET } from '../../app/api/health/route';
import { createStorageHarness } from './http-harness';

const mocks = vi.hoisted(() => ({ getMongo: vi.fn() }));
vi.mock('../../lib/mongo', () => ({ getMongo: mocks.getMongo }));

it('reports only ready or not-ready using real Mongo/filesystem checks and worker state', async () => {
  const storage = await createStorageHarness();
  let worker: ReturnType<typeof startSyncWorker> | undefined;
  try {
    mocks.getMongo.mockResolvedValue(storage);
    worker = startSyncWorker({ db: storage.db, contentRoot: storage.contentRoot, readCandidate: async () => {
      throw new Error('No job expected');
    } });
    await new Promise(resolve => setTimeout(resolve, 100));
    const ready = await GET();
    expect(ready.status).toBe(200);
    expect(ready.headers.get('cache-control')).toBe('no-store');
    expect(await ready.json()).toEqual({ status: 'ok' });

    mocks.getMongo.mockResolvedValueOnce({ ...storage, contentRoot: '' });
    const missingContentRoot = await GET();
    expect(missingContentRoot.status).toBe(503);
    expect(await missingContentRoot.json()).toEqual({ status: 'not_ready' });

    await worker.stop();
    worker = undefined;
    const workerUnavailable = await GET();
    expect(workerUnavailable.status).toBe(503);
    expect(await workerUnavailable.json()).toEqual({ status: 'not_ready' });

    mocks.getMongo.mockRejectedValueOnce(new Error('private path, token, and provider details'));
    const storageUnavailable = await GET();
    expect(storageUnavailable.status).toBe(503);
    expect(await storageUnavailable.text()).not.toContain('private path');
  } finally {
    await worker?.stop();
    await storage.close();
  }
});
