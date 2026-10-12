import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { expect, it } from 'vitest';
import { adminCatalogSummary, listAdminCatalogs, listDirectorySyncStatuses } from '../../lib/admin';
import { newCatalogRecord, type Catalog } from '../../lib/catalog';
import { newManualJobId, type SyncJob } from '../../lib/sync/jobs';

const now = new Date('2026-10-12T00:00:00.000Z');

function catalog(overrides: Partial<Catalog> = {}) {
  return { ...newCatalogRecord({ github: { repositoryId: 51, installationId: 61, owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs' },
    slug: 'synthetic-docs', title: 'Synthetic docs', visibility: 'private' }, now), ...overrides };
}

function jobFor(value: Catalog, state: SyncJob['state'], overrides: Partial<SyncJob> = {}): SyncJob {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(state);
  return { _id: newManualJobId(value._id, randomUUID()), catalogId: value._id, configRevision: value.configRevision,
    origin: 'manual', event: 'manual', payloadDigest: 'b'.repeat(64), admissionSequence: 1, state, requestedAt: now,
    availableAt: now, attempts: state === 'running' ? 1 : 0, owner: state === 'running' ? randomUUID() : null,
    fence: state === 'running' ? 1 : 0, targetCommit: null, generationId: state === 'succeeded' ? randomUUID() : null,
    result: state === 'succeeded' ? { kind: 'published', commitSha: 'a'.repeat(40) }
      : state === 'failed' ? { kind: 'failure', code: 'github_unavailable' } : null,
    completedAt: terminal ? now : null, detailExpiresAt: terminal ? new Date(now.getTime() + 60_000) : null, ...overrides };
}

function dbFor(job: SyncJob | null, catalogs: Catalog[] = []): Db {
  return { collection: () => ({ find: () => ({ sort: () => ({ limit: () => ({
    next: async () => job, toArray: async () => catalogs,
  }) }) }) }) } as unknown as Db;
}

it('maps every durable job state and access-loss state to safe public status', async () => {
  const source = catalog();
  expect(await adminCatalogSummary(dbFor(null), { ...source, accessState: 'blocked' })).toMatchObject({ status: 'failed', error: 'access_lost' });
  expect(await adminCatalogSummary(dbFor(jobFor(source, 'running')), source)).toMatchObject({ status: 'running', error: null });
  expect(await adminCatalogSummary(dbFor(jobFor(source, 'queued')), source)).toMatchObject({ status: 'pending', nextAttemptAt: null, error: null });
  expect(await adminCatalogSummary(dbFor(jobFor(source, 'retry_wait', { availableAt: new Date(now.getTime() + 5_000) })), source))
    .toMatchObject({ status: 'pending', nextAttemptAt: new Date(now.getTime() + 5_000) });
  expect(await adminCatalogSummary(dbFor(jobFor(source, 'failed')), source)).toMatchObject({ status: 'failed', error: 'github_unavailable' });
  expect(await adminCatalogSummary(dbFor(jobFor(source, 'cancelled')), source)).toMatchObject({ status: 'failed', error: 'sync_failed' });
  const successful = jobFor(source, 'succeeded');
  const published = { ...source, leaseFence: 1, published: { generationId: successful.generationId!, commitSha: 'a'.repeat(40),
    jobId: successful._id, fence: 1, configRevision: source.configRevision, manifestDigest: 'b'.repeat(64), publishedAt: now } };
  expect(await adminCatalogSummary(dbFor(successful), published)).toMatchObject({ status: 'succeeded', publishedCommit: 'a'.repeat(40) });
  expect(await adminCatalogSummary(dbFor(null), { ...source, lastSuccess: { at: now, jobId: newManualJobId(source._id, randomUUID()), commitSha: 'c'.repeat(40) } }))
    .toMatchObject({ status: 'succeeded', lastSuccessAt: now });
  expect(await adminCatalogSummary(dbFor(null), { ...source, lastFailure: { at: now, jobId: newManualJobId(source._id, randomUUID()), code: 'github_unavailable' } }))
    .toMatchObject({ status: 'pending', error: 'github_unavailable' });
});

it('lists only the bounded catalog projection and retains null publication fields', async () => {
  const source = catalog();
  const result = await listAdminCatalogs(dbFor(null, [source]));
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ id: source._id, slug: 'synthetic-docs', status: 'pending', publishedCommit: null, lastSuccessAt: null });
});

it('returns only safe sync status fields for directory cards', async () => {
  const source = catalog();
  const result = await listDirectorySyncStatuses(dbFor(jobFor(source, 'failed'), [source]), [source.slug]);
  expect(result).toEqual([{ slug: source.slug, status: 'failed' }]);
  expect(Object.keys(result[0])).toEqual(['slug', 'status']);
  expect(await listDirectorySyncStatuses({ collection: () => { throw new Error('empty query should not run'); } } as unknown as Db, [])).toEqual([]);
});
