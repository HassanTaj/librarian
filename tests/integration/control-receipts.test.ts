import { randomUUID } from 'node:crypto';
import { MongoServerError } from 'mongodb';
import { expect, it, vi } from 'vitest';
import { admitControlReceipt, ensureSyncJobStorage, newGitHubJobId, type ControlReceipt } from '../../lib/sync/jobs';
import { createStorageHarness } from './http-harness';

const catalogId = '00000000-0000-4000-8000-000000000011';
const payloadDigest = 'a'.repeat(64);

function receipt(event: 'installation' | 'installation_repositories' | 'repository', action: 'deleted' | 'removed') {
  const deliveryId = randomUUID();
  return { _id: newGitHubJobId(123, deliveryId, catalogId), catalogId, installationId: 123, repositoryId: 456,
    event, action, payloadDigest, completedAt: new Date('2026-10-12T00:00:00.000Z') };
}

it('validates and durably returns one control receipt for installation, repository, and repository-removal events', async () => {
  const storage = await createStorageHarness();
  try {
    await ensureSyncJobStorage(storage.db);
    for (const value of [receipt('installation', 'deleted'), receipt('repository', 'deleted'), receipt('installation_repositories', 'removed')]) {
      const first = await admitControlReceipt(storage.db, value);
      const replay = await admitControlReceipt(storage.db, value);
      expect(first).toEqual({ receipt: value, duplicate: false });
      expect(replay).toEqual({ receipt: value, duplicate: true });
    }
    expect(await storage.db.collection<ControlReceipt>('controlReceipts').countDocuments()).toBe(3);
  } finally { await storage.close(); }
});

it('rejects conflicting or corrupted durable control receipts without acknowledging them', async () => {
  const storage = await createStorageHarness();
  try {
    await ensureSyncJobStorage(storage.db);
    const value = receipt('repository', 'deleted');
    await admitControlReceipt(storage.db, value);
    await expect(admitControlReceipt(storage.db, { ...value, payloadDigest: 'b'.repeat(64) })).rejects.toThrow('sync_replay_conflict');
    await storage.db.collection<ControlReceipt>('controlReceipts').updateOne({ _id: value._id }, { $set: { event: 'invalid' as never } });
    await expect(admitControlReceipt(storage.db, value)).rejects.toThrow('sync_storage_unavailable');
    await expect(admitControlReceipt(storage.db, { ...value, action: 'removed' })).rejects.toThrow();
  } finally { await storage.close(); }
});

it('returns the durable receipt when a concurrent insert wins the unique-key race', async () => {
  const storage = await createStorageHarness();
  try {
    await ensureSyncJobStorage(storage.db);
    const value = receipt('repository', 'deleted');
    const collection = storage.db.collection<ControlReceipt>('controlReceipts');
    const insert = collection.insertOne.bind(collection);
    const racedDb = new Proxy(storage.db, { get(target, property) {
      if (property === 'collection') return (name: string) => name === 'controlReceipts' ? collection : target.collection(name);
      return Reflect.get(target, property, target);
    } });
    vi.spyOn(collection, 'insertOne').mockImplementationOnce(async (document, options) => {
      await insert(document, options);
      throw Object.assign(new MongoServerError({ message: 'synthetic duplicate receipt' }), { code: 11000 });
    });
    await expect(admitControlReceipt(racedDb, value)).resolves.toEqual({ receipt: value, duplicate: true });
  } finally { await storage.close(); }
});

it('does not acknowledge a duplicate-key race if the winning receipt cannot be read', async () => {
  const storage = await createStorageHarness();
  try {
    await ensureSyncJobStorage(storage.db);
    const value = receipt('repository', 'deleted');
    const collection = storage.db.collection<ControlReceipt>('controlReceipts');
    const racedDb = new Proxy(storage.db, { get(target, property) {
      if (property === 'collection') return (name: string) => name === 'controlReceipts' ? collection : target.collection(name);
      return Reflect.get(target, property, target);
    } });
    vi.spyOn(collection, 'insertOne').mockRejectedValueOnce(Object.assign(
      new MongoServerError({ message: 'synthetic duplicate receipt' }), { code: 11000 },
    ));
    await expect(admitControlReceipt(racedDb, value)).rejects.toThrow('sync_storage_unavailable');
  } finally { await storage.close(); }
});
