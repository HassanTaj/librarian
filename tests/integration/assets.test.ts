import { expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAsset } from '../../lib/content/assets';
import type { Catalog } from '../../lib/catalog';
import { seedRuntimeCatalog } from './runtime-fixtures';

it('reads raster images and attachments only through the selected manifest mapping', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    const image = await readAsset(storage.db, storage.contentRoot, storage.catalog.slug, undefined, 'pixel.png');
    expect(image).toMatchObject({ mime: 'image/png', inline: true, filename: 'pixel.png' });
    expect(image.bytes).toEqual(storage.content.get('pixel.png'));
    const attachment = await readAsset(storage.db, storage.contentRoot, storage.catalog.slug, undefined, 'notes.txt');
    expect(attachment).toMatchObject({ mime: 'text/plain', inline: false, filename: 'notes.txt' });
    expect(attachment.bytes.toString()).toBe('Synthetic attachment');
    await expect(readAsset(storage.db, storage.contentRoot, storage.catalog.slug, undefined, 'draft.md')).rejects.toThrow('not_found');
  } finally { await storage.close(); }
});

it('rejects changed bytes and releases the generation pin after an asset failure', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    await writeFile(join(storage.root, 'notes.txt'), 'Xynthetic attachment');
    await expect(readAsset(storage.db, storage.contentRoot, storage.catalog.slug, undefined, 'notes.txt')).rejects.toThrow('invalid_content');
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id }))?.readPins).toHaveLength(0);
  } finally { await storage.close(); }
});

it('sanitizes a missing mapped asset and releases its read pin', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    await rm(join(storage.root, 'notes.txt'));
    await expect(readAsset(storage.db, storage.contentRoot, storage.catalog.slug, undefined, 'notes.txt')).rejects.toThrow('invalid_content');
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id }))?.readPins).toHaveLength(0);
  } finally { await storage.close(); }
});

it('denies a private asset before opening even a missing snapshot file', async () => {
  const storage = await seedRuntimeCatalog('private');
  try {
    await rm(join(storage.root, 'notes.txt'));
    await expect(readAsset(storage.db, storage.contentRoot, storage.catalog.slug, undefined, 'notes.txt')).rejects.toThrow('unauthorized');
  } finally { await storage.close(); }
});
