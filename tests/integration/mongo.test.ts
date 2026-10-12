import { expect, it } from 'vitest';
import { createStorageHarness } from './http-harness';
import { connectMongo } from '../../lib/mongo';

it('uses the dedicated database, finite shared driver settings and real acknowledged indexes', async () => {
  const storage = await createStorageHarness();
  const connection = await connectMongo({ mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase: storage.db.databaseName });
  try {
    expect(connection.db.databaseName).toBe(storage.db.databaseName);
    expect(connection.client.options).toMatchObject({ maxPoolSize: 10, minPoolSize: 0, serverSelectionTimeoutMS: 5000 });
    expect(connection.db.readPreference.mode).toBe('primary');
    expect(connection.db.writeConcern).toMatchObject({ w: 1, j: true });
    expect((await connection.db.collection('catalogs').indexes()).filter(index => index.unique).map(index => index.name)).toEqual(expect.arrayContaining(['catalog_slug', 'catalog_source']));
    expect((await connection.db.collection('syncJobs').indexes()).map(index => index.name)).toEqual(expect.arrayContaining([
      '_id_', 'sync_schedule', 'sync_catalog_state', 'sync_terminal_compaction',
    ]));
    await connection.db.collection('probe').insertOne({ synthetic: true });
    expect(await storage.db.collection('probe').findOne({ synthetic: true })).toBeTruthy();
  } finally { await connection.client.close(); await storage.close(); }
});

it('fails closed with a bounded sanitized error when Mongo is unavailable', async () => {
  await expect(connectMongo({ mongodbUri: 'mongodb://127.0.0.1:1', mongodbDatabase: 'librarian_test_unavailable' })).rejects.toThrow('storage_unavailable');
});

it.each(['admin', 'local', 'config', '', '../escape'])('rejects unsafe or system database selection (%s)', mongodbDatabase => {
  return expect(connectMongo({ mongodbUri: 'mongodb://127.0.0.1:27018', mongodbDatabase })).rejects.toThrow('storage_unavailable');
});
