import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { newCatalogRecord, type Catalog } from '../../lib/catalog';
import { publishGeneration, stageGeneration } from '../../lib/content/generations';
import { GitHubError } from '../../lib/sync/github';
import { candidateManifestDigest } from '../../lib/public-approvals';
import { admitSyncJob, claimNextSyncJob, newManualJobId, reconcilePublishedSyncJobs, setSyncTargetCommit, type SyncJob } from '../../lib/sync/jobs';
import { processNextSyncJob } from '../../lib/sync/worker';
import { createStorageHarness } from './http-harness';

const commit = (letter: string) => letter.repeat(40);
const content = (title: string) => Buffer.from(`# ${title}\n\nSynthetic document.`);

async function setup() {
  const storage = await createStorageHarness();
  const catalog = newCatalogRecord({ github: { repositoryId: 812, installationId: 913, owner: 'synthetic', name: 'worker', branch: 'main', docsPath: 'docs' },
    slug: 'worker-fixture', title: 'Worker fixture', visibility: 'private' });
  catalog.accessState = 'ready';
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
  const admitted = await admitSyncJob(storage.db, { _id: newManualJobId(catalog._id, randomUUID()), catalogId: catalog._id,
    origin: 'manual', event: 'manual', payloadDigest: 'a'.repeat(64) });
  return { ...storage, catalog, job: admitted.job };
}

it('fetches, validates, stages, publishes and completes one durable job', async () => {
  const storage = await setup();
  try {
    const result = await processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot,
      readCandidate: async () => ({ commitSha: commit('b'), treeSha: commit('c'),
        files: [{ path: 'index.md', mode: '100644', content: content('Published') }] }) });
    expect(result).toBe('succeeded');
    const [catalog, job] = await Promise.all([
      storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id }),
      storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id }),
    ]);
    expect(catalog).toMatchObject({ published: { jobId: storage.job._id, commitSha: commit('b'), fence: 1 },
      lease: null, lastSuccess: { jobId: storage.job._id, commitSha: commit('b') } });
    expect(job).toMatchObject({ state: 'succeeded', attempts: 1, targetCommit: commit('b'),
      generationId: catalog?.published?.generationId, result: { kind: 'published', commitSha: commit('b') } });
    expect((await readFile(join(storage.contentRoot, storage.catalog._id, 'generations', catalog!.published!.generationId, 'index.md'))).toString())
      .toContain('Published');
  } finally { await storage.close(); }
});

it('retries transient provider failures and preserves the last good publication', async () => {
  const storage = await setup();
  try {
    expect(await processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot,
      readCandidate: async () => ({ commitSha: commit('a'), treeSha: commit('b'),
        files: [{ path: 'index.md', mode: '100644', content: content('Existing publication') }] }) })).toBe('succeeded');
    const previous = await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id });
    const retryJob = (await admitSyncJob(storage.db, { _id: newManualJobId(storage.catalog._id, randomUUID()),
      catalogId: storage.catalog._id, origin: 'manual', event: 'manual', payloadDigest: 'c'.repeat(64) })).job;

    const first = await processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot,
      readCandidate: async () => { throw new GitHubError('github_unavailable'); } });
    expect(first).toBe('retry_wait');
    const pending = await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: retryJob._id });
    expect(pending).toMatchObject({ state: 'retry_wait', attempts: 1, owner: null });
    expect(pending!.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id })).toMatchObject({
      lastFailure: { code: 'github_unavailable' }, published: { generationId: previous?.published?.generationId },
    });

    await storage.db.collection<SyncJob>('syncJobs').updateOne({ _id: retryJob._id }, { $set: { availableAt: new Date(0) } });
    const retry = await processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot,
      readCandidate: async () => ({ commitSha: commit('d'), treeSha: commit('e'),
        files: [{ path: 'index.md', mode: '100644', content: content('Recovered') }] }) });
    expect(retry).toBe('succeeded');
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: retryJob._id })).toMatchObject({ state: 'succeeded', attempts: 2 });
  } finally { await storage.close(); }
});

it('fails invalid content without publishing it', async () => {
  const storage = await setup();
  try {
    const result = await processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot,
      readCandidate: async () => ({ commitSha: commit('f'), treeSha: commit('a'),
        files: [{ path: 'unsafe.js', mode: '100644', content: Buffer.from('not executable') },
          { path: 'index.md', mode: '100644', content: content('Never published') }] }) });
    expect(result).toBe('failed');
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id })).toMatchObject({
      state: 'failed', result: { kind: 'failure', code: 'invalid_content' }, owner: null,
    });
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id }))?.published).toBeNull();
  } finally { await storage.close(); }
});

