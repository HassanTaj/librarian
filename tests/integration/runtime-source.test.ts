import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Catalog } from '../../lib/catalog';
import { getMDXComponents } from '../../mdx-components';
import { searchContent } from '../../lib/content/search';
import { withRuntimeContent } from '../../lib/content/source';
import { validateMarkdown } from '../../lib/content/validate';
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

it('renders validated safe Fumadocs MDX components through the guarded loader', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    const path = 'guides/quickstart.mdx';
    const parsed = validateMarkdown(path, Buffer.from('# Safe MDX\n\n<Info>Heads up</Info>\n\n<Note>Keep this in mind.</Note>\n\n<Warning>Use caution.</Warning>\n\n<Columns cols={2}><Card title="Quickstart" icon="book" href="/guides/quickstart">Runtime **MDX** content.</Card></Columns>\n\n<Card title="Overview">No destination card.</Card>\n\n<Steps><Step title="One">Begin here.</Step></Steps>'));
    const bytes = Buffer.from(parsed.markdown);
    const manifest = {
      ...storage.manifest,
      documents: [...storage.manifest.documents, { path, route: 'guides/quickstart', title: parsed.title,
        description: '', headings: parsed.headings, links: parsed.links, size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
    await writeFile(join(storage.root, path), bytes);
    await writeFile(join(storage.root, 'manifest.json'), manifestBytes);
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: { 'published.manifestDigest': manifestDigest } });

    const output = await withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async ({ loader }) => {
      const page = loader.getPages().find(item => item.path === path)!;
      const rendered = await page.data.load();
      return { url: page.url, body: renderToStaticMarkup((await rendered.render(getMDXComponents())).body) };
    });
    expect(output.url).toContain('/public-project/guides/quickstart');
    expect(output.body).toContain('id="safe-mdx"');
    expect(output.body).toContain('Safe MDX');
    expect(output.body).toContain('Heads up');
    expect(output.body).toContain('Keep this in mind.');
    expect(output.body).toContain('Use caution.');
    expect(output.body).toContain('Quickstart');
    expect(output.body).toContain('Runtime <strong>MDX</strong> content.');
    expect(output.body).toContain('No destination card.');
    expect(output.body).toContain('Begin here.');
  } finally { await storage.close(); }
});

it('reports only numeric cache high-water bytes when workload metrics are opted in', async () => {
  vi.stubEnv('LIBRARIAN_WORKLOAD_METRICS', '0');
  const unmeasured = await seedRuntimeCatalog();
  const measured = await seedRuntimeCatalog();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const privateMarker = 'PRIVATE-SYNTHETIC-CONTENT';
  try {
    await withRuntimeContent(unmeasured.db, unmeasured.contentRoot, unmeasured.catalog.slug, undefined, async () => privateMarker);
    expect(log).not.toHaveBeenCalled();

    vi.stubEnv('LIBRARIAN_WORKLOAD_METRICS', '1');
    const result = await withRuntimeContent(measured.db, measured.contentRoot, measured.catalog.slug, undefined, async content => {
      await searchContent(content, 'setup');
      return privateMarker;
    });
    expect(result).toBe(privateMarker);
    expect(log).toHaveBeenCalledTimes(2);
    const values = log.mock.calls.map(([event, ...extra]) => {
      expect(extra).toHaveLength(0);
      expect(typeof event).toBe('string');
      expect(event).toMatch(/^LIBRARIAN_CACHE_PEAK_BYTES=\d+$/);
      expect(event).not.toContain(privateMarker);
      expect(event).not.toContain(measured.catalog.slug);
      const bytes = Number((event as string).slice('LIBRARIAN_CACHE_PEAK_BYTES='.length));
      expect(Number.isSafeInteger(bytes)).toBe(true);
      expect(bytes).toBeGreaterThan(0);
      return bytes;
    });
    expect(values[1]).toBeGreaterThan(values[0]);
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
    await Promise.all([unmeasured.close(), measured.close()]);
  }
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
