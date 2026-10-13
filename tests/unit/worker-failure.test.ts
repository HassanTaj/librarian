import { beforeEach, expect, it, vi } from 'vitest';
import { LIMITS } from '../../lib/limits';
import { processNextSyncJob, startSyncWorker } from '../../lib/sync/worker';
import type { Db } from 'mongodb';

const state = vi.hoisted(() => ({
  claimNextSyncJob: vi.fn(), reconcilePublishedSyncJobs: vi.fn(), completeSyncJob: vi.fn(), failSyncJob: vi.fn(),
  heartbeatSyncJob: vi.fn(), setSyncTargetCommit: vi.fn(), prepareGenerationRoom: vi.fn(), publishGeneration: vi.fn(),
  stageGeneration: vi.fn(), requirePublicApproval: vi.fn(), createGitHubClient: vi.fn(), createBlobCache: vi.fn(), trimBlobCache: vi.fn(),
  GitHubError: class extends Error {
    code: string;
    retryAfterMs?: number;
    constructor(code: string, retryAfterMs?: number) { super(code); this.code = code; this.retryAfterMs = retryAfterMs; }
  },
}));

vi.mock('../../lib/sync/jobs', () => ({
  claimNextSyncJob: state.claimNextSyncJob,
  reconcilePublishedSyncJobs: state.reconcilePublishedSyncJobs,
  completeSyncJob: state.completeSyncJob,
  failSyncJob: state.failSyncJob,
  heartbeatSyncJob: state.heartbeatSyncJob,
  setSyncTargetCommit: state.setSyncTargetCommit,
}));
vi.mock('../../lib/content/generations', () => ({
  prepareGenerationRoom: state.prepareGenerationRoom,
  publishGeneration: state.publishGeneration,
  stageGeneration: state.stageGeneration,
}));
vi.mock('../../lib/public-approvals', () => ({ requirePublicApproval: state.requirePublicApproval }));
vi.mock('../../lib/content/blob-cache', () => ({ createBlobCache: state.createBlobCache, trimBlobCache: state.trimBlobCache }));
vi.mock('../../lib/sync/github', () => ({ GitHubError: state.GitHubError, createGitHubClient: state.createGitHubClient }));

const job = { _id: 'manual:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002' };
const claim = { job, catalogId: '00000000-0000-4000-8000-000000000001', configRevision: 1,
  owner: '00000000-0000-4000-8000-000000000003', fence: 1, publicationRevision: 0,
  catalog: { visibility: 'private', approvalRef: null, published: null } };
const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  state.claimNextSyncJob.mockResolvedValue(claim);
  state.reconcilePublishedSyncJobs.mockResolvedValue(0);
  state.heartbeatSyncJob.mockResolvedValue(true);
  state.setSyncTargetCommit.mockResolvedValue(undefined);
  state.prepareGenerationRoom.mockResolvedValue(0);
  state.stageGeneration.mockResolvedValue({ manifest: { generationId: '00000000-0000-4000-8000-000000000004' } });
  state.publishGeneration.mockResolvedValue(undefined);
  state.completeSyncJob.mockResolvedValue(undefined);
  state.failSyncJob.mockResolvedValue('retry_wait');
  state.trimBlobCache.mockResolvedValue(0);
});

it('wires the default provider cache to the current catalog lease and leaves injected providers compatible', async () => {
  const cache = { get: vi.fn(), put: vi.fn() };
  const candidate = { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), files: [] };
  const provider = vi.fn(async () => candidate);
  state.createGitHubClient.mockReturnValueOnce({ readCandidate: provider });
  state.createBlobCache.mockReturnValueOnce(cache);
  const findOne = vi.fn().mockResolvedValueOnce({ _id: claim.catalogId }).mockResolvedValueOnce(null);
  const runtimeDb = { collection: () => ({ findOne }) } as unknown as Db;
  expect(await processNextSyncJob({ db: runtimeDb, contentRoot: '/synthetic',
    github: { githubAppId: 'synthetic', githubPrivateKey: 'synthetic' } })).toBe('succeeded');
  expect(provider).toHaveBeenCalledWith(claim.catalog, expect.any(AbortSignal), cache);
  const canWrite = state.createBlobCache.mock.calls[0][5] as () => Promise<boolean>;
  expect(await canWrite()).toBe(true);
  expect(await canWrite()).toBe(false);
  expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ _id: claim.catalogId,
    configRevision: claim.configRevision, leaseFence: claim.fence, 'lease.owner': claim.owner }), { projection: { _id: 1 } });
  const injected = vi.fn(async () => candidate);
  expect(await processNextSyncJob({ db, contentRoot: '/synthetic', readCandidate: injected })).toBe('succeeded');
  expect(injected).toHaveBeenCalledWith(claim.catalog, expect.any(AbortSignal));
});

