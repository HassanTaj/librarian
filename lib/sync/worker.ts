import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Catalog } from '../catalog';
import { LIMITS } from '../limits';
import { requirePublicApproval } from '../public-approvals';
import { prepareGenerationRoom, publishGeneration, stageGeneration } from '../content/generations';
import { GitHubError, createGitHubClient } from './github';
import { claimNextSyncJob, completeSyncJob, failSyncJob, heartbeatSyncJob, reconcilePublishedSyncJobs, setSyncTargetCommit } from './jobs';

type Candidate = Awaited<ReturnType<ReturnType<typeof createGitHubClient>['readCandidate']>>;
type WorkerOptions = {
  db: Db;
  contentRoot: string;
  owner?: string;
  signal?: AbortSignal;
  readCandidate?: (catalog: Catalog, signal: AbortSignal) => Promise<Candidate>;
  github?: { githubAppId: string; githubPrivateKey: string; fetcher?: typeof fetch };
  publicCatalogApprovalsFile?: string;
};

export type SyncWorkResult = 'idle' | 'succeeded' | 'retry_wait' | 'failed' | 'lease_lost';
type WorkerStatus = { enabled: boolean; healthy: boolean; active: boolean };
type WorkerStatusRecord = WorkerStatus & { _id: string; updatedAt: Date };
let currentStatus: WorkerStatus = { enabled: false, healthy: false, active: false };

export function getSyncWorkerStatus() { return currentStatus; }
export function markSyncWorkerUnavailable() { currentStatus = { enabled: true, healthy: false, active: false }; }

export async function hasHealthySyncWorker(db: Db) {
  const updatedAfter = new Date(Date.now() - LIMITS.heartbeatMs * 3);
  return Boolean(await db.collection<WorkerStatusRecord>('syncWorkerStatus').findOne({
    enabled: true, healthy: true, updatedAt: { $gt: updatedAfter },
  }, { projection: { _id: 1 } }));
}

function failure(error: unknown, timeout: boolean, stopped: boolean) {
  const code = error instanceof GitHubError ? error.code : error instanceof Error ? error.message : '';
  const permanent = ['github_invalid_content', 'github_tree_invalid', 'github_unsafe_path', 'github_unsafe_entry',
    'github_content_limit', 'github_no_pages', 'github_blob_mismatch', 'github_docs_missing', 'github_invalid_catalog',
    'github_retry_after_too_long', 'invalid_content', 'public_approval_required'].includes(code);
  const safeCode = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'sync_failed';
  return { code: stopped ? 'worker_shutdown' : timeout ? 'github_timeout' : safeCode, permanent };
}

