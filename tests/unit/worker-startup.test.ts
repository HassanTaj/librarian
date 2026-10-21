import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startConfiguredWorker, stopConfiguredWorker } from '../../lib/sync/worker-startup';

const state = vi.hoisted(() => ({
  loadConfig: vi.fn(), getMongo: vi.fn(), shouldStartSyncWorker: vi.fn(), markSyncWorkerUnavailable: vi.fn(),
  startSyncWorker: vi.fn(), stop: vi.fn(), reconcileInitialAdoption: vi.fn(), reconcileInstanceActivation: vi.fn(), readInstanceHost: vi.fn(), readInstance: vi.fn(),
}));

vi.mock('../../lib/config', () => ({ loadConfig: state.loadConfig }));
vi.mock('../../lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('../../lib/sync/worker-policy', () => ({ shouldStartSyncWorker: state.shouldStartSyncWorker }));
vi.mock('../../lib/sync/worker', () => ({
  markSyncWorkerUnavailable: state.markSyncWorkerUnavailable,
  startSyncWorker: state.startSyncWorker,
}));
vi.mock('../../lib/instance/activation', () => ({ reconcileInitialAdoption: state.reconcileInitialAdoption, reconcileInstanceActivation: state.reconcileInstanceActivation }));
vi.mock('../../lib/instance/bootstrap', () => ({ readInstanceHost: state.readInstanceHost }));
vi.mock('../../lib/instance/store', () => ({ readInstance: state.readInstance }));

beforeEach(() => {
  vi.clearAllMocks();
  state.shouldStartSyncWorker.mockReturnValue(true);
  state.loadConfig.mockResolvedValue({ githubAppId: 'synthetic', githubPrivateKey: 'synthetic-key', contentRoot: '/private', publicCatalogApprovalsFile: '/approval' });
  state.getMongo.mockResolvedValue({ db: {} });
  state.stop.mockResolvedValue(undefined);
  state.startSyncWorker.mockReturnValue({ stop: state.stop });
});

afterEach(async () => { await stopConfiguredWorker(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('ignores an absent runtime and avoids an unhealthy worker signal when disabled adoption fails', async () => {
  vi.stubEnv('NEXT_RUNTIME', undefined); await startConfiguredWorker(); expect(state.loadConfig).not.toHaveBeenCalled();
  state.shouldStartSyncWorker.mockReturnValue(false); state.reconcileInitialAdoption.mockRejectedValueOnce(new Error('synthetic adoption failure'));
  await startConfiguredWorker('nodejs'); expect(state.markSyncWorkerUnavailable).not.toHaveBeenCalled();
});

it('preserves an unfenced legacy worker during enrollment and binds it after initialization', async () => {
  vi.stubEnv('INSTANCE_ID', 'synthetic-instance');
  state.readInstanceHost.mockResolvedValue({ instanceId: 'synthetic-instance', marker: { phase: 'initialized' } });
  state.readInstance.mockResolvedValue({ migration: {}, initializedAt: null });
  await startConfiguredWorker('nodejs'); expect(state.startSyncWorker).toHaveBeenCalledWith(expect.objectContaining({ instance: undefined }));
  await stopConfiguredWorker();
  state.readInstance.mockResolvedValue({ migration: {}, initializedAt: new Date(), lifecycle: 'ready', gate: { state: 'open' }, active: { version: 2 }, securityEpoch: 1, recoveryEpoch: 1 });
  await startConfiguredWorker('nodejs'); expect(state.startSyncWorker).toHaveBeenLastCalledWith(expect.objectContaining({ instance: { instanceId: 'synthetic-instance', activeVersion: 2, securityEpoch: 1, recoveryEpoch: 1 } }));
});

it('skips startup when the process is not a configured worker', async () => {
  state.shouldStartSyncWorker.mockReturnValue(false);
  await startConfiguredWorker('nodejs');
  expect(state.loadConfig).not.toHaveBeenCalled();
  expect(state.startSyncWorker).not.toHaveBeenCalled();
});

it('uses the Node runtime context passed by Next when its startup process env is unset', async () => {
  const previous = process.env.NEXT_RUNTIME;
  delete process.env.NEXT_RUNTIME;
  state.shouldStartSyncWorker.mockImplementation((env: NodeJS.ProcessEnv) => env.NEXT_RUNTIME === 'nodejs');
  try {
    await startConfiguredWorker('nodejs');
    expect(state.shouldStartSyncWorker).toHaveBeenCalledWith(expect.objectContaining({ NEXT_RUNTIME: 'nodejs' }));
    expect(state.startSyncWorker).toHaveBeenCalledOnce();
  } finally {
    if (previous === undefined) delete process.env.NEXT_RUNTIME; else process.env.NEXT_RUNTIME = previous;
  }
});

it('marks the worker unavailable when configuration, storage, or startup fails', async () => {
  state.loadConfig.mockRejectedValueOnce(new Error('synthetic config error'));
  await startConfiguredWorker('nodejs');
  expect(state.markSyncWorkerUnavailable).toHaveBeenCalledOnce();

  state.getMongo.mockRejectedValueOnce(new Error('synthetic storage error'));
  await startConfiguredWorker('nodejs');
  expect(state.markSyncWorkerUnavailable).toHaveBeenCalledTimes(2);

  state.startSyncWorker.mockImplementationOnce(() => { throw new Error('synthetic startup error'); });
  await startConfiguredWorker('nodejs');
  expect(state.markSyncWorkerUnavailable).toHaveBeenCalledTimes(3);
});

it('starts at most once, installs one shutdown handler per signal, and stops idempotently', async () => {
  const once = vi.spyOn(process, 'once').mockImplementation((() => process) as typeof process.once);
  const remove = vi.spyOn(process, 'removeListener').mockImplementation((() => process) as typeof process.removeListener);
  await startConfiguredWorker('nodejs');
  await startConfiguredWorker('nodejs');
  expect(state.startSyncWorker).toHaveBeenCalledOnce();
  const handlers = once.mock.calls.map(([, handler]) => handler as () => void);
  expect(handlers).toHaveLength(2);
  await stopConfiguredWorker();
  await stopConfiguredWorker();
  expect(state.stop).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledTimes(2);
});

it('waits for the configured worker to stop before re-signaling an exited process', async () => {
  vi.spyOn(process, 'once').mockImplementation((() => process) as typeof process.once);
  vi.spyOn(process, 'removeListener').mockImplementation((() => process) as typeof process.removeListener);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('synthetic already-exited process'); });
  await startConfiguredWorker('nodejs');
  const handler = vi.mocked(process.once).mock.calls[0]?.[1] as (() => void) | undefined;
  expect(handler).toBeDefined();
  handler!();
  await vi.waitFor(() => expect(state.stop).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(process.kill).toHaveBeenCalled());
});

it('binds an instance worker to the initialized active version and fails closed during maintenance', async () => {
  const previous = { state: process.env.INSTANCE_STATE_FILE, id: process.env.INSTANCE_ID };
  try {
    process.env.INSTANCE_STATE_FILE = 'synthetic-protected-marker';
    delete process.env.INSTANCE_ID;
    const instanceId = '2a1e2ca3-4b03-4a31-9b5f-d9217e63e407';
    state.readInstanceHost.mockResolvedValue({ instanceId, marker: { phase: 'initialized' } });
    state.readInstance.mockResolvedValue({ lifecycle: 'ready', gate: { state: 'open' }, active: { version: 3 }, securityEpoch: 2, recoveryEpoch: 4 });
    await startConfiguredWorker('nodejs');
    expect(state.startSyncWorker).toHaveBeenCalledWith(expect.objectContaining({ instance: {
      instanceId, activeVersion: 3, securityEpoch: 2, recoveryEpoch: 4,
    } }));

    await stopConfiguredWorker();
    state.readInstance.mockResolvedValueOnce({ lifecycle: 'maintenance', gate: { state: 'maintenance' }, active: { version: 3 } });
    await startConfiguredWorker('nodejs');
    expect(state.markSyncWorkerUnavailable).toHaveBeenCalledOnce();
  } finally {
    if (previous.state === undefined) delete process.env.INSTANCE_STATE_FILE; else process.env.INSTANCE_STATE_FILE = previous.state;
    if (previous.id === undefined) delete process.env.INSTANCE_ID; else process.env.INSTANCE_ID = previous.id;
  }
});