it('requires a provider before reconciling or claiming work and reports an empty queue as idle', async () => {
  expect(() => startSyncWorker({ db, contentRoot: '/synthetic' })).toThrow('sync_provider_unavailable');
  await expect(processNextSyncJob({ db, contentRoot: '/synthetic' })).rejects.toThrow('sync_provider_unavailable');
  expect(state.reconcilePublishedSyncJobs).not.toHaveBeenCalled();
  state.claimNextSyncJob.mockResolvedValueOnce(null);
  await expect(processNextSyncJob({ db, contentRoot: '/synthetic', readCandidate: vi.fn() })).resolves.toBe('idle');
});

it.each([false, true])('keeps a slow candidate fenced while heartbeat requests are pending=%s', async pending => {
  vi.useFakeTimers();
  const controller = new AbortController();
  try {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    state.heartbeatSyncJob.mockImplementation(() => pending ? new Promise<boolean>(() => {}) : Promise.resolve(true));
    const work = processNextSyncJob({ db, contentRoot: '/synthetic', signal: controller.signal,
      readCandidate: (_catalog, signal) => new Promise((_resolve, reject) => {
        entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }) });
    await started;
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeatMs * 2);
    expect(state.heartbeatSyncJob).toHaveBeenCalledTimes(pending ? 1 : 2);
    controller.abort();
    expect(await work).toBe('retry_wait');
  } finally { vi.useRealTimers(); }
});

it('refreshes the worker-status heartbeat and clears the timer on shutdown', async () => {
  vi.useFakeTimers();
  state.claimNextSyncJob.mockResolvedValue(null);
  try {
    const worker = startSyncWorker({ db, contentRoot: '/synthetic', readCandidate: vi.fn() });
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeatMs + 1);
    await worker.stop();
    expect(worker.finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('fails a pre-aborted job as a safe worker shutdown and returns durable completion outcomes', async () => {
  const controller = new AbortController();
  controller.abort();
  const readCandidate = vi.fn();
  await expect(processNextSyncJob({ db, contentRoot: '/synthetic', readCandidate, signal: controller.signal })).resolves.toBe('retry_wait');
  expect(readCandidate).not.toHaveBeenCalled();
  expect(state.failSyncJob).toHaveBeenCalledWith(db, claim, { code: 'worker_shutdown', permanent: false, retryAfterMs: 0 });

  state.failSyncJob.mockResolvedValueOnce('succeeded');
  await expect(processNextSyncJob({ db, contentRoot: '/synthetic', readCandidate: async () => { throw 'provider failure'; } })).resolves.toBe('succeeded');
  state.failSyncJob.mockResolvedValueOnce('lease_lost');
  await expect(processNextSyncJob({ db, contentRoot: '/synthetic', readCandidate: async () => { throw 'provider failure'; } })).resolves.toBe('lease_lost');
});

it('cancels a candidate read after a lost heartbeat and never tries to fail the stale lease', async () => {
  vi.useFakeTimers();
  try {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const work = processNextSyncJob({ db, contentRoot: '/synthetic', readCandidate: (_catalog, signal) => new Promise((_resolve, reject) => {
      entered();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    await started;
    state.heartbeatSyncJob.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeatMs);
    await expect(work).resolves.toBe('lease_lost');
    expect(state.failSyncJob).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('marks a worker unhealthy after an iteration error and stops the bounded idle wait promptly', async () => {
  state.reconcilePublishedSyncJobs.mockRejectedValueOnce(new Error('synthetic storage error'));
  const worker = startSyncWorker({ db: { collection: () => { throw new Error('synthetic storage error'); } } as never,
    contentRoot: '/synthetic', readCandidate: vi.fn() });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(worker.healthy).toBe(false);
  expect(worker.active).toBe(false);
  await worker.stop();
  expect(worker.finished).toBe(true);
  expect(state.reconcilePublishedSyncJobs).toHaveBeenCalled();
});