export async function processNextSyncJob(options: WorkerOptions): Promise<SyncWorkResult> {
  const owner = options.owner ?? randomUUID();
  const client = options.github && createGitHubClient({ githubAppId: options.github.githubAppId,
    githubPrivateKey: options.github.githubPrivateKey }, options.github.fetcher);
  const readCandidate = options.readCandidate ?? client?.readCandidate.bind(client);
  if (!readCandidate) throw new Error('sync_provider_unavailable');

  await reconcilePublishedSyncJobs(options.db);
  const claim = await claimNextSyncJob(options.db, owner);
  if (!claim) return 'idle';

  const leaseLoss = new AbortController();
  const stopped = new AbortController();
  const timeout = AbortSignal.timeout(LIMITS.attemptTimeoutMs);
  const shutdown = () => stopped.abort();
  if (options.signal?.aborted) shutdown();
  else options.signal?.addEventListener('abort', shutdown, { once: true });
  let lostLease = false;
  let heartbeatRunning = false;
  const heartbeat = setInterval(() => {
    if (heartbeatRunning || leaseLoss.signal.aborted) return;
    heartbeatRunning = true;
    void heartbeatSyncJob(options.db, claim).then(alive => {
      if (!alive) { lostLease = true; leaseLoss.abort(); }
    }).catch(() => { lostLease = true; leaseLoss.abort(); }).finally(() => { heartbeatRunning = false; });
  }, LIMITS.heartbeatMs);
  const signal = AbortSignal.any([leaseLoss.signal, stopped.signal, timeout]);
  try {
    signal.throwIfAborted();
    const candidate = await readCandidate(claim.catalog, signal);
    signal.throwIfAborted();
    if (claim.catalog.visibility === 'public') await requirePublicApproval({
      filePath: options.publicCatalogApprovalsFile, approvalRef: claim.catalog.approvalRef,
      scope: claim.catalog, candidate, currentPublishedCommit: claim.catalog.published?.commitSha,
    });
    await setSyncTargetCommit(options.db, claim, candidate.commitSha);
    const catalogBytesUsed = await prepareGenerationRoom(options.db, options.contentRoot, {
      catalogId: claim.catalogId, configRevision: claim.configRevision, owner: claim.owner, fence: claim.fence,
    });
    const staged = await stageGeneration(options.contentRoot, { catalogId: claim.catalogId,
      configRevision: claim.configRevision, owner: claim.owner, fence: claim.fence, jobId: claim.job._id,
      commitSha: candidate.commitSha, treeSha: candidate.treeSha, files: candidate.files }, catalogBytesUsed);
    signal.throwIfAborted();
    await publishGeneration(options.db, options.contentRoot, staged, { catalogId: claim.catalogId,
      configRevision: claim.configRevision, owner: claim.owner, fence: claim.fence, jobId: claim.job._id,
      publicationRevision: claim.publicationRevision });
    await completeSyncJob(options.db, claim, { generationId: staged.manifest.generationId, commitSha: candidate.commitSha });
    return 'succeeded';
  } catch (error) {
    if (lostLease) return 'lease_lost';
    const problem = failure(error, timeout.aborted, stopped.signal.aborted);
    const outcome = await failSyncJob(options.db, claim, {
      ...problem, retryAfterMs: error instanceof GitHubError ? error.retryAfterMs : stopped.signal.aborted ? 0 : undefined,
    });
    if (outcome === 'succeeded') return 'succeeded';
    if (outcome === 'lease_lost') return 'lease_lost';
    return outcome;
  } finally {
    clearInterval(heartbeat);
    options.signal?.removeEventListener('abort', shutdown);
  }
}

export function startSyncWorker(options: Omit<WorkerOptions, 'signal' | 'owner' | 'readCandidate'> & {
  readCandidate?: WorkerOptions['readCandidate'];
}) {
  const controller = new AbortController();
  let active = false;
  let healthy = true;
  let finished = false;
  const owner = randomUUID();
  async function writeStatus() {
    try {
      await options.db.collection<WorkerStatusRecord>('syncWorkerStatus').updateOne({ _id: owner }, { $set: {
        enabled: true, healthy, active, updatedAt: new Date(),
      } }, { upsert: true });
    } catch {
      healthy = false;
      currentStatus = { enabled: true, healthy, active };
    }
  }
  const client = options.github && createGitHubClient({ githubAppId: options.github.githubAppId,
    githubPrivateKey: options.github.githubPrivateKey }, options.github.fetcher);
  const readCandidate = options.readCandidate ?? client?.readCandidate.bind(client);
  if (!readCandidate) throw new Error('sync_provider_unavailable');

  async function pause(ms: number) {
    if (controller.signal.aborted) return;
    await new Promise<void>(resolve => {
      const abort = () => { clearTimeout(timer); done(); };
      const done = () => { controller.signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done, ms);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
  }
  const loop = (async () => {
    currentStatus = { enabled: true, healthy: true, active: false };
    await writeStatus();
    const statusHeartbeat = setInterval(() => { void writeStatus(); }, LIMITS.heartbeatMs);
    while (!controller.signal.aborted) {
      let result: SyncWorkResult;
      try {
        active = true;
        result = await processNextSyncJob({ ...options, owner, readCandidate, signal: controller.signal });
        healthy = true;
      } catch {
        healthy = false;
        result = 'idle';
      } finally {
        active = false;
        currentStatus = { enabled: true, healthy, active };
        await writeStatus();
      }
      await pause(result === 'idle' ? LIMITS.idlePollMs : LIMITS.activePollMs);
    }
    clearInterval(statusHeartbeat);
    finished = true;
    currentStatus = { enabled: true, healthy: false, active: false };
    try { await options.db.collection<WorkerStatusRecord>('syncWorkerStatus').deleteOne({ _id: owner }); } catch { /* TTL removes status after a crash or storage outage. */ }
  })();
  const stop = async () => {
    controller.abort();
    await loop;
  };
  return { stop, get active() { return active; }, get healthy() { return healthy; }, get finished() { return finished; } };
}
