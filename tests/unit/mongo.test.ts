import { afterEach, expect, it, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { connectMongo, getMongo, closeMongo } from '../../lib/mongo';
import * as config from '../../lib/config';
import * as catalog from '../../lib/catalog';
import * as syncJobs from '../../lib/sync/jobs';

afterEach(async () => { await closeMongo().catch(() => {}); vi.restoreAllMocks(); });

function driver(hello: object) {
  const command = vi.fn().mockResolvedValue(hello);
  const db = { command };
  const close = vi.spyOn(MongoClient.prototype, 'close').mockResolvedValue();
  vi.spyOn(MongoClient.prototype, 'connect').mockImplementation(async function(this: MongoClient) { return this; });
  const select = vi.spyOn(MongoClient.prototype, 'db').mockReturnValue(db as unknown as ReturnType<MongoClient['db']>);
  vi.spyOn(catalog, 'ensureCatalogStorage').mockResolvedValue();
  vi.spyOn(syncJobs, 'ensureSyncJobStorage').mockResolvedValue();
  return { command, select, close };
}

it.each([{ setName: 'synthetic' }, { msg: 'isdbgrid' }])('requires majority journaling on supported replica and router topologies (%j)', async topology => {
  const mock = driver({ isWritablePrimary: true, maxWireVersion: 13, ...topology });
  const connection = await connectMongo({ mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase: 'librarian_test_topology' });
  expect(mock.select).toHaveBeenLastCalledWith('librarian_test_topology', { readPreference: 'primary', writeConcern: { w: 'majority', j: true } });
  await connection.client.close();
});

it.each([{ isWritablePrimary: false, maxWireVersion: 13 }, { isWritablePrimary: true, maxWireVersion: 12 }])('closes unusable connections and denies unsupported versions/non-primary storage (%j)', async hello => {
  const mock = driver(hello);
  await expect(connectMongo({ mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase: 'librarian_test_invalid' })).rejects.toThrow('storage_unavailable');
  expect(mock.close).toHaveBeenCalledOnce();
});

it('shares one lazy connection, closes it, and allows retry after configuration failure', async () => {
  const settings = { mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase: 'librarian_test_shared' } as Awaited<ReturnType<typeof config.loadConfig>>;
  const load = vi.spyOn(config, 'loadConfig').mockRejectedValueOnce(new Error('SYNTHETIC_SECRET_NOT_LOGGED')).mockResolvedValue(settings);
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

it('sanitizes driver construction failures without opening a connection', async () => {
  await expect(connectMongo({ mongodbUri: 'invalid://synthetic-secret', mongodbDatabase: 'librarian_test_invalid' })).rejects.toThrow('storage_unavailable');
});
