import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { newCatalogRecord, type Catalog } from '../../lib/catalog';
import { prepareGenerationRoom, publishGeneration, stageGeneration, pinGeneration } from '../../lib/content/generations';
import { generationRoot } from '../../lib/content/paths';
import { LIMITS } from '../../lib/limits';
import { createStorageHarness } from './http-harness';

const commit = (letter: string) => letter.repeat(40);

it('preserves pinned/grace-protected generations and reclaims the oldest before publishing', async () => {
  const storage = await createStorageHarness();
  const catalog = newCatalogRecord({ github: { repositoryId: 951, installationId: 852, owner: 'synthetic', name: 'retention', branch: 'main', docsPath: 'docs' },
    slug: 'retention-fixture', title: 'Retention fixture', visibility: 'private' });
  catalog.accessState = 'ready';
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
  const generations: string[] = [];

  async function publish(index: number) {
    const owner = randomUUID();
    const fence = index;
    const jobId = `manual:${catalog._id}:${randomUUID()}`;
    const now = new Date();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: {
      leaseFence: fence, lease: { owner, fence, heartbeatAt: now, expiresAt: new Date(now.getTime() + 60_000) },
    } });
    const used = await prepareGenerationRoom(storage.db, storage.contentRoot, {
      catalogId: catalog._id, configRevision: 1, owner, fence,
    });
    const staged = await stageGeneration(storage.contentRoot, { catalogId: catalog._id, configRevision: 1,
      owner, fence, jobId, commitSha: commit(['a', 'b', 'c', 'd'][index - 1]!), treeSha: commit(['e', 'f', 'a', 'b'][index - 1]!),
      files: [{ path: 'index.md', mode: '100644', content: Buffer.from(`# Version ${index}\n\nSynthetic.`) }] }, used);
    const current = await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id });
    await publishGeneration(storage.db, storage.contentRoot, staged, { catalogId: catalog._id, configRevision: 1,
      owner, fence, jobId, publicationRevision: current!.publicationRevision });
    generations.push(staged.manifest.generationId);
  }

  try {
    await publish(1);
    await publish(2);
    await publish(3);
    const readerPin = await pinGeneration(storage.db, { catalogId: catalog._id, configRevision: 1,
      authEpoch: 1, generationId: generations[0] });
    const catalogRoot = join(storage.contentRoot, catalog._id);
    const orphanGeneration = randomUUID();
    await mkdir(generationRoot(storage.contentRoot, catalog._id, orphanGeneration), { recursive: true });
    const staleStaging = join(catalogRoot, `staging-${randomUUID()}-1`);
    await mkdir(staleStaging);

    const owner = randomUUID();
    const fence = 4;
    const now = new Date();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: {
      leaseFence: fence, lease: { owner, fence, heartbeatAt: now, expiresAt: new Date(now.getTime() + 60_000) },
    } });
    const request = { catalogId: catalog._id, configRevision: 1, owner, fence };
    await expect(prepareGenerationRoom(storage.db, storage.contentRoot, request)).rejects.toThrow('retention_pressure');
    await expect(access(staleStaging)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(generationRoot(storage.contentRoot, catalog._id, orphanGeneration))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id }))?.retained)
      .toHaveLength(LIMITS.maxRetainedGenerations);
    await access(generationRoot(storage.contentRoot, catalog._id, generations[0]));

    await readerPin.release();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id, 'retained.generationId': generations[0] }, {
      $set: { 'retained.$.retiredAt': new Date(Date.now() - LIMITS.retainedGraceMs - 1000) },
    });
    await rm(generationRoot(storage.contentRoot, catalog._id, generations[0]), { recursive: true, force: true });
    const used = await prepareGenerationRoom(storage.db, storage.contentRoot, request);
    const staged = await stageGeneration(storage.contentRoot, { catalogId: catalog._id, configRevision: 1,
      owner, fence, jobId: `manual:${catalog._id}:${randomUUID()}`, commitSha: commit('d'), treeSha: commit('e'),
      files: [{ path: 'index.md', mode: '100644', content: Buffer.from('# Version 4\n\nSynthetic.') }] }, used);
    const current = await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id });
    await publishGeneration(storage.db, storage.contentRoot, staged, { catalogId: catalog._id, configRevision: 1,
      owner, fence, jobId: staged.jobId, publicationRevision: current!.publicationRevision });

    await expect(access(generationRoot(storage.contentRoot, catalog._id, generations[0]))).rejects.toMatchObject({ code: 'ENOENT' });
    const result = await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id });
    expect(result?.published?.generationId).toBe(staged.manifest.generationId);
    expect(result?.retained.map(pointer => pointer.generationId)).toEqual([generations[2], generations[1]]);
    expect(await readdir(join(catalogRoot, 'generations'))).toHaveLength(LIMITS.maxCommittedGenerations);
  } finally { await storage.close(); }
});

