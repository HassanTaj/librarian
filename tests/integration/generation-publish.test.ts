import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { newCatalogRecord, type Catalog } from '../../lib/catalog';
import { ManifestSchema, publishGeneration, stageGeneration } from '../../lib/content/generations';
import { generationRoot } from '../../lib/content/paths';
import { LIMITS } from '../../lib/limits';
import { createStorageHarness } from './http-harness';

const commit = (value: string) => value.repeat(40);
const markdown = (title: string) => Buffer.from(`# ${title}\n\nSynthetic body.`);

it('stages complete immutable bytes and atomically publishes with a fenced catalog CAS', async () => {
  const storage = await createStorageHarness();
  const catalog = newCatalogRecord({ github: { repositoryId: 101, installationId: 201, owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs' },
    slug: 'publish-fixture', title: 'Publish fixture', visibility: 'private' });
  const firstOwner = randomUUID();
  const firstJobId = `manual:${catalog._id}:${randomUUID()}`;
  const now = new Date();
  catalog.accessState = 'ready';
  catalog.leaseFence = 1;
  catalog.lease = { owner: firstOwner, fence: 1, heartbeatAt: now, expiresAt: new Date(now.getTime() + 60_000) };
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
  try {
    const first = await stageGeneration(storage.contentRoot, { catalogId: catalog._id, configRevision: 1,
      owner: firstOwner, fence: 1, jobId: firstJobId, commitSha: commit('a'), treeSha: commit('b'),
      files: [{ path: 'index.md', mode: '100644', content: markdown('Initial') }] });
    const firstBytes = await readFile(join(first.root, 'index.md'));
    const manifestBytes = await readFile(join(first.root, 'manifest.json'));
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(first.manifestDigest);
    expect(ManifestSchema.parse(JSON.parse(manifestBytes.toString()))).toMatchObject({
      catalogId: catalog._id, generationId: first.manifest.generationId, normalizedBytes: manifestBytes.length + firstBytes.length,
      documents: [{ headings: [{ id: 'initial', depth: 1 }] }],
    });
    expect(await readdir(join(storage.contentRoot, catalog._id))).toEqual(['generations']);

    const publishedFirst = await publishGeneration(storage.db, storage.contentRoot, first, {
      catalogId: catalog._id, configRevision: 1, owner: firstOwner, fence: 1, jobId: firstJobId, publicationRevision: 0,
    });
    expect(publishedFirst).toMatchObject({ published: { generationId: first.manifest.generationId }, publicationRevision: 1,
      lastSuccess: { jobId: firstJobId, commitSha: commit('a') }, lease: null });

    const secondOwner = randomUUID();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: {
      leaseFence: 2, lease: { owner: secondOwner, fence: 2, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
    } });
    const secondJobId = `manual:${catalog._id}:${randomUUID()}`;
    const second = await stageGeneration(storage.contentRoot, { catalogId: catalog._id, configRevision: 1,
      owner: secondOwner, fence: 2, jobId: secondJobId, commitSha: commit('c'), treeSha: commit('d'),
      files: [{ path: 'index.md', mode: '100644', content: markdown('Updated') }] });
    const publishedSecond = await publishGeneration(storage.db, storage.contentRoot, second, {
      catalogId: catalog._id, configRevision: 1, owner: secondOwner, fence: 2, jobId: secondJobId, publicationRevision: 1,
    });
    expect(publishedSecond).toMatchObject({ published: { generationId: second.manifest.generationId }, publicationRevision: 2,
      retained: [{ generationId: first.manifest.generationId, retiredAt: expect.any(Date) }] });

    const staleJobId = `manual:${catalog._id}:${randomUUID()}`;
    const stale = await stageGeneration(storage.contentRoot, { catalogId: catalog._id, configRevision: 1,
      owner: secondOwner, fence: 2, jobId: staleJobId, commitSha: commit('e'), treeSha: commit('f'),
      files: [{ path: 'index.md', mode: '100644', content: markdown('Stale') }] });
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: {
      leaseFence: 3, lease: { owner: randomUUID(), fence: 3, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
    } });
    await expect(publishGeneration(storage.db, storage.contentRoot, stale, {
      catalogId: catalog._id, configRevision: 1, owner: secondOwner, fence: 2, jobId: staleJobId,
      publicationRevision: 2,
    })).rejects.toThrow('publication_conflict');
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id }))?.published?.generationId)
      .toBe(second.manifest.generationId);
    expect(generationRoot(storage.contentRoot, catalog._id, first.manifest.generationId)).toContain(catalog._id);
  } finally { await storage.close(); }
});

it('leaves invalid candidates unpublished and removes their private staging directory', async () => {
  const storage = await createStorageHarness();
  try {
    const catalogId = randomUUID();
    await expect(stageGeneration(storage.contentRoot, { catalogId, configRevision: 1,
      owner: randomUUID(), fence: 1, jobId: `manual:${catalogId}:${randomUUID()}`, commitSha: commit('a'), treeSha: commit('b'),
      files: [{ path: 'script.js', mode: '100644', content: Buffer.from('unsafe') }] })).rejects.toThrow('invalid_content');
    expect(await readdir(storage.contentRoot)).toEqual([]);
  } finally { await storage.close(); }
});

