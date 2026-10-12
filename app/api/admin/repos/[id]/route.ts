import { MongoServerError } from 'mongodb';
import { z } from 'zod';
import { adminCatalogSummary } from '@/lib/admin';
import { applyCatalogChanges, CatalogSchema, type Catalog } from '@/lib/catalog';
import { adminErrorResponse, readAdminJson, requireAdmin } from '@/lib/auth/admin';
import { requirePublicApproval } from '@/lib/public-approvals';
import { createGitHubClient } from '@/lib/sync/github';
import { deleteCatalogSnapshot } from '@/lib/content/generations';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const github = z.object({ owner: z.string(), name: z.string(), branch: z.string(), docsPath: z.string(), installationId: z.number().int().positive() }).strict();
const patchSchema = z.object({ github: github.optional(), slug: z.string().optional(), title: z.string().optional(),
  publicDescription: z.string().optional(), visibility: z.enum(['public', 'private']).optional(), readerRole: z.string().optional(),
  enabled: z.boolean().optional(), approvalRef: z.string().min(1).max(200).nullable().optional() }).strict().refine(value => Object.keys(value).length > 0);
const idSchema = z.uuidv4();
type GitHubCandidate = Awaited<ReturnType<ReturnType<typeof createGitHubClient>['readCandidate']>>;

