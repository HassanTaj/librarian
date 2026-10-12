import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { isCatalogSlug, type Catalog } from './catalog';
import { LIMITS } from './limits';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const approvalSchema = z.object({
  approvalId: z.string().min(1).max(200).regex(/^[\w.:-]+$/),
  version: z.number().int().positive(),
  approvedAt: z.iso.datetime(),
  ownerReference: z.string().min(1).max(200).refine(value => !/\p{Cc}/u.test(value)),
  repositoryId: z.number().int().positive(),
  branch: z.string().min(1).max(255),
  docsPath: z.string().min(1).max(LIMITS.maxPathBytes),
  slug: z.string().refine(isCatalogSlug),
  reviewedCommit: sha,
  candidateManifestDigest: digest,
  allowFutureUpdates: z.boolean(),
}).strict();

const manifestSchema = z.object({ formatVersion: z.literal(1), approvals: z.array(approvalSchema).max(LIMITS.maxCatalogs) })
  .strict().superRefine((manifest, context) => {
    const ids = manifest.approvals.map(approval => approval.approvalId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Duplicate approval ID' });
  });

type PublicApproval = z.infer<typeof approvalSchema>;
type SourceScope = Pick<Catalog, 'github' | 'slug'>;
type Candidate = { commitSha: string; files: Array<{ path: string; mode: string; content: Buffer }> };

export function candidateManifestDigest(files: Candidate['files']) {
  if (!files.length || files.length > LIMITS.maxFiles) throw new Error('public_approval_required');
  const entries = files.map(file => {
    if (!Buffer.isBuffer(file.content) || file.mode !== '100644') throw new Error('public_approval_required');
    return { path: file.path, mode: file.mode, size: file.content.length,
      sha256: createHash('sha256').update(file.content).digest('hex') };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('public_approval_required');
  return createHash('sha256').update(JSON.stringify({ formatVersion: 1, files: entries })).digest('hex');
}

async function findApproval(filePath: string | undefined, approvalRef: string) {
  try {
    if (!filePath) throw new Error();
    const bytes = await readFile(filePath);
    if (!bytes.length || bytes.length > LIMITS.maxPublicApprovalBytes) throw new Error();
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const manifest = manifestSchema.parse(input);
    const approval = manifest.approvals.find(item => item.approvalId === approvalRef);
    if (!approval) throw new Error();
    return approval;
  } catch { throw new Error('public_approval_required'); }
}

export async function requirePublicApproval(input: {
  filePath?: string;
  approvalRef: string | null;
  scope: SourceScope;
  candidate: Candidate;
  currentPublishedCommit?: string | null;
}): Promise<PublicApproval> {
  if (!input.approvalRef) throw new Error('public_approval_required');
  const approval = await findApproval(input.filePath, input.approvalRef);
  const { github, slug } = input.scope;
  if (approval.repositoryId !== github.repositoryId || approval.branch !== github.branch ||
      approval.docsPath !== github.docsPath || approval.slug !== slug) throw new Error('public_approval_required');
  const candidateDigest = candidateManifestDigest(input.candidate.files);
  const exactReviewedCandidate = approval.reviewedCommit === input.candidate.commitSha &&
    approval.candidateManifestDigest === candidateDigest;
  const isCurrentPublishedCandidate = input.currentPublishedCommit === input.candidate.commitSha;
  if (!exactReviewedCandidate && !isCurrentPublishedCandidate && !approval.allowFutureUpdates) {
    throw new Error('public_approval_required');
  }
  return approval;
}
