import { z } from 'zod';
import { MongoServerError, type Collection, type Db, type IndexDescription } from 'mongodb';
import { LIMITS } from '../limits';
import { CatalogSchema, type Catalog } from '../catalog';

const uuid = z.uuid();
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const SyncJobIdSchema = z.string().max(140).refine(value =>
  /^github:[1-9]\d{0,19}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ||
  /^manual:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));

export const SyncJobSchema = z.object({
  _id: SyncJobIdSchema,
  catalogId: uuid,
  configRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  origin: z.enum(['github', 'manual']),
  event: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  payloadDigest: digest,
  admissionSequence: z.number().int().positive().max(100_000),
  state: z.enum(['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled']),
  requestedAt: z.date(),
  availableAt: z.date(),
  attempts: z.number().int().min(0).max(5),
  owner: uuid.nullable(),
  fence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  targetCommit: commit.nullable(),
  generationId: uuid.nullable(),
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('published'), commitSha: commit }).strict(),
    z.object({ kind: z.literal('failure'), code }).strict(),
  ]).nullable(),
  completedAt: z.date().nullable(),
  detailExpiresAt: z.date().nullable(),
}).strict().superRefine((job, context) => {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(job.state);
  const invalidRunning = job.state === 'running' && (job.owner === null || job.fence < 1 || job.attempts < 1);
  const invalidQueued = ['queued', 'retry_wait'].includes(job.state) && (job.owner !== null || job.result !== null);
  const invalidTerminal = terminal && (job.completedAt === null || job.owner !== null);
  const invalidSuccess = job.state === 'succeeded' &&
    (job.generationId === null || job.result?.kind !== 'published');
  const invalidFailure = job.state === 'failed' && job.result?.kind !== 'failure';
  if (invalidRunning || invalidQueued || invalidTerminal || invalidSuccess || invalidFailure ||
      (job.state !== 'succeeded' && job.result?.kind === 'published')) {
    context.addIssue({ code: 'custom', message: 'Invalid sync job state' });
  }
});

export type SyncJob = z.infer<typeof SyncJobSchema>;

export const ControlReceiptSchema = z.object({
  _id: SyncJobIdSchema,
  catalogId: uuid,
  installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  event: z.enum(['installation', 'installation_repositories', 'repository']),
  action: z.enum(['deleted', 'removed']),
  payloadDigest: digest,
  completedAt: z.date(),
}).strict().superRefine((receipt, context) => {
  if (!receipt._id.startsWith('github:') || !receipt._id.endsWith(`:${receipt.catalogId}`) ||
      (receipt.event === 'installation_repositories' ? receipt.action !== 'removed' : receipt.action !== 'deleted')) {
    context.addIssue({ code: 'custom', message: 'Invalid control receipt' });
  }
});
export type ControlReceipt = z.infer<typeof ControlReceiptSchema>;

export const SYNC_JOB_INDEXES: IndexDescription[] = [
  { key: { state: 1, availableAt: 1, requestedAt: 1 }, name: 'sync_schedule' },
  { key: { catalogId: 1, state: 1 }, name: 'sync_catalog_state' },
  { key: { state: 1, detailExpiresAt: 1 }, name: 'sync_terminal_compaction' },
];

export async function ensureSyncJobStorage(db: Db) {
  await db.collection<SyncJob>('syncJobs').createIndexes(SYNC_JOB_INDEXES);
  await db.collection<ControlReceipt>('controlReceipts').createIndex({ catalogId: 1, completedAt: 1 }, { name: 'control_catalog_time' });
  await db.collection('syncWorkerStatus').createIndex({ updatedAt: 1 }, { name: 'sync_worker_status_ttl', expireAfterSeconds: 60 });
}

export function newGitHubJobId(appId: string | number, deliveryId: string, catalogId: string) {
  const id = String(appId);
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error('sync_invalid_id');
  return SyncJobIdSchema.parse(`github:${id}:${uuid.parse(deliveryId).toLowerCase()}:${uuid.parse(catalogId).toLowerCase()}`);
}