it('fails closed for lost leases, unavailable roots, active staging, and unknown generation entries', async () => {
  const storage = await createStorageHarness();
  const catalog = newCatalogRecord({ github: { repositoryId: 952, installationId: 853, owner: 'synthetic', name: 'room', branch: 'main', docsPath: 'docs' },
    slug: 'room-fixture', title: 'Room fixture', visibility: 'private' });
  catalog.accessState = 'ready';
  const owner = randomUUID();
  const fence = 1;
  const lease = { owner, fence, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
  const request = { catalogId: catalog._id, configRevision: 1, owner, fence };
  const collection = storage.db.collection<Catalog>('catalogs');
  await collection.insertOne(catalog);
  try {
    await expect(prepareGenerationRoom(storage.db, storage.contentRoot, request)).rejects.toThrow('sync_lease_lost');
    await collection.updateOne({ _id: catalog._id }, { $set: { leaseFence: fence, lease } });
    expect(await prepareGenerationRoom(storage.db, storage.contentRoot, request)).toBe(0);
    await expect(prepareGenerationRoom(storage.db, join(storage.root, 'missing-content'), request)).rejects.toThrow('generation_storage_unavailable');

    const catalogRoot = join(storage.contentRoot, catalog._id);
    const activeStaging = join(catalogRoot, `staging-${owner}-${fence}`);
    await mkdir(activeStaging, { recursive: true });
    await expect(prepareGenerationRoom(storage.db, storage.contentRoot, request)).rejects.toThrow('retention_pressure');
    await rm(activeStaging, { recursive: true });

    const stray = join(catalogRoot, 'unexpected.txt');
    await writeFile(stray, 'preserve this unknown entry');
    await expect(prepareGenerationRoom(storage.db, storage.contentRoot, request)).rejects.toThrow('generation_invalid_path');
    await rm(stray);

    const unexpectedGeneration = join(catalogRoot, 'generations', 'not-a-generation-id');
    await mkdir(unexpectedGeneration, { recursive: true });
    await expect(prepareGenerationRoom(storage.db, storage.contentRoot, request)).rejects.toThrow('generation_invalid_path');
  } finally { await storage.close(); }
});

it('validates the active manifest before including a published generation in retention accounting', async () => {
  const storage = await createStorageHarness();
  const catalog = newCatalogRecord({ github: { repositoryId: 953, installationId: 854, owner: 'synthetic', name: 'room', branch: 'main', docsPath: 'docs' },
    slug: 'pointer-fixture', title: 'Pointer fixture', visibility: 'private' });
  const firstOwner = randomUUID();
  const firstFence = 1;
  const firstJob = `manual:${catalog._id}:${randomUUID()}`;
  catalog.accessState = 'ready';
  catalog.leaseFence = firstFence;
  catalog.lease = { owner: firstOwner, fence: firstFence, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
  const collection = storage.db.collection<Catalog>('catalogs');
  await collection.insertOne(catalog);
  try {
    const staged = await stageGeneration(storage.contentRoot, { catalogId: catalog._id, configRevision: 1,
      owner: firstOwner, fence: firstFence, jobId: firstJob, commitSha: commit('a'), treeSha: commit('b'),
      files: [{ path: 'index.md', mode: '100644', content: Buffer.from('# Published') }] });
    await publishGeneration(storage.db, storage.contentRoot, staged, { catalogId: catalog._id, configRevision: 1,
      owner: firstOwner, fence: firstFence, jobId: firstJob, publicationRevision: 0 });

    const nextOwner = randomUUID();
    const nextFence = 2;
    await collection.updateOne({ _id: catalog._id }, { $set: { leaseFence: nextFence,
      lease: { owner: nextOwner, fence: nextFence, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } } });
    const published = (await collection.findOne({ _id: catalog._id }))!.published!;
    await collection.updateOne({ _id: catalog._id }, { $set: { 'published.commitSha': commit('f') } });
    await expect(prepareGenerationRoom(storage.db, storage.contentRoot, { catalogId: catalog._id,
      configRevision: 1, owner: nextOwner, fence: nextFence })).rejects.toThrow('generation_storage_unavailable');
    await collection.updateOne({ _id: catalog._id }, { $set: { published } });
    await writeFile(join(staged.root, 'manifest.json'), '{}');
    await expect(prepareGenerationRoom(storage.db, storage.contentRoot, { catalogId: catalog._id,
      configRevision: 1, owner: nextOwner, fence: nextFence })).rejects.toThrow('generation_storage_unavailable');
  } finally { await storage.close(); }
});
