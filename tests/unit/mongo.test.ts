import { LIMITS } from '../../lib/limits';
import { afterEach, expect, it, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { connectMongo, getMongo, closeMongo } from '../../lib/mongo';
import * as config from '../../lib/config';
import * as catalog from '../../lib/catalog';
import * as syncJobs from '../../lib/sync/jobs';
import * as instanceStore from '../../lib/instance/store';

afterEach(async () => { await closeMongo().catch(() => {}); vi.restoreAllMocks(); });

function driver(hello: object) {
  const command = vi.fn().mockResolvedValue(hello);
  const db = { command };
  const close = vi.spyOn(MongoClient.prototype, 'close').mockResolvedValue();
  vi.spyOn(MongoClient.prototype, 'connect').mockImplementation(async function(this: MongoClient) { return this; });
  const select = vi.spyOn(MongoClient.prototype, 'db').mockReturnValue(db as unknown as ReturnType<MongoClient['db']>);
  const catalogStorage = vi.spyOn(catalog, 'ensureCatalogStorage').mockResolvedValue();
  const syncStorage = vi.spyOn(syncJobs, 'ensureSyncJobStorage').mockResolvedValue();
  return { command, select, close, catalogStorage, syncStorage };
}

it.each([{ setName: 'synthetic' }, { msg: 'isdbgrid' }])('requires majority journaling on supported replica and router topologies (%j)', async topology => {
  const mock = driver({ isWritablePrimary: true, maxWireVersion: 13, ...topology });
  const connection = await connectMongo({ mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase: 'librarian_test_topology' });
  expect(mock.select).toHaveBeenLastCalledWith('librarian_test_topology', { readPreference: 'primary', writeConcern: { w: 'majority', j: true } });
  await connection.client.close();
});

it('can probe fresh setup storage without creating legacy collections or quota records', async () => {
  const mock = driver({ isWritablePrimary: true, maxWireVersion: 13 });
  await connectMongo({ mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase: 'librarian_test_setup_probe' }, { initializeLegacy: false });
  expect(mock.command).toHaveBeenCalledWith({ hello: 1 });
  expect(mock.catalogStorage).not.toHaveBeenCalled();
  expect(mock.syncStorage).not.toHaveBeenCalled();
});

it.each([{ isWritablePrimary: false, maxWireVersion: 13 }, { isWritablePrimary: true, maxWireVersion: 12 }])('closes unusable connections and denies unsupported versions/non-primary storage (%j)', async hello => {
  const mock = driver(hello);
  await expect(connectMongo({ mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase: 'librarian_test_invalid' })).rejects.toThrow('storage_unavailable');
  expect(mock.close).toHaveBeenCalledOnce();
});

it('shares one lazy connection, closes it, and allows retry after host configuration failure', async () => {
  const settings = { mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase: 'librarian_test_shared', contentRoot: 'D:/protected/content' } as Awaited<ReturnType<typeof config.loadHostConfig>>;
  const load = vi.spyOn(config, 'loadConfig').mockRejectedValueOnce(new Error('SYNTHETIC_SECRET_NOT_LOGGED')).mockResolvedValue(settings as Awaited<ReturnType<typeof config.loadConfig>>);
  await expect(getMongo()).rejects.toThrow('storage_unavailable');
  const mock = driver({ isWritablePrimary: true, maxWireVersion: 13 });
  const first = getMongo();
  expect(getMongo()).toBe(first);
  expect((await first).db).toBe(await (await getMongo()).db);
  expect(load).toHaveBeenCalledTimes(2);
  await closeMongo();
  expect(mock.close).toHaveBeenCalledOnce();
  await closeMongo();
  expect(mock.close).toHaveBeenCalledOnce();
});

it('attaches the instance keyring when a cached connection is reused with lifecycle-validated settings', async () => {
  const settings = { mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase: 'librarian_test_keyring' };
  driver({ isWritablePrimary: true, maxWireVersion: 13 });
  const first = await getMongo(settings);
  const keyring = { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } };
  const attach = vi.spyOn(instanceStore, 'attachInstanceKeyring').mockImplementation(() => undefined);

  const reused = await getMongo({ ...settings, instanceKeyring: keyring });

  expect(reused).toBe(first);
  expect(attach).toHaveBeenCalledWith(first.db, keyring);
});

it('does not open normal runtime storage without lifecycle-validated configuration', async () => {
  const load = vi.spyOn(config, 'loadConfig').mockRejectedValue(new Error('Instance setup is not ready.'));
  const mock = driver({ isWritablePrimary: true, maxWireVersion: 13, setName: 'synthetic' });
  await expect(getMongo()).rejects.toThrow('storage_unavailable');
  expect(load).toHaveBeenCalledOnce();
  expect(mock.command).not.toHaveBeenCalled();
});

it('sanitizes driver construction failures without opening a connection', async () => {
  await expect(connectMongo({ mongodbUri: 'invalid://synthetic-secret', mongodbDatabase: 'librarian_test_invalid' })).rejects.toThrow('storage_unavailable');
});

it('uses an activated connection immediately and retires the old pool after bounded readers finish', async () => {
  vi.useFakeTimers();
  try {
    const mock = driver({ isWritablePrimary: true, maxWireVersion: 13 });
    const settings = { mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase: 'librarian_test_connection_update' };
    const first = await getMongo(settings);
    const next = await getMongo({ ...settings, mongodbUri: settings.mongodbUri + '/?appName=synthetic-update' });
    expect(next.client).not.toBe(first.client);
    expect(mock.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIMITS.instanceRequestPinMs);
    expect(mock.close).toHaveBeenCalledOnce();
    expect((await getMongo({ ...settings, mongodbUri: settings.mongodbUri + '/?appName=synthetic-update' })).client).toBe(next.client);
  } finally { vi.useRealTimers(); }
});
