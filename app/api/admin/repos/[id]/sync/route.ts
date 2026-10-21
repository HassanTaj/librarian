import { withAdminRuntime } from '@/lib/auth/admin';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { adminErrorResponse, readAdminJson, requireAdmin } from '@/lib/auth/admin';
import { admitSyncJob, newManualJobId } from '@/lib/sync/jobs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function handlePOST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { db } = await requireAdmin(request, true);
    if (request.headers.get('content-type') && !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new Error('admin_invalid_request');
    }
    const { id } = await params;
    const catalogId = z.uuidv4().parse(id);
    const key = z.uuidv4().parse(request.headers.get('idempotency-key'));
    const body = await readAdminJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new Error('admin_invalid_request');
    const idempotencyKey = key.toLowerCase();
    const jobId = newManualJobId(catalogId, idempotencyKey);
    const payloadDigest = createHash('sha256').update(`manual\0${catalogId}\0${idempotencyKey}`).digest('hex');
    const result = await admitSyncJob(db, { _id: jobId, catalogId, origin: 'manual', event: 'manual', payloadDigest });
    const status = result.job.state === 'running' ? 'running'
      : ['queued', 'retry_wait'].includes(result.job.state) ? 'pending'
      : result.job.state === 'succeeded' ? 'succeeded' : 'failed';
    return Response.json({ jobId, status, ...(result.job.result?.kind === 'published' ? { commit: result.job.result.commitSha } : {}),
      ...(result.job.result?.kind === 'failure' ? { error: result.job.result.code } : {}) }, {
      status: result.duplicate ? 200 : 202, headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return adminErrorResponse(new Error('admin_invalid_request'));
    return adminErrorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return withAdminRuntime(() => handlePOST(request, context)); }
