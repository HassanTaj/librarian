import { expect, it, vi } from 'vitest';
import { Db, MongoServerError } from 'mongodb';
import { createStorageHarness } from './http-harness';
import { ensureCatalogStorage, insertCatalog } from '../../lib/catalog';

const definition = (index: number) => ({ github: { repositoryId: index + 1, installationId: 456, owner: 'synthetic', name: `project-${index}`, branch: 'main', docsPath: 'docs' }, slug: `project-${index}`, title: 'Configured synthetic title' });

it('enforces real unique route/source indexes and keeps failed-create reservations as safe overcount', async () => {
  const storage = await createStorageHarness();
  try {
    await ensureCatalogStorage(storage.db);
    await ensureCatalogStorage(storage.db);
    await insertCatalog(storage.db, definition(0));
    await expect(insertCatalog(storage.db, { ...definition(1), slug: 'project-0' })).rejects.toMatchObject({ code: 11000 });
    await expect(insertCatalog(storage.db, { ...definition(0), slug: 'different-route' })).rejects.toMatchObject({ code: 11000 });
    expect(await storage.db.collection('catalogs').countDocuments()).toBe(1);
    expect((await storage.db.collection<{ _id: string; reservations: number }>('quotas').findOne({ _id: 'catalogs' }))?.reservations).toBe(3);
  } finally { await storage.close(); }
});

it('admits at most twenty catalog creations under concurrent real Mongo writes', async () => {
  const storage = await createStorageHarness();
  try {
    await Promise.all([ensureCatalogStorage(storage.db), ensureCatalogStorage(storage.db)]);
    const result = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => insertCatalog(storage.db, definition(index))));
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(20);
    expect(await storage.db.collection('catalogs').countDocuments()).toBe(20);
    for (const item of result) if (item.status === 'rejected') expect(item.reason.message).toBe('catalog_quota');
  } finally { await storage.close(); }
});

it('initializes reservations from existing records and fails closed on an already excessive collection', async () => {
  const storage = await createStorageHarness();
  try {
    await storage.db.collection<{ _id: string }>('catalogs').insertMany(Array.from({ length: 21 }, (_, index) => ({ ...definition(index), _id: `synthetic-${index}` })));
    await expect(ensureCatalogStorage(storage.db)).rejects.toThrow('catalog_quota');
    expect(await storage.db.collection('quotas').countDocuments()).toBe(0);
  } finally { await storage.close(); }
});

it('refuses corrupt quota counters and never resets reservations after failed initialization', async () => {
  const storage = await createStorageHarness();
  try {
    await ensureCatalogStorage(storage.db);
    const quota = storage.db.collection<{ _id: string; reservations: number }>('quotas');
    await quota.updateOne({ _id: 'catalogs' }, { $set: { reservations: 21 } });
    await expect(ensureCatalogStorage(storage.db)).rejects.toThrow();
    await quota.updateOne({ _id: 'catalogs' }, { $set: { reservations: 0 } });
    await storage.db.collection('catalogs').insertOne({ ...definition(0) });
    await expect(ensureCatalogStorage(storage.db)).rejects.toThrow('catalog_quota');
  } finally { await storage.close(); }
});

it('survives a competing singleton insertion but propagates storage failure', async () => {
  const storage = await createStorageHarness();
  const original = Db.prototype.collection;
  try {
    const quota = storage.db.collection('quotas');
    vi.spyOn(Db.prototype, 'collection').mockImplementation(function(this: Db, name, options) {
      return name === 'quotas' ? quota : original.call(this, name, options);
    });
    const insert = vi.spyOn(quota, 'updateOne').mockRejectedValueOnce(new MongoServerError({ code: 11000, message: 'Synthetic concurrent initialization' }));
    await expect(ensureCatalogStorage(storage.db)).resolves.toBeUndefined();
    insert.mockRejectedValueOnce(new Error('Synthetic storage fault'));
    await expect(ensureCatalogStorage(storage.db)).rejects.toThrow('Synthetic storage fault');
    insert.mockRejectedValueOnce(new MongoServerError({ code: 91, message: 'Synthetic shutdown' }));
    await expect(ensureCatalogStorage(storage.db)).rejects.toMatchObject({ code: 91 });
  } finally { vi.restoreAllMocks(); await storage.close(); }
});

