import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { Collection, Db } from 'mongodb';
import { newCatalogRecord, type Catalog } from '../../lib/catalog';
import { admitSyncJob, claimNextSyncJob, completeSyncJob, failSyncJob, heartbeatSyncJob, newManualJobId,
  reconcilePublishedSyncJobs, releaseSyncLease, setSyncTargetCommit, type SyncJob } from '../../lib/sync/jobs';
import { createStorageHarness } from './http-harness';

const catalogId = () => randomUUID();
const key = () => randomUUID();
const digest = 'a'.repeat(64);

async function setup() {
  const storage = await createStorageHarness();
  const id = catalogId();
  const catalog = newCatalogRecord({ github: { repositoryId: 321, installationId: 654, owner: 'synthetic', name: 'leases', branch: 'main', docsPath: 'docs' },
    slug: 'lease-fixture', title: 'Lease fixture', visibility: 'private' });
  catalog._id = id;
  catalog.accessState = 'ready';
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
  const job = await admitSyncJob(storage.db, { _id: newManualJobId(id, key()), catalogId: id,
    origin: 'manual', event: 'manual', payloadDigest: digest });
  return { ...storage, catalog, job: job.job };
}

function withCollection(db: Db, name: string, collection: Collection<SyncJob>): Db {
  const original = db.collection.bind(db);
  return new Proxy(db, { get(target, property) {
    if (property === 'collection') return (requested: string) => requested === name ? collection : original(requested);
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

it('claims one job with a Mongo-time lease and fence, heartbeats, and releases only the owner lease', async () => {
  const storage = await setup();
  try {
    const owner = randomUUID();
    const claim = await claimNextSyncJob(storage.db, owner);
    expect(claim).toMatchObject({ job: { state: 'running', attempts: 1, owner, fence: 1 },
      catalog: { lease: { owner, fence: 1 }, leaseFence: 1 } });
    expect(claim?.catalog.lease?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await claimNextSyncJob(storage.db, randomUUID())).toBeNull();
    expect(await heartbeatSyncJob(storage.db, claim!)).toBe(true);
    expect(await releaseSyncLease(storage.db, claim!)).toBe(true);
    expect(await releaseSyncLease(storage.db, claim!)).toBe(false);
  } finally { await storage.close(); }
});

it('reclaims abandoned work after lease expiry with a higher fence and bounded attempt count', async () => {
  const storage = await setup();
  try {
    const old = await claimNextSyncJob(storage.db, randomUUID());
    expect(old).toBeTruthy();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: {
      'lease.heartbeatAt': new Date(Date.now() - 60_000), 'lease.expiresAt': new Date(Date.now() - 30_000),
    } });
    const nextOwner = randomUUID();
    const next = await claimNextSyncJob(storage.db, nextOwner);
    expect(next).toMatchObject({ job: { state: 'running', attempts: 2, owner: nextOwner, fence: 2 },
      catalog: { lease: { owner: nextOwner, fence: 2 }, leaseFence: 2 } });
    expect(await heartbeatSyncJob(storage.db, old!)).toBe(false);
  } finally { await storage.close(); }
});

it('terminally recovers an abandoned fifth attempt instead of leaving it unclaimable', async () => {
  const storage = await setup();
  try {
    const owner = randomUUID();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: {
      leaseFence: 5, lease: { owner, fence: 5, heartbeatAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 30_000) },
    } });
    await storage.db.collection<SyncJob>('syncJobs').updateOne({ _id: storage.job._id }, { $set: {
      state: 'running', attempts: 5, owner, fence: 5, availableAt: new Date(0),
    } });
    expect(await claimNextSyncJob(storage.db, randomUUID())).toBeNull();
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id })).toMatchObject({
      state: 'failed', attempts: 5, owner: null, result: { kind: 'failure', code: 'worker_recovery_exhausted' },
    });
    expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id })).toMatchObject({
      lease: null, leaseFence: 6, lastFailure: { code: 'worker_recovery_exhausted' },
    });
  } finally { await storage.close(); }
});