function etagDate(value: string | null) {
  const match = value && /^"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"$/.exec(value);
  if (!match) throw new Error('admin_invalid_request');
  const parsed = new Date(match[1]);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== match[1]) throw new Error('admin_invalid_request');
  return parsed;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { db, config } = await requireAdmin(request, true);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('admin_invalid_request');
    const { id } = await params;
    const catalogId = idSchema.parse(id);
    const expectedVersion = etagDate(request.headers.get('if-match'));
    const parsed = patchSchema.safeParse(await readAdminJson(request));
    if (!parsed.success) throw new Error('admin_invalid_request');
    const currentValue = await db.collection<Catalog>('catalogs').findOne({ _id: catalogId });
    if (!currentValue) throw new Error('catalog_not_found');
    const current = CatalogSchema.parse(currentValue);
    if (current.updatedAt.getTime() !== expectedVersion.getTime()) throw new Error('catalog_conflict');
    const changes = parsed.data;
    const visibility = changes.visibility ?? current.visibility;
    if (visibility === 'private' && changes.approvalRef) throw new Error('admin_invalid_request');
    const approvalRef = visibility === 'private' ? null : changes.approvalRef ?? current.approvalRef;
    if (visibility === 'public' && !approvalRef) throw new Error('public_approval_required');
    const recovery = current.accessState === 'blocked' && !current.enabled && changes.enabled === true;
    const input = changes.github ?? {
      owner: current.github.owner, name: current.github.name, branch: current.github.branch,
      docsPath: current.github.docsPath, installationId: current.github.installationId,
    };
    const submittedScopeChange = input.owner !== current.github.owner || input.name !== current.github.name ||
      input.branch !== current.github.branch || input.docsPath !== current.github.docsPath || input.installationId !== current.github.installationId ||
      (changes.slug !== undefined && changes.slug !== current.slug);
    const approvalScopeChange = visibility !== current.visibility || submittedScopeChange || approvalRef !== current.approvalRef;
    const needsVerification = changes.github !== undefined || recovery || (visibility === 'public' && approvalScopeChange);
    let verified = false;
    const normalizedChanges: Record<string, unknown> = { ...changes };
    normalizedChanges.approvalRef = approvalRef;
    let provider: ReturnType<typeof createGitHubClient> | undefined;
    let repository: Awaited<ReturnType<ReturnType<typeof createGitHubClient>['verifyRepository']>> | undefined;
    if (needsVerification) {
      provider = createGitHubClient({ githubAppId: config.githubAppId, githubPrivateKey: config.githubPrivateKey });
      try { repository = await provider.verifyRepository(input); } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['github_invalid_catalog', 'github_docs_missing', 'github_access_denied', 'github_not_found', 'github_invalid_content'].includes(code)) throw error;
        throw new Error('admin_unavailable');
      }
      normalizedChanges.github = { repositoryId: repository!.repositoryId, installationId: input.installationId,
        owner: repository!.owner, name: repository!.name, branch: input.branch, docsPath: input.docsPath };
      verified = true;
    }
    const next = applyCatalogChanges(current, normalizedChanges, current.configRevision);
    if (needsVerification && visibility === 'public' && (approvalScopeChange || recovery)) {
      const candidateCatalog = { ...next, enabled: true, accessState: 'ready' as const };
      let candidate: GitHubCandidate;
      try { candidate = await provider!.readCandidate(candidateCatalog); } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['github_invalid_catalog', 'github_docs_missing', 'github_access_denied', 'github_not_found', 'github_invalid_content'].includes(code)) throw error;
        throw new Error('admin_unavailable');
      }
      if (candidate.commitSha !== repository!.commitSha) throw new Error('public_approval_required');
      const sameApprovedScope = current.visibility === 'public' && approvalRef === current.approvalRef &&
        next.slug === current.slug && next.github.repositoryId === current.github.repositoryId &&
        next.github.branch === current.github.branch && next.github.docsPath === current.github.docsPath;
      await requirePublicApproval({ filePath: config.publicCatalogApprovalsFile, approvalRef,
        scope: candidateCatalog, candidate, currentPublishedCommit: sameApprovedScope ? current.published?.commitSha : null });
    }
    if (verified || (next.accessState === 'unverified' && current.accessState === 'ready')) next.accessState = 'ready';
    const updated = await db.collection<Catalog>('catalogs').replaceOne({ _id: catalogId,
      configRevision: current.configRevision, updatedAt: expectedVersion }, next, { writeConcern: { w: 1, j: true } });
    if (updated.matchedCount !== 1) throw new Error('catalog_conflict');
    return Response.json({ catalog: await adminCatalogSummary(db, next), revision: next.configRevision }, {
      headers: { 'Cache-Control': 'private, no-store', ETag: `"${next.updatedAt.toISOString()}"` },
    });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return adminErrorResponse(new Error('catalog_conflict'));
    if (error instanceof z.ZodError) return adminErrorResponse(new Error('admin_invalid_request'));
    return adminErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { db, config } = await requireAdmin(request, true);
    const { id } = await params;
    const catalogId = idSchema.parse(id);
    const expectedVersion = etagDate(request.headers.get('if-match'));
    const catalogs = db.collection<Catalog>('catalogs');
    const currentValue = await catalogs.findOne({ _id: catalogId });
    if (!currentValue) {
      await deleteCatalogSnapshot(config.contentRoot, catalogId);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
    }
    const current = CatalogSchema.parse(currentValue);
    if (current.updatedAt.getTime() !== expectedVersion.getTime()) throw new Error('catalog_conflict');
    const deleted = await catalogs.deleteOne({ _id: catalogId, updatedAt: expectedVersion, lease: null,
      $expr: { $not: { $anyElementTrue: { $map: { input: '$readPins', as: 'pin', cond: { $gt: ['$$pin.expiresAt', '$$NOW'] } } } } },
    }, { writeConcern: { w: 1, j: true } });
    if (deleted.deletedCount !== 1) {
      const latestValue = await catalogs.findOne({ _id: catalogId });
      if (!latestValue) {
        await deleteCatalogSnapshot(config.contentRoot, catalogId);
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
      }
      const latest = CatalogSchema.parse(latestValue);
      if (latest.updatedAt.getTime() !== expectedVersion.getTime()) throw new Error('catalog_conflict');
      throw new Error('catalog_busy');
    }
    await deleteCatalogSnapshot(config.contentRoot, catalogId);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return adminErrorResponse(new Error('catalog_conflict'));
    if (error instanceof z.ZodError) return adminErrorResponse(new Error('admin_invalid_request'));
    return adminErrorResponse(error);
  }
}
