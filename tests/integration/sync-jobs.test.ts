import { MongoServerError } from 'mongodb';
import { expect, it, vi } from 'vitest';
import { newCatalogRecord, type Catalog } from '../../lib/catalog';
import { admitSyncJob, ensureSyncJobStorage, newManualJobId, type SyncJob } from '../../lib/sync/jobs';
import { createStorageHarness } from './http-harness';

const catalogId = '00000000-0000-4000-8000-000000000001';
const key = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = (letter: string) => letter.repeat(64);

async function setup() {
  const storage = await createStorageHarness();
  const catalog = newCatalogRecord({
    github: { repositoryId: 123, installationId: 456, owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs' },
    slug: 'sync-fixture', title: 'Sync fixture', visibility: 'private',
  });
  catalog._id = catalogId;
  catalog.accessState = 'ready';
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
  await ensureSyncJobStorage(storage.db);
  return { ...storage, catalog };
}

it('admits durable work once, returns identical replays, rejects digest conflicts, and preserves sequence gaps', async () => {
  const storage = await setup();
  try {
    const request = { _id: newManualJobId(catalogId, key(1)), catalogId, origin: 'manual' as const,
      event: 'manual', payloadDigest: digest('a') };
    const first = await admitSyncJob(storage.db, request);
    const replay = await admitSyncJob(storage.db, request);
    expect(first).toMatchObject({ duplicate: false, job: { admissionSequence: 1, state: 'queued' } });
    expect(replay).toMatchObject({ duplicate: true, job: { _id: request._id, admissionSequence: 1 } });

    await expect(admitSyncJob(storage.db, { ...request, payloadDigest: digest('b') }))
      .rejects.toThrow('sync_replay_conflict');
    const second = await admitSyncJob(storage.db, { ...request, _id: newManualJobId(catalogId, key(2)), payloadDigest: digest('c') });
    expect(second.job.admissionSequence).toBe(2);
    expect(await storage.db.collection('syncJobs').countDocuments()).toBe(2);
  } finally { await storage.close(); }
});

it('expires worker heartbeat records after a bounded TTL', async () => {
  const storage = await setup();
  try {
    const indexes = await storage.db.collection('syncWorkerStatus').listIndexes().toArray();
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'sync_worker_status_ttl',
      key: { updatedAt: 1 }, expireAfterSeconds: 60 }));
  } finally { await storage.close(); }
});

it('limits valid admissions to 60 per minute and keeps lifetime quota exhaustion explicit', async () => {
  const storage = await setup();
  try {
    const start = new Date('2026-10-12T00:00:00.000Z');
    for (let index = 1; index <= 60; index++) {
      await admitSyncJob(storage.db, { _id: newManualJobId(catalogId, key(index)), catalogId,
        origin: 'manual', event: 'manual', payloadDigest: digest('d') }, start);
    }
    await expect(admitSyncJob(storage.db, { _id: newManualJobId(catalogId, key(61)), catalogId,
      origin: 'manual', event: 'manual', payloadDigest: digest('e') }, start)).rejects.toThrow('sync_rate_limited');
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalogId }))?.admissionReservations).toBe(60);

    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalogId }, { $set: { admissionReservations: 100_000 } });
    await expect(admitSyncJob(storage.db, { _id: newManualJobId(catalogId, key(62)), catalogId,
      origin: 'manual', event: 'manual', payloadDigest: digest('f') }, start)).rejects.toThrow('sync_quota_exhausted');
    expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments()).toBe(60);
  } finally { await storage.close(); }
});

it('does not admit disabled or unverified catalogs', async () => {
  const storage = await setup();
  try {
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalogId }, { $set: { enabled: false } });
    await expect(admitSyncJob(storage.db, { _id: newManualJobId(catalogId, key(70)), catalogId,
      origin: 'manual', event: 'manual', payloadDigest: digest('a') })).rejects.toThrow('sync_catalog_unavailable');
    expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments()).toBe(0);
  } finally { await storage.close(); }
});

it('serializes competing admissions and leaves a harmless reservation gap for a duplicate receipt race', async () => {
  const storage = await setup();
  try {
    const request = { _id: newManualJobId(catalogId, key(80)), catalogId, origin: 'manual' as const,
      event: 'manual', payloadDigest: digest('a') };
    const results = await Promise.all([admitSyncJob(storage.db, request), admitSyncJob(storage.db, request)]);
    expect(results.map(result => result.duplicate).sort()).toEqual([false, true]);
    expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments()).toBe(1);
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalogId }))?.admissionReservations).toBe(2);
  } finally { await storage.close(); }
});

it('returns a winning durable job after an insert duplicate-key race and rejects a missing winner', async () => {
  const storage = await setup();
  try {
    const request = { _id: newManualJobId(catalogId, key(90)), catalogId, origin: 'manual' as const,
      event: 'manual', payloadDigest: digest('a') };
    const jobs = storage.db.collection<SyncJob>('syncJobs');
    const insert = jobs.insertOne.bind(jobs);
    const racedDb = new Proxy(storage.db, { get(target, property) {
      if (property === 'collection') return (name: string) => name === 'syncJobs' ? jobs : target.collection(name);
      return Reflect.get(target, property, target);
    } });
    vi.spyOn(jobs, 'insertOne').mockImplementationOnce(async (document, options) => {
      await insert(document, options);
      throw Object.assign(new MongoServerError({ message: 'synthetic duplicate job' }), { code: 11000 });
    });
    await expect(admitSyncJob(racedDb, request)).resolves.toMatchObject({ duplicate: true, job: { _id: request._id } });

    const missingWinner = { ...request, _id: newManualJobId(catalogId, key(91)) };
    vi.spyOn(jobs, 'insertOne').mockRejectedValueOnce(Object.assign(
      new MongoServerError({ message: 'synthetic duplicate job' }), { code: 11000 },
    ));
    await expect(admitSyncJob(racedDb, missingWinner)).rejects.toThrow('sync_storage_unavailable');
  } finally { await storage.close(); }
});
