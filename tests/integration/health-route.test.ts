import { vi, expect, it } from 'vitest';
import { startSyncWorker } from '../../lib/sync/worker';
import { GET } from '../../app/api/health/route';
import { createStorageHarness } from './http-harness';

const mocks = vi.hoisted(() => ({ getMongo: vi.fn(), readInstanceHost: vi.fn(), readInstance: vi.fn(), cleanupInstanceState: vi.fn(), drainInstanceAudit: vi.fn(), startConfiguredWorker: vi.fn() }));
vi.mock('../../lib/mongo', () => ({ getMongo: mocks.getMongo }));
vi.mock('../../lib/instance/bootstrap', () => ({ readInstanceHost: mocks.readInstanceHost }));
vi.mock('../../lib/instance/store', () => ({ attachInstanceKeyring: vi.fn(), readInstance: mocks.readInstance, cleanupInstanceState: mocks.cleanupInstanceState, drainInstanceAudit: mocks.drainInstanceAudit }));
vi.mock('../../lib/sync/worker-startup', () => ({ startConfiguredWorker: mocks.startConfiguredWorker }));

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

it('requires the initialized instance lifecycle and matching worker authority before health is ready', async () => {
  const storage = await createStorageHarness();
  const previous = { state: process.env.INSTANCE_STATE_FILE, id: process.env.INSTANCE_ID };
  const instanceId = '612bd28b-4b01-4d64-b8ee-4bf3a58bf1cb';
  const authority = { instanceId, activeVersion: 3, securityEpoch: 2, recoveryEpoch: 4 };
  try {
    process.env.INSTANCE_STATE_FILE = 'synthetic-protected-marker';
    delete process.env.INSTANCE_ID;
    mocks.getMongo.mockResolvedValue(storage);
    mocks.readInstanceHost.mockResolvedValue({ instanceId, marker: { phase: 'initialized' } });
    mocks.readInstance.mockResolvedValue({ lifecycle: 'ready', gate: { state: 'open' }, active: { version: 3 }, initializedAt: new Date(),
      bootstrap: { consumedAt: new Date() }, auditOutbox: [{ _id: 'pending-audit' }], securityEpoch: 2, recoveryEpoch: 4 });
    await storage.db.collection('syncWorkerStatus').insertOne({ enabled: true, healthy: true, active: false,
      updatedAt: new Date(), ...authority });
    const ready = await GET();
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok' });
    expect(mocks.cleanupInstanceState).toHaveBeenCalledWith(storage.db, instanceId);
    expect(mocks.drainInstanceAudit).toHaveBeenCalledWith(storage.db, instanceId);

    mocks.drainInstanceAudit.mockClear();
    mocks.readInstance.mockResolvedValueOnce({ lifecycle: 'ready', gate: { state: 'open' }, active: { version: 3 }, initializedAt: new Date(),
      bootstrap: { consumedAt: new Date() }, auditOutbox: [], securityEpoch: 2, recoveryEpoch: 4 });
    expect((await GET()).status).toBe(200);
    expect(mocks.drainInstanceAudit).not.toHaveBeenCalled();

    mocks.readInstance.mockResolvedValueOnce({ lifecycle: 'maintenance', gate: { state: 'maintenance' }, active: { version: 3 },
      initializedAt: new Date(), bootstrap: { consumedAt: new Date() }, securityEpoch: 2, recoveryEpoch: 4 });
    expect((await GET()).status).toBe(503);
    mocks.readInstanceHost.mockRejectedValueOnce(new Error('synthetic host failure'));
    expect((await GET()).status).toBe(503);
  } finally {
    if (previous.state === undefined) delete process.env.INSTANCE_STATE_FILE; else process.env.INSTANCE_STATE_FILE = previous.state;
    if (previous.id === undefined) delete process.env.INSTANCE_ID; else process.env.INSTANCE_ID = previous.id;
    await storage.close();
  }
});
