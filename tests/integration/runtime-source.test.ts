import { expect, it } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { withRuntimeContent } from '../../lib/content/source';
import { seedRuntimeCatalog } from './runtime-fixtures';

it('renders only checked manifest files and creates an immutable generation-specific source tree', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    const output = await withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async ({ manifest, loader }) => {
      const pages = loader.getPages();
      const home = loader.getPage([])!;
      const rendered = await home.data.load();
      return { manifest, paths: pages.map(page => page.path), urls: pages.map(page => page.url),
        rendered: renderToStaticMarkup((await rendered.render()).body), source: home.data.content,
        structured: rendered.structuredData, tree: loader.pageTree };
    });
    expect(output.paths).toHaveLength(2);
    expect(output.paths).not.toContain('draft.md');
    expect(output.urls).toContain(`/public-project?g=${storage.generationId}`);
    expect(output.urls).toContain(`/public-project/guides/setup?g=${storage.generationId}`);
    expect(output.source).toContain('[setup guide]');
    expect(output.structured.headings).toContainEqual({ id: 'synthetic-portal', content: 'Synthetic Portal' });
    expect(output.structured.contents.map(item => item.content).join(' ')).toContain('Read the setup guide.');
    expect(output.rendered).toContain('<h1 id="synthetic-portal">Synthetic Portal</h1>');
    expect(output.rendered).toContain('Read the');
    expect(JSON.stringify(output.tree)).toContain('Guides');
    expect(output.manifest.generationId).toBe(storage.generationId);
  } finally { await storage.close(); }
});

it('denies private catalogs before reading even a missing generation manifest', async () => {
  const storage = await seedRuntimeCatalog('private');
  try {
    await rm(join(storage.root, 'manifest.json'));
    await expect(withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async () => 'private body'))
      .rejects.toThrow('unauthorized');
  } finally { await storage.close(); }
});

it('rejects a document whose bytes no longer match the selected manifest', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    const file = storage.manifest.documents.find(document => document.path === 'index.md')!;
    await writeFile(join(storage.root, 'index.md'), Buffer.alloc(file.size, 120));
    await expect(withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async () => 'tampered body'))
      .rejects.toThrow('invalid_content');
  } finally { await storage.close(); }
});

it('maps a missing manifest-listed file to a safe invalid-content result', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    await rm(join(storage.root, 'index.md'));
    await expect(withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async () => 'missing body'))
      .rejects.toThrow('invalid_content');
  } finally { await storage.close(); }
});