export function newManualJobId(catalogId: string, idempotencyKey: string) {
  return SyncJobIdSchema.parse(`manual:${uuid.parse(catalogId).toLowerCase()}:${uuid.parse(idempotencyKey).toLowerCase()}`);
}

export async function admitControlReceipt(db: Db, inputValue: unknown) {
  const receipt = ControlReceiptSchema.parse(inputValue);
  const receipts = db.collection<ControlReceipt>('controlReceipts');
  const same = (value: unknown) => {
    let existing: ControlReceipt;
    try { existing = ControlReceiptSchema.parse(value); } catch { throw new Error('sync_storage_unavailable'); }
    if (['catalogId', 'installationId', 'repositoryId', 'event', 'action', 'payloadDigest']
      .some(key => existing[key as keyof ControlReceipt] !== receipt[key as keyof ControlReceipt])) throw new Error('sync_replay_conflict');
    return { receipt: existing, duplicate: true as const };
  };
  const existing = await receipts.findOne({ _id: receipt._id });
  if (existing) return same(existing);
  try {
    await receipts.insertOne(receipt, { writeConcern: { w: 1, j: true } });
    return { receipt, duplicate: false as const };
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const raced = await receipts.findOne({ _id: receipt._id });
      if (raced) return same(raced);
    }
    throw new Error('sync_storage_unavailable');
  }
}

const admissionInput = z.object({
  _id: SyncJobIdSchema,
  catalogId: uuid,
  origin: z.enum(['github', 'manual']),
  event: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  payloadDigest: digest,
}).strict().superRefine((input, context) => {
  const matches = input.origin === 'manual'
    ? input._id.startsWith(`manual:${input.catalogId}:`)
    : input._id.endsWith(`:${input.catalogId}`) && input._id.startsWith('github:');
  if (!matches || (input.origin === 'manual' && input.event !== 'manual')) {
    context.addIssue({ code: 'custom', message: 'Invalid sync admission identity' });
  }
});

function replayResult(existing: unknown, input: z.infer<typeof admissionInput>) {
  let job: SyncJob;
  try { job = SyncJobSchema.parse(existing); }
  catch { throw new Error('sync_storage_unavailable'); }
  if (job.catalogId !== input.catalogId || job.origin !== input.origin || job.event !== input.event ||
      job.payloadDigest !== input.payloadDigest) throw new Error('sync_replay_conflict');
  return { job, duplicate: true as const };
}

