import { expect, it } from 'vitest';
import { CatalogSchema, listDirectoryCards, type Catalog } from '../../lib/catalog';
import { catalogs } from '../fixtures/catalogs';
import { createStorageHarness } from './http-harness';
import { randomUUID } from 'node:crypto';

it('returns only enabled and currently ready catalog cards with configured safe display fields', async () => {
  const storage = await createStorageHarness();
  try {
    const records = catalogs.map(item => CatalogSchema.parse(item));
    records[2].enabled = false;
    records[1].accessState = 'blocked';
    await storage.db.collection<Catalog>('catalogs').insertMany(records);
    const cards = await listDirectoryCards(storage.db);
    expect(cards).toEqual([
      { slug: 'public-project', title: 'Public Project', publicDescription: 'Configured synthetic directory description.', visibility: 'public', url: '/public-project' },
    ]);
    expect(JSON.stringify(cards)).not.toContain('github');
    expect(JSON.stringify(cards)).not.toContain('repositoryId');
  } finally { await storage.close(); }
});

it('distinguishes an empty catalog from storage failure and exposes no private source-derived metadata', async () => {
  const storage = await createStorageHarness();
  try {
    expect(await listDirectoryCards(storage.db)).toEqual([]);
    const privateRecord = CatalogSchema.parse(catalogs[1]);
    await storage.db.collection<Catalog>('catalogs').insertOne(privateRecord);
    const cards = await listDirectoryCards(storage.db);
    expect(cards).toMatchObject([{ title: 'Restricted One', visibility: 'private', publicDescription: 'Configured synthetic directory description.' }]);
    expect(JSON.stringify(cards)).not.toContain('SYNTHETIC_PRIVATE_ONE_BODY');
    await storage.client.close();
    await expect(listDirectoryCards(storage.db)).rejects.toThrow();
  } finally { await storage.client.connect(); await storage.close(); }
});

it('caps the safe directory projection at the configured catalog limit', async () => {
  const storage = await createStorageHarness();
  try {
    const records = Array.from({ length: 25 }, (_, index) => {
      const slug = `public-${index}`;
      return CatalogSchema.parse({ ...catalogs[0], _id: randomUUID(), slug, title: `Project ${index}`,
        github: { ...catalogs[0].github, repositoryId: index + 10, name: slug }, readerRole: `docs:${slug}:reader` });
    });
    await storage.db.collection<Catalog>('catalogs').insertMany(records);
    expect(await listDirectoryCards(storage.db)).toHaveLength(20);
  } finally { await storage.close(); }
});
