import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Catalog } from '../../lib/catalog';
import { readAsset } from '../../lib/content/assets';
import { searchContent } from '../../lib/content/search';
import { withRuntimeContent } from '../../lib/content/source';
import { candidateManifestDigest } from '../../lib/public-approvals';
import { admitSyncJob, newManualJobId, type SyncJob } from '../../lib/sync/jobs';
import { processNextSyncJob } from '../../lib/sync/worker';
import { seedRuntimeCatalog } from './runtime-fixtures';

const commit = (letter: string) => letter.repeat(40);
const md = (title: string, body: string) => Buffer.from('---\n{"title":"' + title + '"}\n---\n' + body);
const candidateFiles = (files: Map<string, Buffer>) => [...files].map(([path, content]) => ({ path, mode: '100644', content }));

it('publishes intake to runtime content without an application rebuild and pins old readers', async () => {
  const storage = await seedRuntimeCatalog('public');
  try {
    const approvalPath = join(storage.root, 'public-approvals.json');
    const firstFiles = new Map(storage.content);
    firstFiles.set('guides/meta.json', Buffer.from('{"title":"Original Navigation","pages":["setup","retired"],"defaultOpen":true}'));
    firstFiles.set('guides/retired.md', md('Retired Guide', '# Removed guide phrase.'));
    const first = { commitSha: commit('b'), treeSha: commit('c'), files: candidateFiles(firstFiles) };
    await writeFile(approvalPath, JSON.stringify({ formatVersion: 1, approvals: [{
      approvalId: storage.catalog.approvalRef!, version: 1, approvedAt: '2026-10-12T00:00:00.000Z', ownerReference: 'synthetic-review',
      repositoryId: storage.catalog.github.repositoryId, branch: storage.catalog.github.branch, docsPath: storage.catalog.github.docsPath,
      slug: storage.catalog.slug, reviewedCommit: first.commitSha, candidateManifestDigest: candidateManifestDigest(first.files), allowFutureUpdates: true,
    }] }));
    const enqueue = async () => (await admitSyncJob(storage.db, {
      _id: newManualJobId(storage.catalog._id, randomUUID()), catalogId: storage.catalog._id,
      origin: 'manual', event: 'manual', payloadDigest: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    })).job;
    const firstJob = await enqueue();
    expect(await processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot,
      publicCatalogApprovalsFile: approvalPath, readCandidate: async () => first })).toBe('succeeded');
    const afterFirst = await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id });
    expect(afterFirst?.published?.commitSha).toBe(first.commitSha);
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: firstJob._id })).toMatchObject({ state: 'succeeded' });

    let releaseOldRead!: () => void;
    let acquiredOldRead!: () => void;
    const holdOldRead = new Promise<void>(resolve => { releaseOldRead = resolve; });
    const oldReadAcquired = new Promise<void>(resolve => { acquiredOldRead = resolve; });
    const oldGeneration = afterFirst!.published!.generationId;
    const pinnedRead = withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async content => {
      acquiredOldRead();
      await holdOldRead;
      const page = content.loader.getPage(undefined)!;
      return {
        generation: content.manifest.generationId,
        commitSha: content.manifest.commitSha,
        index: page.data.content,
        tree: JSON.stringify(content.loader.pageTree),
        search: await searchContent(content, 'Removed guide phrase'),
        asset: await readAsset(storage.db, storage.contentRoot, storage.catalog.slug, oldGeneration, 'pixel.png'),
      };
    });
    await oldReadAcquired;

    const replacement = await readFile('tests/fixtures/content/public-project/pixel.png');
    const updatedFiles = new Map<string, Buffer>([
      ['index.md', md('Synthetic Latest', '# Synthetic Latest\n\nRead the [updated setup](guides/setup.md) and [new guide](guides/new-page.md).\n\n![Replacement](replacement.png)')],
      ['guides/setup.md', md('Setup', '# Setup\n\nUpdated publication phrase.')],
      ['guides/new-page.md', md('New Guide', '# New Guide\n\nNew searchable phrase.')],
      ['guides/meta.json', Buffer.from('{"title":"Updated Navigation","pages":["setup","new-page"],"defaultOpen":true}')],
      ['replacement.png', replacement],
    ]);
    const next = { commitSha: commit('d'), treeSha: commit('e'), files: candidateFiles(updatedFiles) };
    const nextJob = await enqueue();
    try {
      expect(await processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot,
        publicCatalogApprovalsFile: approvalPath, readCandidate: async () => next })).toBe('succeeded');
    } finally { releaseOldRead(); }
    const pinned = await pinnedRead;
    expect(pinned).toMatchObject({
      generation: oldGeneration,
      commitSha: first.commitSha,
      search: expect.arrayContaining([expect.objectContaining({ url: expect.stringContaining(oldGeneration) })]),
      asset: { bytes: storage.content.get('pixel.png') },
    });
    expect(pinned.index).toContain('Synthetic Portal');
    expect(pinned.tree).toContain('Retired Guide');

    const current = await withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async content => ({
      generation: content.manifest.generationId,
      commitSha: content.manifest.commitSha,
      completedAt: content.manifest.completedAt,
      pages: content.loader.getPages().map(page => page.path),
      tree: JSON.stringify(content.loader.pageTree),
      index: content.loader.getPage(undefined)!.data.content,
      search: await searchContent(content, 'Updated publication phrase'),
      removedSearch: await searchContent(content, 'Removed guide phrase'),
    }));
    const catalog = await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.catalog._id });
    expect(current.commitSha).toBe(next.commitSha);
    expect(current.completedAt).toBeTruthy();
    expect(current.generation).toBe(catalog?.published?.generationId);
    expect(current.pages).toContain('guides/new-page.md');
    expect(current.pages).not.toContain('guides/retired.md');
    expect(current.tree).toContain('Updated Navigation');
    expect(current.index).toContain('guides/new-page.md');
    expect(current.index).not.toContain('guides/retired.md');
    expect(current.search.length).toBeGreaterThan(0);
    expect(current.search.every(result => result.url.includes(current.generation))).toBe(true);
    expect(current.search.some(result => result.url.includes('/guides/setup'))).toBe(true);
    expect(current.removedSearch.every(result => !result.url.includes('/guides/retired'))).toBe(true);
    expect(JSON.stringify(current.removedSearch)).not.toContain('Removed guide phrase');
    await expect(readAsset(storage.db, storage.contentRoot, storage.catalog.slug, current.generation, 'replacement.png'))
      .resolves.toMatchObject({ bytes: replacement });
    await expect(readAsset(storage.db, storage.contentRoot, storage.catalog.slug, current.generation, 'pixel.png'))
      .rejects.toThrow('not_found');
    expect(catalog?.lastSuccess?.commitSha).toBe(next.commitSha);
    expect(catalog?.published?.publishedAt).toBeInstanceOf(Date);
    expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ _id: nextJob._id }))
      .toMatchObject({ state: 'succeeded', targetCommit: next.commitSha, result: { commitSha: next.commitSha } });
  } finally { await storage.close(); }
});