it('requires the owner-reviewed initial public candidate and only allows approved future commits', async () => {
  const storage = await setup();
  try {
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: {
      visibility: 'public', approvalRef: 'worker-owner-review',
    } });
    const approvalPath = join(storage.root, 'public-approvals.json');
    const firstCandidate = { commitSha: commit('b'), treeSha: commit('c'), files: [{ path: 'index.md', mode: '100644', content: content('Reviewed') }] };
    const writeApproval = async (allowFutureUpdates: boolean) => writeFile(approvalPath, JSON.stringify({ formatVersion: 1, approvals: [{
      approvalId: 'worker-owner-review', version: 1, approvedAt: '2026-10-12T00:00:00.000Z', ownerReference: 'synthetic-ticket',
      repositoryId: storage.catalog.github.repositoryId, branch: storage.catalog.github.branch, docsPath: storage.catalog.github.docsPath,
      slug: storage.catalog.slug, reviewedCommit: firstCandidate.commitSha, candidateManifestDigest: candidateManifestDigest(firstCandidate.files), allowFutureUpdates,
    }] }));
    await writeApproval(true);
    const first = await processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot, publicCatalogApprovalsFile: approvalPath,
      readCandidate: async () => firstCandidate });
    expect(first).toBe('succeeded');

    const futureJob = (await admitSyncJob(storage.db, { _id: newManualJobId(storage.catalog._id, randomUUID()),
      catalogId: storage.catalog._id, origin: 'manual', event: 'manual', payloadDigest: 'c'.repeat(64) })).job;
    const future = { commitSha: commit('d'), treeSha: commit('e'), files: [{ path: 'index.md', mode: '100644', content: content('Approved update') }] };
    expect(await processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot, publicCatalogApprovalsFile: approvalPath,
      readCandidate: async () => future })).toBe('succeeded');
    const published = await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id });
    expect(published?.published?.commitSha).toBe(future.commitSha);
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: futureJob._id })).toMatchObject({ state: 'succeeded' });

    await writeApproval(false);
    const deniedJob = (await admitSyncJob(storage.db, { _id: newManualJobId(storage.catalog._id, randomUUID()),
      catalogId: storage.catalog._id, origin: 'manual', event: 'manual', payloadDigest: 'd'.repeat(64) })).job;
    const unapproved = { commitSha: commit('f'), treeSha: commit('1'), files: [{ path: 'index.md', mode: '100644', content: content('Unapproved update') }] };
    expect(await processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot, publicCatalogApprovalsFile: approvalPath,
      readCandidate: async () => unapproved })).toBe('failed');
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: deniedJob._id })).toMatchObject({
      state: 'failed', result: { kind: 'failure', code: 'public_approval_required' },
    });
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id }))?.published?.commitSha).toBe(future.commitSha);
  } finally { await storage.close(); }
});

it('reconciles the permanent receipt after publication and before retrying a terminal write', async () => {
  const storage = await setup();
  try {
    const claim = await claimNextSyncJob(storage.db, randomUUID());
    expect(claim).toBeTruthy();
    await setSyncTargetCommit(storage.db, claim!, commit('1'));
    const staged = await stageGeneration(storage.contentRoot, { catalogId: claim!.catalogId, configRevision: claim!.configRevision,
      owner: claim!.owner, fence: claim!.fence, jobId: claim!.job._id, commitSha: commit('1'), treeSha: commit('2'),
      files: [{ path: 'index.md', mode: '100644', content: content('Crash gap') }] });
    await publishGeneration(storage.db, storage.contentRoot, staged, { catalogId: claim!.catalogId,
      configRevision: claim!.configRevision, owner: claim!.owner, fence: claim!.fence, jobId: claim!.job._id,
      publicationRevision: claim!.publicationRevision });
    expect(await reconcilePublishedSyncJobs(storage.db)).toBe(1);
    expect(await reconcilePublishedSyncJobs(storage.db)).toBe(0);
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: storage.job._id })).toMatchObject({
      state: 'succeeded', generationId: staged.manifest.generationId,
    });
  } finally { await storage.close(); }
});