/** Reserve before inserting the permanent receipt; a failed insert may waste quota but is never acknowledged. */
export async function admitSyncJob(db: Db, inputValue: unknown, now = new Date()) {
  const input = admissionInput.parse(inputValue);
  const jobs = db.collection<SyncJob>('syncJobs');
  const existing = await jobs.findOne({ _id: input._id });
  if (existing) return replayResult(existing, input);

  const catalogs = db.collection<Catalog>('catalogs');
  let current: Catalog | null;
  try { current = CatalogSchema.parse(await catalogs.findOne({ _id: input.catalogId })); }
  catch { throw new Error('sync_catalog_unavailable'); }
  if (!current.enabled || current.accessState !== 'ready') throw new Error('sync_catalog_unavailable');
  const minute = new Date(Math.floor(now.getTime() / LIMITS.admissionWindowMs) * LIMITS.admissionWindowMs);
  const reserved = await catalogs.findOneAndUpdate({
    _id: input.catalogId, enabled: true, accessState: 'ready', configRevision: current.configRevision,
    admissionReservations: { $lt: LIMITS.maxAdmissionReservations },
    $or: [
      { 'rateWindow.window': { $ne: minute } },
      { 'rateWindow.window': minute, 'rateWindow.count': { $lt: LIMITS.admissionRate } },
    ],
  }, [{ $set: {
    admissionReservations: { $add: ['$admissionReservations', 1] },
    'rateWindow.window': minute,
    'rateWindow.count': { $cond: [{ $eq: ['$rateWindow.window', minute] }, { $add: ['$rateWindow.count', 1] }, 1] },
    updatedAt: { $max: [now, '$updatedAt'] },
  } }], { returnDocument: 'after', writeConcern: { w: 1, j: true } });
  if (!reserved) {
    const latest = await catalogs.findOne({ _id: input.catalogId });
    if (!latest || latest.enabled !== true || latest.accessState !== 'ready') throw new Error('sync_catalog_unavailable');
    if (latest.configRevision !== current.configRevision) throw new Error('sync_catalog_conflict');
    if (latest.admissionReservations >= LIMITS.maxAdmissionReservations) throw new Error('sync_quota_exhausted');
    if (latest.rateWindow.window.getTime() === minute.getTime() && latest.rateWindow.count >= LIMITS.admissionRate) {
      throw new Error('sync_rate_limited');
    }
    throw new Error('sync_admission_conflict');
  }

  const job = SyncJobSchema.parse({
    ...input, configRevision: current.configRevision, admissionSequence: reserved.admissionReservations,
    state: 'queued', requestedAt: now, availableAt: now, attempts: 0, owner: null, fence: 0,
    targetCommit: null, generationId: null, result: null, completedAt: null, detailExpiresAt: null,
  });
  try {
    await jobs.insertOne(job, { writeConcern: { w: 1, j: true } });
    return { job, duplicate: false as const };
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const raced = await jobs.findOne({ _id: input._id });
      if (raced) return replayResult(raced, input);
    }
    throw new Error('sync_storage_unavailable');
  }
}

const claimInput = z.object({ catalogId: uuid, configRevision: z.number().int().positive(), owner: uuid,
  fence: z.number().int().positive(), publicationRevision: z.number().int().nonnegative() }).passthrough();
const successInput = z.object({ generationId: uuid, commitSha: commit }).strict();
const failureInput = z.object({ code, permanent: z.boolean(), retryAfterMs: z.number().int().nonnegative().max(LIMITS.maxRetryAfterMs).optional() }).strict();

async function releaseCatalogLease(db: Db, claim: z.infer<typeof claimInput>) {
  return db.collection<Catalog>('catalogs').updateOne({ _id: claim.catalogId, leaseFence: claim.fence,
    'lease.owner': claim.owner, 'lease.fence': claim.fence }, [{ $set: { lease: null, updatedAt: { $max: ['$updatedAt', '$$NOW'] } } }],
  { writeConcern: { w: 1, j: true } });
}

async function cancelUnclaimedJob(jobs: Collection<SyncJob>, job: SyncJob) {
  await jobs.updateOne({ _id: job._id, state: job.state, owner: job.owner, fence: job.fence }, [{ $set: {
    state: 'cancelled', owner: null, completedAt: '$$NOW', detailExpiresAt: { $add: ['$$NOW', LIMITS.terminalDetailMs] },
  } }], { writeConcern: { w: 1, j: true } });
}

