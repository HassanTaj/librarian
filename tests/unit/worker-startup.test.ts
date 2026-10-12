import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startConfiguredWorker, stopConfiguredWorker } from '../../lib/sync/worker-startup';

const state = vi.hoisted(() => ({
  loadConfig: vi.fn(), getMongo: vi.fn(), shouldStartSyncWorker: vi.fn(), markSyncWorkerUnavailable: vi.fn(),
  startSyncWorker: vi.fn(), stop: vi.fn(),
}));

vi.mock('../../lib/config', () => ({ loadConfig: state.loadConfig }));
vi.mock('../../lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('../../lib/sync/worker-policy', () => ({ shouldStartSyncWorker: state.shouldStartSyncWorker }));
vi.mock('../../lib/sync/worker', () => ({
  markSyncWorkerUnavailable: state.markSyncWorkerUnavailable,
  startSyncWorker: state.startSyncWorker,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.shouldStartSyncWorker.mockReturnValue(true);
  state.loadConfig.mockResolvedValue({ githubAppId: 'synthetic', githubPrivateKey: 'synthetic-key', contentRoot: '/private', publicCatalogApprovalsFile: '/approval' });
  state.getMongo.mockResolvedValue({ db: {} });
  state.stop.mockResolvedValue(undefined);
  state.startSyncWorker.mockReturnValue({ stop: state.stop });
});

afterEach(async () => { await stopConfiguredWorker(); vi.restoreAllMocks(); });

it('skips startup when the process is not a configured worker', async () => {
  state.shouldStartSyncWorker.mockReturnValue(false);
  await startConfiguredWorker();
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
  await startConfiguredWorker();
  expect(state.markSyncWorkerUnavailable).toHaveBeenCalledOnce();

  state.getMongo.mockRejectedValueOnce(new Error('synthetic storage error'));
  await startConfiguredWorker();
  expect(state.markSyncWorkerUnavailable).toHaveBeenCalledTimes(2);

  state.startSyncWorker.mockImplementationOnce(() => { throw new Error('synthetic startup error'); });
  await startConfiguredWorker();
  expect(state.markSyncWorkerUnavailable).toHaveBeenCalledTimes(3);
});

it('starts at most once, installs one shutdown handler per signal, and stops idempotently', async () => {
  const once = vi.spyOn(process, 'once').mockImplementation((() => process) as typeof process.once);
  const remove = vi.spyOn(process, 'removeListener').mockImplementation((() => process) as typeof process.removeListener);
  await startConfiguredWorker();
  await startConfiguredWorker();
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
  await startConfiguredWorker();
  const handler = vi.mocked(process.once).mock.calls[0]?.[1] as (() => void) | undefined;
  expect(handler).toBeDefined();
  handler!();
  await vi.waitFor(() => expect(state.stop).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(process.kill).toHaveBeenCalled());
});
