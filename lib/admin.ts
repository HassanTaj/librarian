import type { Db } from 'mongodb';
import { CatalogSchema, type Catalog } from './catalog';
import { SyncJobSchema, type SyncJob } from './sync/jobs';

function publicStatus(catalog: Catalog, job: SyncJob | null) {
  if (catalog.accessState === 'blocked') return { status: 'failed' as const, error: 'access_lost', isSyncing: false };
  if (job?.state === 'running') return { status: 'running' as const, error: null, isSyncing: true };
  if (job && ['queued', 'retry_wait'].includes(job.state)) return {
    status: 'pending' as const, error: null, isSyncing: true, nextAttemptAt: job.state === 'retry_wait' ? job.availableAt : null,
  };
  if (job?.state === 'failed' || job?.state === 'cancelled') return {
    status: 'failed' as const, error: job.result?.kind === 'failure' ? job.result.code : 'sync_failed', isSyncing: false,
  };
  if (job?.state === 'succeeded' || catalog.lastSuccess || catalog.published) return { status: 'succeeded' as const, error: null, isSyncing: false };
  return { status: 'pending' as const, error: catalog.lastFailure?.code ?? null, isSyncing: false };
}

export async function adminCatalogSummary(db: Db, value: unknown) {
  const catalog = CatalogSchema.parse(value);
  const jobValue = await db.collection<SyncJob>('syncJobs').find({ catalogId: catalog._id }).sort({ requestedAt: -1 }).limit(1).next();
  const job = jobValue ? SyncJobSchema.parse(jobValue) : null;
  return {
    id: catalog._id, revision: catalog.configRevision, updatedAt: catalog.updatedAt,
    github: catalog.github, slug: catalog.slug, title: catalog.title, publicDescription: catalog.publicDescription,
    visibility: catalog.visibility, readerRole: catalog.readerRole, enabled: catalog.enabled, accessState: catalog.accessState,
    approvalRef: catalog.approvalRef,
    ...publicStatus(catalog, job), publishedCommit: catalog.published?.commitSha ?? null,
    lastSuccessAt: catalog.lastSuccess?.at ?? null,
  };
}

export async function listAdminCatalogs(db: Db) {
  const values = await db.collection<Catalog>('catalogs').find({}).sort({ title: 1 }).limit(20).toArray();
  return Promise.all(values.map(value => adminCatalogSummary(db, value)));
}

export async function listDirectorySyncStatuses(db: Db, slugs: string[]) {
  if (!slugs.length) return [];
  const values = await db.collection<Catalog>('catalogs')
    .find({ enabled: true, accessState: 'ready', slug: { $in: slugs } }).sort({ title: 1 }).limit(20).toArray();
  return Promise.all(values.map(async value => {
    const summary = await adminCatalogSummary(db, value);
    return { slug: value.slug, status: summary.status, error: summary.error, isSyncing: summary.isSyncing };
  }));
}