it('cancels accepted work whose source configuration changed before claim', async () => {
  const storage = await setup();
  try {
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: { configRevision: 2 } });
    expect(await claimNextSyncJob(storage.db, randomUUID())).toBeNull();
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id })).toMatchObject({
      state: 'cancelled', owner: null, completedAt: expect.any(Date),
    });
  } finally { await storage.close(); }
});

it('completes a claimed receipt only for its owner/fence and records the published identity', async () => {
  const storage = await setup();
  try {
    const claim = await claimNextSyncJob(storage.db, randomUUID());
    expect(claim).toBeTruthy();
    const generationId = randomUUID();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: {
      published: { generationId, commitSha: 'b'.repeat(40), jobId: claim!.job._id, fence: claim!.fence,
        configRevision: claim!.configRevision, manifestDigest: 'c'.repeat(64), publishedAt: new Date() },
      publicationRevision: 1, lease: null,
    } });
    await completeSyncJob(storage.db, claim!, { generationId, commitSha: 'b'.repeat(40) });
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id })).toMatchObject({
      state: 'succeeded', owner: null, generationId: expect.any(String),
      result: { kind: 'published', commitSha: 'b'.repeat(40) }, completedAt: expect.any(Date), detailExpiresAt: expect.any(Date),
    });
  } finally { await storage.close(); }
});

it('uses only an active fenced lease to set the target commit and fails closed after lease loss', async () => {
  const storage = await setup();
  try {
    const claim = await claimNextSyncJob(storage.db, randomUUID());
    expect(claim).toBeTruthy();
    await expect(setSyncTargetCommit(storage.db, claim!, 'invalid')).rejects.toThrow();
    await setSyncTargetCommit(storage.db, claim!, 'a'.repeat(40));
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: { lease: null } });
    await expect(setSyncTargetCommit(storage.db, claim!, 'b'.repeat(40))).rejects.toThrow('sync_lease_lost');
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id })).toMatchObject({ targetCommit: 'b'.repeat(40) });
  } finally { await storage.close(); }
});

it('retries transient failures with bounded backoff, then stores a permanent terminal failure', async () => {
  const storage = await setup();
  try {
    const first = await claimNextSyncJob(storage.db, randomUUID());
    expect(await failSyncJob(storage.db, first!, { code: 'provider_busy', permanent: false })).toBe('retry_wait');
    const pending = await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id });
    expect(pending).toMatchObject({ state: 'retry_wait', attempts: 1, owner: null, result: null });
    expect(pending!.availableAt.getTime()).toBeGreaterThan(Date.now());

    await storage.db.collection<SyncJob>('syncJobs').updateOne({ _id: storage.job._id }, { $set: { availableAt: new Date(0) } });
    const second = await claimNextSyncJob(storage.db, randomUUID());
    expect(await failSyncJob(storage.db, second!, { code: 'invalid_content', permanent: true })).toBe('failed');
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id })).toMatchObject({
      state: 'failed', attempts: 2, owner: null, result: { kind: 'failure', code: 'invalid_content' }, completedAt: expect.any(Date),
    });
  } finally { await storage.close(); }
});

it('does not complete or reconcile a job without the authoritative publication pointer', async () => {
  const storage = await setup();
  try {
    const claim = await claimNextSyncJob(storage.db, randomUUID());
    const generationId = randomUUID();
    await expect(completeSyncJob(storage.db, claim!, { generationId, commitSha: 'a'.repeat(40) })).rejects.toThrow('publication_conflict');
    expect(await reconcilePublishedSyncJobs(storage.db, 0)).toBe(0);
    await storage.db.collection<Catalog>('catalogs').deleteOne({ _id: storage.catalog._id });
    expect(await reconcilePublishedSyncJobs(storage.db, 20)).toBe(0);
  } finally { await storage.close(); }
});