/** Claims at most one of the next 20 due jobs; the catalog lease is the only worker authority. */
export async function claimNextSyncJob(db: Db, ownerValue: string) {
  const owner = uuid.parse(ownerValue);
  const jobs = db.collection<SyncJob>('syncJobs');
  const catalogs = db.collection<Catalog>('catalogs');
  const candidates = await jobs.find({
    state: { $in: ['queued', 'retry_wait', 'running'] }, attempts: { $lte: LIMITS.maxAttempts },
    $expr: { $lte: ['$availableAt', '$$NOW'] },
  }).sort({ availableAt: 1, requestedAt: 1 }).limit(20).toArray();

  for (const value of candidates) {
    const candidate = SyncJobSchema.parse(value);
    let catalogValue: unknown | null;
    try { catalogValue = await catalogs.findOne({ _id: candidate.catalogId }); }
    catch { throw new Error('sync_storage_unavailable'); }
    if (!catalogValue) {
      await cancelUnclaimedJob(jobs, candidate);
      continue;
    }
    let current: Catalog;
    try { current = CatalogSchema.parse(catalogValue); }
    catch { throw new Error('sync_storage_unavailable'); }
    if (!current.enabled || current.accessState !== 'ready' || current.configRevision !== candidate.configRevision) {
      await cancelUnclaimedJob(jobs, candidate);
      continue;
    }
    const acquiredValue = await catalogs.findOneAndUpdate({
      _id: candidate.catalogId, enabled: true, accessState: 'ready', configRevision: candidate.configRevision,
      leaseFence: { $lt: Number.MAX_SAFE_INTEGER },
      $expr: { $or: [{ $eq: ['$lease', null] }, { $lte: ['$lease.expiresAt', '$$NOW'] }] },
    }, [{ $set: {
      leaseFence: { $add: ['$leaseFence', 1] },
      lease: { owner, fence: { $add: ['$leaseFence', 1] }, heartbeatAt: '$$NOW', expiresAt: { $add: ['$$NOW', LIMITS.leaseMs] } },
      updatedAt: { $max: ['$updatedAt', '$$NOW'] },
    } }], { returnDocument: 'after', writeConcern: { w: 1, j: true } });
    if (!acquiredValue) continue;
    let acquired: Catalog;
    try { acquired = CatalogSchema.parse(acquiredValue); }
    catch { throw new Error('sync_storage_unavailable'); }
    const fence = acquired.lease!.fence;
    if (candidate.state === 'running' && candidate.attempts >= LIMITS.maxAttempts) {
      const exhausted = await jobs.updateOne({ _id: candidate._id, state: 'running', owner: candidate.owner,
        fence: candidate.fence, attempts: LIMITS.maxAttempts }, [{ $set: {
        state: 'failed', owner: null, result: { kind: 'failure', code: 'worker_recovery_exhausted' },
        completedAt: '$$NOW', detailExpiresAt: { $add: ['$$NOW', LIMITS.terminalDetailMs] },
      } }], { writeConcern: { w: 1, j: true } });
      await catalogs.updateOne({ _id: acquired._id, 'lease.owner': owner, 'lease.fence': fence }, [{ $set: {
        lease: null, lastFailure: { jobId: candidate._id, code: 'worker_recovery_exhausted', at: '$$NOW' },
        updatedAt: { $max: ['$updatedAt', '$$NOW'] },
      } }], { writeConcern: { w: 1, j: true } });
      if (exhausted.matchedCount !== 1) throw new Error('sync_job_conflict');
      continue;
    }
    const jobValue = await jobs.findOneAndUpdate({
      _id: candidate._id, catalogId: candidate.catalogId, configRevision: candidate.configRevision,
      state: candidate.state, availableAt: candidate.availableAt, attempts: candidate.attempts,
      owner: candidate.owner, fence: candidate.fence,
      $expr: { $lte: ['$availableAt', '$$NOW'] },
    }, [{ $set: { state: 'running', attempts: { $add: ['$attempts', 1] }, owner, fence,
      targetCommit: null, generationId: null, result: null, completedAt: null, detailExpiresAt: null,
    } }], { returnDocument: 'after', writeConcern: { w: 1, j: true } });
    if (!jobValue) {
      await releaseCatalogLease(db, { catalogId: acquired._id, configRevision: acquired.configRevision,
        owner, fence, publicationRevision: acquired.publicationRevision });
      continue;
    }
    return { job: SyncJobSchema.parse(jobValue), catalog: acquired, catalogId: acquired._id,
      configRevision: candidate.configRevision, owner, fence, publicationRevision: acquired.publicationRevision };
  }
  return null;
}

