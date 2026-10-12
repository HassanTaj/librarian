import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogs } from '../fixtures/catalogs';
import { CatalogSchema, type Catalog } from '../../lib/catalog';
import { generationRoot } from '../../lib/content/paths';
import { createStorageHarness } from './http-harness';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function seedRuntimeCatalog(visibility: 'public' | 'private' = 'public') {
  const storage = await createStorageHarness();
  const catalog = CatalogSchema.parse({ ...catalogs[0], visibility, approvalRef: visibility === 'public' ? catalogs[0].approvalRef : null });
  const generationId = randomUUID();
  const root = generationRoot(storage.contentRoot, catalog._id, generationId);
  const content = new Map<string, Buffer>([
    ['index.md', Buffer.from('---\n{"title":"Synthetic Portal"}\n---\n# Synthetic Portal\n\nRead the [setup guide](guides/setup.md).\n\n![Synthetic pixel](pixel.png)')],
    ['guides/setup.md', Buffer.from('---\n{"title":"Setup","description":"Safe setup notes"}\n---\n# Setup\n\nFixture content.')],
    ['guides/meta.json', Buffer.from('{"title":"Guides","defaultOpen":true}')],
    ['pixel.png', await readFile('tests/fixtures/content/public-project/pixel.png')],
    ['notes.txt', Buffer.from('Synthetic attachment')],
  ]);
  await mkdir(join(root, 'guides'), { recursive: true });
  for (const [path, bytes] of content) await writeFile(join(root, path), bytes);
  await writeFile(join(root, 'draft.md'), '# Unlisted draft');
  const manifest = {
    formatVersion: 1, complete: true, catalogId: catalog._id, configRevision: 1, generationId,
    commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), fence: 1, completedAt: new Date().toISOString(), normalizedBytes: 50_000,
    documents: [
      { path: 'index.md', route: '', title: 'Synthetic Portal', description: '', headings: [], links: [{ href: 'guides/setup.md', image: false }], size: content.get('index.md')!.length, sha256: digest(content.get('index.md')!) },
      { path: 'guides/setup.md', route: 'guides/setup', title: 'Setup', description: 'Safe setup notes', headings: [], links: [], size: content.get('guides/setup.md')!.length, sha256: digest(content.get('guides/setup.md')!) },
    ],
    assets: [
      { path: 'pixel.png', size: content.get('pixel.png')!.length, sha256: digest(content.get('pixel.png')!), mime: 'image/png', inline: true },
      { path: 'notes.txt', size: content.get('notes.txt')!.length, sha256: digest(content.get('notes.txt')!), mime: 'text/plain', inline: false },
    ],
    metadata: [{ path: 'guides/meta.json', size: content.get('guides/meta.json')!.length, sha256: digest(content.get('guides/meta.json')!) }],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(root, 'manifest.json'), bytes);
  catalog.published = { generationId, commitSha: manifest.commitSha, jobId: `manual:${catalog._id}:${randomUUID()}`, fence: 1,
    configRevision: 1, manifestDigest: digest(bytes), publishedAt: new Date() };
  catalog.publicationRevision = 1;
  catalog.leaseFence = 1;
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
  return { ...storage, catalog, generationId, root, manifest, content };
}