it('rejects invalid staging roots, reserved manifests, and catalog payload overflow', async () => {
  const storage = await createStorageHarness();
  const catalogId = randomUUID();
  const owner = randomUUID();
  const request = { catalogId, configRevision: 1, owner, fence: 1, jobId: `manual:${catalogId}:${randomUUID()}`,
    commitSha: commit('a'), treeSha: commit('b'), files: [{ path: 'index.md', mode: '100644', content: markdown('Safe') }] };
  try {
    await expect(stageGeneration(join(storage.root, 'missing'), request)).rejects.toThrow('generation_storage_unavailable');
    await expect(stageGeneration(storage.contentRoot, request, LIMITS.maxCatalogPayloadBytes + 1)).rejects.toThrow();
    await expect(stageGeneration(storage.contentRoot, request, LIMITS.maxCatalogPayloadBytes)).rejects.toThrow('retention_pressure');
    await expect(stageGeneration(storage.contentRoot, { ...request, files: [...request.files,
      { path: 'manifest.json', mode: '100644', content: Buffer.from('{}') }] })).rejects.toThrow('invalid_content');
    await expect(stageGeneration(join(process.cwd(), 'public'), request)).rejects.toThrow('generation_invalid_path');
    expect(await readdir(join(storage.contentRoot, catalogId))).toEqual([]);
  } finally { await storage.close(); }
});

it('rejects catalog-directory symlinks before writing any staged content outside the storage root', async () => {
  const storage = await createStorageHarness();
  const catalogId = randomUUID();
  const outside = join(storage.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(storage.contentRoot, catalogId), 'junction');
  try {
    await expect(stageGeneration(storage.contentRoot, { catalogId, configRevision: 1, owner: randomUUID(), fence: 1,
      jobId: `manual:${catalogId}:${randomUUID()}`, commitSha: commit('1'), treeSha: commit('2'),
      files: [{ path: 'index.md', mode: '100644', content: markdown('Blocked') }] })).rejects.toThrow('generation_invalid_path');
    expect(await readdir(outside)).toEqual([]);
  } finally { await storage.close(); }
});

it('validates staged metadata and each source file again before the atomic pointer update', async () => {
  const storage = await createStorageHarness();
  const catalog = newCatalogRecord({ github: { repositoryId: 441, installationId: 551, owner: 'synthetic', name: 'verify', branch: 'main', docsPath: 'docs' },
    slug: 'staged-verify', title: 'Staged verify', visibility: 'private' });
  const owner = randomUUID();
  const jobId = `manual:${catalog._id}:${randomUUID()}`;
  catalog.accessState = 'ready';
  catalog.leaseFence = 1;
  catalog.lease = { owner, fence: 1, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
  try {
    const input = { catalogId: catalog._id, configRevision: 1, owner, fence: 1, jobId,
      commitSha: commit('c'), treeSha: commit('d'), files: [{ path: 'index.md', mode: '100644', content: markdown('Verified') }] };
    const staged = await stageGeneration(storage.contentRoot, input);
    const publish = (patch = {}) => publishGeneration(storage.db, storage.contentRoot, staged, {
      catalogId: catalog._id, configRevision: 1, owner, fence: 1, jobId, publicationRevision: 0, ...patch,
    });
    await expect(publish({ owner: randomUUID() })).rejects.toThrow('generation_invalid');
    await expect(publish({ jobId: `manual:${catalog._id}:${randomUUID()}` })).rejects.toThrow('generation_invalid');

    const digest = staged.manifestDigest;
    staged.manifestDigest = 'f'.repeat(64);
    await expect(publish()).rejects.toThrow('generation_invalid');
    staged.manifestDigest = digest;
    await writeFile(join(staged.root, 'index.md'), markdown('Tampered'));
    await expect(publish()).rejects.toThrow('generation_invalid');
    await rm(join(staged.root, 'manifest.json'));
    await expect(publish()).rejects.toThrow('generation_invalid');
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id }))?.published).toBeNull();
  } finally { await storage.close(); }
});

it('stages nested documents, navigation metadata, images, and safe attachments as one complete manifest', async () => {
  const storage = await createStorageHarness();
  const catalogId = randomUUID();
  const owner = randomUUID();
  const png = await readFile('tests/fixtures/content/public-project/pixel.png');
  try {
    const staged = await stageGeneration(storage.contentRoot, { catalogId, configRevision: 1, owner, fence: 1,
      jobId: `manual:${catalogId}:${randomUUID()}`, commitSha: commit('7'), treeSha: commit('8'), files: [
        { path: 'index.md', mode: '100644', content: Buffer.from('# Home\n\n![Pixel](pixel.png)') },
        { path: 'guides/start.md', mode: '100644', content: Buffer.from('# Start') },
        { path: 'guides/meta.json', mode: '100644', content: Buffer.from('{"title":"Guides","pages":["start"]}') },
        { path: 'pixel.png', mode: '100644', content: png },
        { path: 'notes.txt', mode: '100644', content: Buffer.from('Synthetic attachment') },
      ] });
    expect(staged.manifest.documents.map(item => item.path)).toEqual(['index.md', 'guides/start.md']);
    expect(staged.manifest.metadata.map(item => item.path)).toEqual(['guides/meta.json']);
    expect(staged.manifest.assets.map(item => [item.path, item.mime, item.inline])).toEqual([
      ['pixel.png', 'image/png', true], ['notes.txt', 'text/plain', false],
    ]);
    expect((await readFile(join(staged.root, 'guides/start.md'))).toString()).toContain('# Start');
    expect((await readFile(join(staged.root, 'guides/meta.json'))).toString()).toContain('Guides');
    expect((await readFile(join(staged.root, 'pixel.png'))).equals(png)).toBe(true);
  } finally { await storage.close(); }
});