export async function heartbeatSyncJob(db: Db, claimValue: unknown) {
  const claim = claimInput.parse(claimValue);
  const result = await db.collection<Catalog>('catalogs').updateOne({
    _id: claim.catalogId, enabled: true, accessState: 'ready', configRevision: claim.configRevision,
    leaseFence: claim.fence, 'lease.owner': claim.owner, 'lease.fence': claim.fence,
    $expr: { $gt: ['$lease.expiresAt', '$$NOW'] },
  }, [{ $set: { 'lease.heartbeatAt': '$$NOW', 'lease.expiresAt': { $add: ['$$NOW', LIMITS.leaseMs] },
    updatedAt: { $max: ['$updatedAt', '$$NOW'] } } }], { writeConcern: { w: 1, j: true } });
  return result.modifiedCount === 1;
}

export async function releaseSyncLease(db: Db, claimValue: unknown) {
  const claim = claimInput.parse(claimValue);
  return (await releaseCatalogLease(db, claim)).matchedCount === 1;
}

export async function completeSyncJob(db: Db, claimValue: unknown, resultValue: unknown) {
  const claim = claimInput.parse(claimValue);
  const result = successInput.parse(resultValue);
  const job = await db.collection<SyncJob>('syncJobs').findOne({
    catalogId: claim.catalogId, configRevision: claim.configRevision, state: 'running', owner: claim.owner, fence: claim.fence,
  });
  if (!job) throw new Error('sync_job_conflict');
  const catalogValue = await db.collection<Catalog>('catalogs').findOne({
    _id: claim.catalogId, configRevision: claim.configRevision,
  });
  if (!catalogValue) throw new Error('publication_conflict');
  const catalog = CatalogSchema.parse(catalogValue);
  if (![catalog.published, ...catalog.retained].some(pointer => pointer?.generationId === result.generationId &&
      pointer.commitSha === result.commitSha && pointer.jobId === job._id && pointer.fence === claim.fence)) throw new Error('publication_conflict');
  const updated = await db.collection<SyncJob>('syncJobs').findOneAndUpdate({
    _id: job._id, state: 'running', configRevision: claim.configRevision, owner: claim.owner, fence: claim.fence,
  }, [{ $set: { state: 'succeeded', owner: null, generationId: result.generationId,
    result: { kind: 'published', commitSha: result.commitSha }, completedAt: '$$NOW',
    detailExpiresAt: { $add: ['$$NOW', LIMITS.terminalDetailMs] },
  } }], { returnDocument: 'after', writeConcern: { w: 1, j: true } });
  if (!updated) throw new Error('sync_job_conflict');
  return SyncJobSchema.parse(updated);
}

/** Completes a lost terminal write from the authoritative publication pointer before retrying work. */
export async function reconcilePublishedSyncJobs(db: Db, limit = 20) {
  const jobs = await db.collection<SyncJob>('syncJobs').find({ state: 'running' })
    .sort({ requestedAt: 1 }).limit(Math.min(20, Math.max(1, limit))).toArray();
  let reconciled = 0;
  for (const value of jobs) {
    const job = SyncJobSchema.parse(value);
    const catalogValue = await db.collection<Catalog>('catalogs').findOne({ _id: job.catalogId, configRevision: job.configRevision });
    if (!catalogValue) continue;
    const catalog = CatalogSchema.parse(catalogValue);
    const pointer = [catalog.published, ...catalog.retained].find(item => item?.jobId === job._id &&
      item.fence === job.fence);
    if (!pointer) continue;
    const claim = { catalogId: job.catalogId, configRevision: job.configRevision, owner: job.owner,
      fence: job.fence, publicationRevision: 0 };
    try {
      await completeSyncJob(db, claim, { generationId: pointer.generationId, commitSha: pointer.commitSha });
      reconciled++;
    } catch (error) {
      if (!(error instanceof Error) || !['sync_job_conflict', 'publication_conflict'].includes(error.message)) throw error;
    }
  }
  return reconciled;
}

