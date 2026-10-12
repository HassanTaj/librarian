import { createGitHubClient } from '@/lib/sync/github';
import { insertCatalog, newCatalogRecord, type Catalog } from '@/lib/catalog';
import { adminCatalogSummary, listAdminCatalogs } from '@/lib/admin';
import { requireAdmin, readAdminJson, adminErrorResponse } from '@/lib/auth/admin';
import { requirePublicApproval } from '@/lib/public-approvals';
import { MongoServerError } from 'mongodb';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const createSchema = z.object({
  github: z.object({ owner: z.string(), name: z.string(), branch: z.string(), docsPath: z.string(), installationId: z.number().int().positive() }).strict(),
  slug: z.string(), title: z.string(), publicDescription: z.string().optional(), readerRole: z.string().optional(),
  visibility: z.enum(['public', 'private']).optional(), enabled: z.boolean().optional(), approvalRef: z.string().min(1).max(200).optional(),
}).strict();

function sourceError(error: unknown): never {
  const code = error instanceof Error ? error.message : '';
  if (['github_invalid_catalog', 'github_docs_missing', 'github_access_denied', 'github_not_found', 'github_invalid_content'].includes(code)) throw new Error(code);
  throw new Error('admin_unavailable');
}

export async function GET(request: Request) {
  try {
    const { db } = await requireAdmin(request);
    return Response.json({ catalogs: await listAdminCatalogs(db) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return adminErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { db, config } = await requireAdmin(request, true);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('admin_invalid_request');
    const parsed = createSchema.safeParse(await readAdminJson(request));
    if (!parsed.success) throw new Error('admin_invalid_request');
    const input = parsed.data;
    const visibility = input.visibility ?? 'private';
    if ((visibility === 'public' && !input.approvalRef) || (visibility === 'private' && input.approvalRef)) {
      throw new Error(visibility === 'public' ? 'public_approval_required' : 'admin_invalid_request');
    }
    const provider = createGitHubClient({ githubAppId: config.githubAppId, githubPrivateKey: config.githubPrivateKey });
    let repository: { repositoryId: number; owner: string; name: string; commitSha: string };
    try {
      repository = await provider.verifyRepository(input.github);
    } catch (error) { sourceError(error); }
    if (visibility === 'public') {
      const draft = newCatalogRecord({ github: { repositoryId: repository!.repositoryId, installationId: input.github.installationId,
        owner: repository!.owner, name: repository!.name, branch: input.github.branch, docsPath: input.github.docsPath },
        slug: input.slug, title: input.title, publicDescription: input.publicDescription ?? '', readerRole: input.readerRole,
        visibility, enabled: true, approvalRef: input.approvalRef });
      draft.accessState = 'ready';
      let candidate: Awaited<ReturnType<typeof provider.readCandidate>>;
      try { candidate = await provider.readCandidate(draft); } catch (error) { sourceError(error); }
      if (candidate!.commitSha !== repository!.commitSha) throw new Error('public_approval_required');
      await requirePublicApproval({ filePath: config.publicCatalogApprovalsFile, approvalRef: input.approvalRef ?? null,
        scope: draft, candidate: candidate! });
    }
    const catalog = await insertCatalog(db, {
      github: { repositoryId: repository!.repositoryId, installationId: input.github.installationId,
        owner: repository!.owner, name: repository!.name, branch: input.github.branch, docsPath: input.github.docsPath },
      slug: input.slug, title: input.title,
      publicDescription: input.publicDescription ?? '', readerRole: input.readerRole, visibility,
      enabled: input.enabled ?? true, approvalRef: input.approvalRef ?? null,
    });
    const verified = await db.collection<Catalog>('catalogs').findOneAndUpdate({ _id: catalog._id, configRevision: 1, accessState: 'unverified' },
      [{ $set: { accessState: 'ready', updatedAt: { $max: ['$updatedAt', '$$NOW'] } } }], { returnDocument: 'after' });
    if (!verified) throw new Error('admin_unavailable');
    return Response.json({ catalog: await adminCatalogSummary(db, verified), revision: verified.configRevision }, {
      status: 201, headers: { 'Cache-Control': 'private, no-store', ETag: `"${verified.updatedAt.toISOString()}"` },
    });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return adminErrorResponse(new Error('catalog_conflict'));
    if (error instanceof z.ZodError) return adminErrorResponse(new Error('admin_invalid_request'));
    return adminErrorResponse(error);
  }
}
