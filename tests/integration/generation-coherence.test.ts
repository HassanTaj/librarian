import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Catalog } from '../../lib/catalog';
import { readAsset } from '../../lib/content/assets';
import type { Manifest } from '../../lib/content/generations';
import { generationRoot } from '../../lib/content/paths';
import { searchContent } from '../../lib/content/search';
import { withRuntimeContent } from '../../lib/content/source';
import { seedRuntimeCatalog } from './runtime-fixtures';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function publishReplacement(storage: Awaited<ReturnType<typeof seedRuntimeCatalog>>) {
  const generationId = randomUUID();
  const root = generationRoot(storage.contentRoot, storage.catalog._id, generationId);
  const content = new Map(storage.content);
  content.set('index.md', Buffer.from(content.get('index.md')!.toString().replaceAll('Synthetic Portal', 'Synthetic Latest')));
  content.set('guides/setup.md', Buffer.from('---\n{"title":"Setup","description":"Safe setup notes"}\n---\n# Setup\n\nUpdated publication.'));
  content.set('notes.txt', Buffer.from('Updated attachment'));
  await mkdir(join(root, 'guides'), { recursive: true });
  for (const [path, bytes] of content) await writeFile(join(root, path), bytes);

  const manifest = structuredClone(storage.manifest) as Manifest;
  Object.assign(manifest, { generationId, commitSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), fence: 2, completedAt: new Date().toISOString() });
  manifest.documents = manifest.documents.map(file => {
      const bytes = content.get(file.path)!;
      return { ...file, ...(file.path === 'index.md' ? { title: 'Synthetic Latest' } : {}), size: bytes.length, sha256: digest(bytes) };
    });
  manifest.assets = manifest.assets.map(file => {
      const bytes = content.get(file.path)!;
      return { ...file, size: bytes.length, sha256: digest(bytes) };
    });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(root, 'manifest.json'), manifestBytes);
  const previous = storage.catalog.published!;
  const published = { ...previous, generationId, commitSha: manifest.commitSha, fence: 2,
    jobId: `manual:${storage.catalog._id}:${randomUUID()}`, manifestDigest: digest(manifestBytes), publishedAt: new Date() };
  await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, {
    $set: { retained: [{ ...previous, retiredAt: new Date() }], published, leaseFence: 2 },
    $inc: { publicationRevision: 1 },
  });
  return generationId;
}

it('keeps article, search and asset reads on one pinned generation across publication', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    const oldGeneration = storage.generationId;
    const currentRead = await withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async content => {
      const oldPage = content.loader.getPage(undefined)!;
      const newGeneration = await publishReplacement(storage);
      const oldSearch = await searchContent(content, 'Fixture content');
      expect(oldSearch.every(result => result.url.includes(`g=${oldGeneration}`))).toBe(true);
      return { title: oldPage.data.title, generation: content.manifest.generationId, newGeneration };
    });
    expect(currentRead).toMatchObject({ title: 'Synthetic Portal', generation: oldGeneration });

    const next = await withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async content => ({
      title: content.loader.getPage(undefined)!.data.title,
      generation: content.manifest.generationId,
      results: await searchContent(content, 'Updated publication'),
    }));
    expect(next.title).toBe('Synthetic Latest');
    expect(next.generation).toBe(currentRead.newGeneration);
    expect(next.results.length).toBeGreaterThan(0);
    expect(next.results.every(result => result.url.includes(`g=${currentRead.newGeneration}`))).toBe(true);

    const retained = await withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, oldGeneration, async content => ({
      title: content.loader.getPage(undefined)!.data.title,
      results: await searchContent(content, 'Fixture content'),
    }));
    expect(retained.title).toBe('Synthetic Portal');
    expect(retained.results.every(result => result.url.includes(`g=${oldGeneration}`))).toBe(true);
    await expect(readAsset(storage.db, storage.contentRoot, storage.catalog.slug, oldGeneration, 'notes.txt'))
      .resolves.toMatchObject({ bytes: storage.content.get('notes.txt') });
    await expect(readAsset(storage.db, storage.contentRoot, storage.catalog.slug, currentRead.newGeneration, 'notes.txt'))
      .resolves.toMatchObject({ bytes: Buffer.from('Updated attachment') });

    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: { retained: [] } });
    await expect(withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, oldGeneration, async () => 'must not mix'))
      .rejects.toThrow('reload_required');
  } finally { await storage.close(); }
});