export async function setSyncTargetCommit(db: Db, claimValue: unknown, commitSha: string) {
  const claim = claimInput.parse(claimValue);
  const targetCommit = commit.parse(commitSha);
  const result = await db.collection<SyncJob>('syncJobs').updateOne({
    catalogId: claim.catalogId, configRevision: claim.configRevision, state: 'running', owner: claim.owner, fence: claim.fence,
    $expr: { $lte: ['$availableAt', '$$NOW'] },
  }, { $set: { targetCommit } }, { writeConcern: { w: 1, j: true } });
  if (result.modifiedCount !== 1) throw new Error('sync_job_conflict');
  const active = await db.collection<Catalog>('catalogs').countDocuments({
    _id: claim.catalogId, enabled: true, accessState: 'ready', configRevision: claim.configRevision,
    leaseFence: claim.fence, 'lease.owner': claim.owner, 'lease.fence': claim.fence,
    $expr: { $gt: ['$lease.expiresAt', '$$NOW'] },
  });
  if (active !== 1) throw new Error('sync_lease_lost');
}

/** Fails only the still-fenced owner; a published pointer always wins over a failed terminal write. */
export async function failSyncJob(db: Db, claimValue: unknown, failureValue: unknown) {
  const claim = claimInput.parse(claimValue);
  const failure = failureInput.parse(failureValue);
  const jobs = db.collection<SyncJob>('syncJobs');
  const jobValue = await jobs.findOne({ catalogId: claim.catalogId, configRevision: claim.configRevision,
    state: 'running', owner: claim.owner, fence: claim.fence });
  if (!jobValue) return 'lease_lost' as const;
  const job = SyncJobSchema.parse(jobValue);
  const catalogValue = await db.collection<Catalog>('catalogs').findOne({ _id: claim.catalogId, configRevision: claim.configRevision });
  if (!catalogValue) return 'lease_lost' as const;
  const catalog = CatalogSchema.parse(catalogValue);
  const published = [catalog.published, ...catalog.retained].find(pointer => pointer?.jobId === job._id &&
    pointer.fence === claim.fence);
  if (published) {
    await completeSyncJob(db, claim, { generationId: published.generationId, commitSha: published.commitSha });
    return 'succeeded' as const;
  }

  const terminal = failure.permanent || job.attempts >= LIMITS.maxAttempts;
  const delay = failure.retryAfterMs ?? LIMITS.retryDelaysMs[Math.min(job.attempts - 1, LIMITS.retryDelaysMs.length - 1)];
  const released = await db.collection<Catalog>('catalogs').updateOne({
    _id: claim.catalogId, enabled: true, accessState: 'ready', configRevision: claim.configRevision,
    leaseFence: claim.fence, 'lease.owner': claim.owner, 'lease.fence': claim.fence,
    $expr: { $gt: ['$lease.expiresAt', '$$NOW'] },
  }, [{ $set: { lease: null, lastFailure: { jobId: job._id, code: failure.code, at: '$$NOW' },
    updatedAt: { $max: ['$updatedAt', '$$NOW'] } } }], { writeConcern: { w: 1, j: true } });
  if (released.matchedCount !== 1) return 'lease_lost' as const;

  const updated = await jobs.findOneAndUpdate({ _id: job._id, state: 'running', owner: claim.owner, fence: claim.fence },
    [{ $set: {
      state: terminal ? 'failed' : 'retry_wait', owner: null,
      result: terminal ? { kind: 'failure', code: failure.code } : null,
      availableAt: terminal ? '$availableAt' : { $add: ['$$NOW', delay] },
      completedAt: terminal ? '$$NOW' : null,
      detailExpiresAt: terminal ? { $add: ['$$NOW', LIMITS.terminalDetailMs] } : null,
    } }], { returnDocument: 'after', writeConcern: { w: 1, j: true } });
  if (!updated) return 'lease_lost' as const;
  return terminal ? 'failed' as const : 'retry_wait' as const;
}
