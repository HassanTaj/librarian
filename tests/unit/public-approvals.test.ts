import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { candidateManifestDigest, requirePublicApproval } from '../../lib/public-approvals';

const source = { slug: 'docs', github: { repositoryId: 71, installationId: 61, owner: 'synthetic', name: 'portal', branch: 'main', docsPath: 'docs' } };
const candidate = { commitSha: 'a'.repeat(40), files: [
  { path: 'index.md', mode: '100644', content: Buffer.from('# Synthetic') },
  { path: 'meta.json', mode: '100644', content: Buffer.from('{"title":"Docs"}') },
] };
let root: string;

async function writeApproval(overrides: Record<string, unknown> = {}) {
  const filePath = join(root, 'approvals.json');
  const approval = { approvalId: 'owner-review-1', version: 1, approvedAt: '2026-10-12T00:00:00.000Z', ownerReference: 'ticket-123',
    repositoryId: 71, branch: 'main', docsPath: 'docs', slug: 'docs', reviewedCommit: candidate.commitSha,
    candidateManifestDigest: candidateManifestDigest(candidate.files), allowFutureUpdates: false, ...overrides };
  await writeFile(filePath, JSON.stringify({ formatVersion: 1, approvals: [approval] }));
  return filePath;
}

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('creates a stable SHA-256 digest for sorted file metadata and bytes', () => {
  const reversed = [...candidate.files].reverse();
  expect(candidateManifestDigest(reversed)).toBe(candidateManifestDigest(candidate.files));
  expect(candidateManifestDigest([{ ...candidate.files[0]!, content: Buffer.from('changed') }, candidate.files[1]!]))
    .not.toBe(candidateManifestDigest(candidate.files));
  expect(() => candidateManifestDigest([candidate.files[0]!, candidate.files[0]!])).toThrow('public_approval_required');
});

it('rejects empty candidates, non-file modes, unbuffered content, and missing approval references', async () => {
  root = await mkdtemp(join(tmpdir(), 'librarian-approval-'));
  expect(() => candidateManifestDigest([])).toThrow('public_approval_required');
  expect(() => candidateManifestDigest([{ ...candidate.files[0]!, mode: '120000' }])).toThrow('public_approval_required');
  expect(() => candidateManifestDigest([{ ...candidate.files[0]!, content: 'text' as unknown as Buffer }]))
    .toThrow('public_approval_required');
  await expect(requirePublicApproval({ filePath: await writeApproval(), approvalRef: null, scope: source, candidate }))
    .rejects.toThrow('public_approval_required');
});

it('accepts only the exact owner-reviewed source, commit, and candidate digest for first publication', async () => {
  root = await mkdtemp(join(tmpdir(), 'librarian-approval-'));
  const filePath = await writeApproval();
  await expect(requirePublicApproval({ filePath, approvalRef: 'owner-review-1', scope: source, candidate })).resolves.toMatchObject({
    approvalId: 'owner-review-1', repositoryId: 71, reviewedCommit: candidate.commitSha,
  });
  await expect(requirePublicApproval({ filePath, approvalRef: 'owner-review-1', scope: { ...source, slug: 'other' }, candidate }))
    .rejects.toThrow('public_approval_required');
  await expect(requirePublicApproval({ filePath, approvalRef: 'owner-review-1', scope: source,
    candidate: { ...candidate, commitSha: 'b'.repeat(40) } })).rejects.toThrow('public_approval_required');
});

it('allows same-scope future commits only when the owner opted in', async () => {
  root = await mkdtemp(join(tmpdir(), 'librarian-approval-'));
  const filePath = await writeApproval({ allowFutureUpdates: true });
  const next = { commitSha: 'b'.repeat(40), files: [{ ...candidate.files[0]!, content: Buffer.from('# Updated') }] };
  await expect(requirePublicApproval({ filePath, approvalRef: 'owner-review-1', scope: source, candidate: next,
    currentPublishedCommit: candidate.commitSha })).resolves.toMatchObject({ allowFutureUpdates: true });
  const noFutureUpdates = await writeApproval({ allowFutureUpdates: false });
  await expect(requirePublicApproval({ filePath: noFutureUpdates, approvalRef: 'owner-review-1', scope: source, candidate: next,
    currentPublishedCommit: candidate.commitSha })).rejects.toThrow('public_approval_required');
  await expect(requirePublicApproval({ filePath: noFutureUpdates, approvalRef: 'owner-review-1', scope: source, candidate,
    currentPublishedCommit: candidate.commitSha })).resolves.toMatchObject({ allowFutureUpdates: false });
});

it('fails closed for missing, malformed, duplicate, or oversized approval files', async () => {
  root = await mkdtemp(join(tmpdir(), 'librarian-approval-'));
  await expect(requirePublicApproval({ approvalRef: 'owner-review-1', scope: source, candidate })).rejects.toThrow('public_approval_required');
  const filePath = join(root, 'approvals.json');
  await writeFile(filePath, '{');
  await expect(requirePublicApproval({ filePath, approvalRef: 'owner-review-1', scope: source, candidate })).rejects.toThrow('public_approval_required');
  const approval = { approvalId: 'owner-review-1', version: 1, approvedAt: '2026-10-12T00:00:00.000Z', ownerReference: 'ticket-123',
    repositoryId: 71, branch: 'main', docsPath: 'docs', slug: 'docs', reviewedCommit: candidate.commitSha,
    candidateManifestDigest: candidateManifestDigest(candidate.files), allowFutureUpdates: false };
  await writeFile(filePath, JSON.stringify({ formatVersion: 1, approvals: [approval, approval] }));
  await expect(requirePublicApproval({ filePath, approvalRef: 'owner-review-1', scope: source, candidate })).rejects.toThrow('public_approval_required');
  await writeFile(filePath, 'x'.repeat(64 * 1024 + 1));
  await expect(requirePublicApproval({ filePath, approvalRef: 'owner-review-1', scope: source, candidate })).rejects.toThrow('public_approval_required');
});