it('rejects a completion when its durable job or catalog disappears before the terminal write', async () => {
  const missingJobStorage = await setup();
  try {
    const claim = await claimNextSyncJob(missingJobStorage.db, randomUUID());
    await missingJobStorage.db.collection<SyncJob>('syncJobs').deleteOne({ _id: missingJobStorage.job._id });
    await expect(completeSyncJob(missingJobStorage.db, claim!, { generationId: randomUUID(), commitSha: 'a'.repeat(40) }))
      .rejects.toThrow('sync_job_conflict');
  } finally { await missingJobStorage.close(); }

  const missingCatalogStorage = await setup();
  try {
    const claim = await claimNextSyncJob(missingCatalogStorage.db, randomUUID());
    await missingCatalogStorage.db.collection<Catalog>('catalogs').deleteOne({ _id: missingCatalogStorage.catalog._id });
    await expect(completeSyncJob(missingCatalogStorage.db, claim!, { generationId: randomUUID(), commitSha: 'a'.repeat(40) }))
      .rejects.toThrow('publication_conflict');
  } finally { await missingCatalogStorage.close(); }
});

it('treats the durable publication as success when a worker reports failure afterward', async () => {
  const storage = await setup();
  try {
    const claim = await claimNextSyncJob(storage.db, randomUUID());
    const generationId = randomUUID();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: {
      published: { generationId, commitSha: 'b'.repeat(40), jobId: claim!.job._id, fence: claim!.fence,
        configRevision: claim!.configRevision, manifestDigest: 'c'.repeat(64), publishedAt: new Date() },
    } });
    expect(await failSyncJob(storage.db, claim!, { code: 'worker_shutdown', permanent: false })).toBe('succeeded');
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id })).toMatchObject({
      state: 'succeeded', result: { kind: 'published', commitSha: 'b'.repeat(40) },
    });
  } finally { await storage.close(); }
});

it('returns lease_lost without modifying work after its job, catalog or active lease disappears', async () => {
  const missingJob = await setup();
  try {
    const claim = await claimNextSyncJob(missingJob.db, randomUUID());
    await missingJob.db.collection<SyncJob>('syncJobs').deleteOne({ _id: missingJob.job._id });
    expect(await failSyncJob(missingJob.db, claim!, { code: 'provider_busy', permanent: false })).toBe('lease_lost');
  } finally { await missingJob.close(); }

  const missingCatalog = await setup();
  try {
    const claim = await claimNextSyncJob(missingCatalog.db, randomUUID());
    await missingCatalog.db.collection<Catalog>('catalogs').deleteOne({ _id: missingCatalog.catalog._id });
    expect(await failSyncJob(missingCatalog.db, claim!, { code: 'provider_busy', permanent: false })).toBe('lease_lost');
  } finally { await missingCatalog.close(); }

  const expiredLease = await setup();
  try {
    const claim = await claimNextSyncJob(expiredLease.db, randomUUID());
    await expiredLease.db.collection<Catalog>('catalogs').updateOne({ _id: expiredLease.catalog._id }, { $set: {
      'lease.heartbeatAt': new Date(Date.now() - 60_000), 'lease.expiresAt': new Date(Date.now() - 30_000),
    } });
    expect(await failSyncJob(expiredLease.db, claim!, { code: 'provider_busy', permanent: false })).toBe('lease_lost');
    expect(await expiredLease.db.collection<SyncJob>('syncJobs').findOne({ _id: expiredLease.job._id })).toMatchObject({ state: 'running' });
  } finally { await expiredLease.close(); }
});

it('reports a target-commit conditional-write conflict when the claim no longer owns a job', async () => {
  const storage = await setup();
  try {
    const claim = await claimNextSyncJob(storage.db, randomUUID());
    await storage.db.collection<SyncJob>('syncJobs').deleteOne({ _id: storage.job._id });
    await expect(setSyncTargetCommit(storage.db, claim!, 'a'.repeat(40))).rejects.toThrow('sync_job_conflict');
  } finally { await storage.close(); }
});

it('releases the acquired catalog lease when a job loses its conditional claim', async () => {
  const storage = await setup();
  try {
    const jobs = storage.db.collection<SyncJob>('syncJobs');
    vi.spyOn(jobs, 'findOneAndUpdate').mockResolvedValueOnce(null);
    expect(await claimNextSyncJob(withCollection(storage.db, 'syncJobs', jobs), randomUUID())).toBeNull();
    expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id })).toMatchObject({ lease: null, leaseFence: 1 });
  } finally { await storage.close(); }
});

