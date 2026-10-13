import { createHash } from 'node:crypto';
import { z } from 'zod';
import { adminErrorResponse, readAdminJson, requireAdmin } from '@/lib/auth/admin';
import { LIMITS } from '@/lib/limits';
import { admitSyncJob, newManualJobId } from '@/lib/sync/jobs';
import type { SyncStatus } from '@/components/sync-status-badge';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const inputSchema = z.object({ ids: z.array(z.uuidv4().transform(id => id.toLowerCase())).min(1).max(LIMITS.maxCatalogs) }).strict().superRefine((input, context) => {
  if (new Set(input.ids).size !== input.ids.length) context.addIssue({ code: 'custom', message: 'Duplicate catalog ID' });
});

const admissionErrors = new Set(['sync_catalog_unavailable', 'sync_catalog_conflict', 'sync_quota_exhausted',
  'sync_rate_limited', 'sync_storage_unavailable', 'sync_replay_conflict', 'sync_admission_conflict']);

function jobStatus(state: string): SyncStatus {
  if (state === 'running') return 'running';
  if (state === 'queued' || state === 'retry_wait') return 'pending';
  return state === 'succeeded' ? 'succeeded' : 'failed';
}

export async function POST(request: Request) {
  try {
    const { db } = await requireAdmin(request, true);
    if (request.headers.get('content-type') && !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new Error('admin_invalid_request');
    }
    const key = z.uuidv4().parse(request.headers.get('idempotency-key')).toLowerCase();
    const input = inputSchema.parse(await readAdminJson(request));
    const jobs = await Promise.all(input.ids.map(async catalogId => {
      const jobId = newManualJobId(catalogId, key);
      const payloadDigest = createHash('sha256').update(`manual\0${catalogId}\0${key}`).digest('hex');
      try {
        const admitted = await admitSyncJob(db, { _id: jobId, catalogId, origin: 'manual', event: 'manual', payloadDigest });
        return { catalogId, jobId, status: jobStatus(admitted.job.state),
          ...(admitted.job.result?.kind === 'failure' ? { error: admitted.job.result.code } : {}) };
      } catch (error) {
        const code = error instanceof Error && admissionErrors.has(error.message) ? error.message : 'sync_storage_unavailable';
        return { catalogId, jobId, status: 'failed' as const, error: code };
      }
    }));
    return Response.json({ jobs }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof z.ZodError) return adminErrorResponse(new Error('admin_invalid_request'));
    return adminErrorResponse(error);
  }
}