it('surfaces a lost fifth-attempt terminal write after releasing its newly acquired lease', async () => {
  const storage = await setup();
  const previousOwner = randomUUID();
  try {
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: {
      leaseFence: 5, lease: { owner: previousOwner, fence: 5, heartbeatAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 30_000) },
    } });
    await storage.db.collection<SyncJob>('syncJobs').updateOne({ _id: storage.job._id }, { $set: {
      state: 'running', attempts: 5, owner: previousOwner, fence: 5, availableAt: new Date(0),
    } });
    const jobs = storage.db.collection<SyncJob>('syncJobs');
    vi.spyOn(jobs, 'updateOne').mockResolvedValueOnce({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 } as never);
    await expect(claimNextSyncJob(withCollection(storage.db, 'syncJobs', jobs), randomUUID())).rejects.toThrow('sync_job_conflict');
    expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id })).toMatchObject({ lease: null, leaseFence: 6 });
  } finally { await storage.close(); }
});

it('rejects a completion whose final conditional update loses the durable job race', async () => {
  const storage = await setup();
  try {
    const claim = await claimNextSyncJob(storage.db, randomUUID());
    const generationId = randomUUID();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: {
      published: { generationId, commitSha: 'b'.repeat(40), jobId: claim!.job._id, fence: claim!.fence,
        configRevision: claim!.configRevision, manifestDigest: 'c'.repeat(64), publishedAt: new Date() },
    } });
    const jobs = storage.db.collection<SyncJob>('syncJobs');
    vi.spyOn(jobs, 'findOneAndUpdate').mockResolvedValueOnce(null);
    await expect(completeSyncJob(withCollection(storage.db, 'syncJobs', jobs), claim!, { generationId, commitSha: 'b'.repeat(40) }))
      .rejects.toThrow('sync_job_conflict');
  } finally { await storage.close(); }
});

it('reconciles an authoritative publication after a transient write conflict and rethrows unrelated failures', async () => {
  const storage = await setup();
  try {
    const claim = await claimNextSyncJob(storage.db, randomUUID());
    const generationId = randomUUID();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: {
      published: { generationId, commitSha: 'b'.repeat(40), jobId: claim!.job._id, fence: claim!.fence,
        configRevision: claim!.configRevision, manifestDigest: 'c'.repeat(64), publishedAt: new Date() },
    } });
    const jobs = storage.db.collection<SyncJob>('syncJobs');
    const db = withCollection(storage.db, 'syncJobs', jobs);
    vi.spyOn(jobs, 'findOneAndUpdate').mockRejectedValueOnce(new Error('publication_conflict'));
    expect(await reconcilePublishedSyncJobs(db)).toBe(0);
    vi.spyOn(jobs, 'findOneAndUpdate').mockRejectedValueOnce('synthetic storage error');
    await expect(reconcilePublishedSyncJobs(db)).rejects.toBe('synthetic storage error');
    expect(await reconcilePublishedSyncJobs(db)).toBe(1);
  } finally { await storage.close(); }
});

it('reconciles success from a retained generation after the active pointer advances', async () => {
  const storage = await setup();
  try {
    const claim = await claimNextSyncJob(storage.db, randomUUID());
    const generationId = randomUUID();
    const commitSha = 'c'.repeat(40);
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: {
      published: null,
      retained: [{ generationId, configRevision: claim!.configRevision, commitSha, jobId: claim!.job._id,
        fence: claim!.fence, manifestDigest: 'd'.repeat(64), publishedAt: new Date(), retiredAt: new Date() }],
    } });
    expect(await reconcilePublishedSyncJobs(storage.db)).toBe(1);
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id })).toMatchObject({
      state: 'succeeded', generationId, result: { kind: 'published', commitSha },
    });
  } finally { await storage.close(); }
});
