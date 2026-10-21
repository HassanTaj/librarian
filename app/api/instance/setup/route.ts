import { instanceRuntimeInputs } from '@/lib/config';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '@/lib/mongo';
import { readInstanceHost } from '@/lib/instance/bootstrap';
import { consumeInstanceRate, instanceErrorResponse, readInstanceJson, readInstanceSetupSession } from '@/lib/instance/access';
import { buildInstanceDraft, initialInstanceCandidate, InstanceDraftPatchSchema, readInstance, updateInstance, type InstanceControl } from '@/lib/instance/store';
import { LIMITS } from '@/lib/limits';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

type Candidate = NonNullable<InstanceControl['candidate']>;

function secretStatus(value: Candidate['secrets']['zitadelClientSecret']) {
  return value ? { configured: true, updatedAt: value.updatedAt } : { configured: false, updatedAt: null };
}

function safeCandidate(candidate: Candidate, ownerVerified: boolean) {
  return {
    version: candidate.version, preferences: candidate.preferences, publicOrigin: candidate.publicOrigin,
    zitadel: candidate.zitadel, github: candidate.github, checks: candidate.checks,
    ownerVerified, impact: candidate.impact,
    secrets: {
      zitadelClientSecret: secretStatus(candidate.secrets.zitadelClientSecret),
      githubPrivateKey: secretStatus(candidate.secrets.githubPrivateKey),
      githubWebhookSecret: secretStatus(candidate.secrets.githubWebhookSecret),
    },
  };
}

function etag(editRevision: number) { return `"${editRevision}"`; }
function setupCookie(request: Request) {
  return request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('__Host-librarian_setup='))?.slice('__Host-librarian_setup='.length) ?? '';
}

function response(control: InstanceControl, candidate: Candidate, expiresAt: Date, setupOrigin: string) {
  const callback = new URL('/api/instance/auth/callback/zitadel', setupOrigin).href;
  const proof = candidate.ownerProof;
  const ownerVerified = control.lifecycle === 'awaiting_owner' && !!proof && proof.instanceId === control.instanceId &&
    proof.candidateVersion === candidate.version && proof.issuer === candidate.zitadel.issuer && proof.projectId === candidate.zitadel.projectId &&
    proof.securityEpoch === control.securityEpoch && proof.expiresAt > new Date();
  return {
    state: control.lifecycle, expiresAt, editRevision: control.editRevision, candidateVersion: control.candidate?.version ?? 0,
    candidate: safeCandidate(candidate, ownerVerified), checks: candidate.checks,
    runtimeCallbackUrl: new URL('/api/auth/callback/zitadel', candidate.publicOrigin).href,
    candidateCallbackUrl: callback, webhookUrl: candidate.github.webhookUrl ?? new URL('/api/webhooks/github', candidate.publicOrigin).href,
  };
}

export async function GET(request: Request) {
  try {
    const host = await readInstanceHost();
    const token = setupCookie(request);
    const storage = await connectMongo(host.config, { initializeLegacy: false });
    try {
      const session = await readInstanceSetupSession(storage.db, host.instanceId, token);
      const control = await readInstance(storage.db, host.instanceId);
      if (!control) throw new Error('instance_unavailable');
      const candidate = control.candidate ?? initialInstanceCandidate(control, host.setupOrigin, new Date());
      return Response.json({ ...response(control, candidate, session.expiresAt, host.setupOrigin), ...(session.purpose === 'recovery' ? {
        recovery: true, recoveryControlRevision: control.revision, recoveryProofId: candidate.ownerProof && candidate.ownerProof.expiresAt > new Date() ? candidate.ownerProof.nonce : null,
      } : {}) }, {
        headers: { 'Cache-Control': 'private, no-store', ETag: etag(control.editRevision) },
      });
    } finally { await storage.client.close(); }
  } catch (error) { return instanceErrorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const host = await readInstanceHost();
    if (request.headers.get('origin') !== host.setupOrigin) throw new Error('instance_origin');
    const token = setupCookie(request);
    const csrfToken = request.headers.get('x-csrf-token') ?? '';
    const storage = await connectMongo(host.config, { initializeLegacy: false });
    try {
      const session = await readInstanceSetupSession(storage.db, host.instanceId, token, csrfToken);
      await consumeInstanceRate(storage.db, host.instanceId, host.instanceId, 'mutation');
      const parsed = InstanceDraftPatchSchema.safeParse(await readInstanceJson(request));
      if (!parsed.success) throw new Error('instance_invalid');
      const now = new Date();
      const control = await readInstance(storage.db, host.instanceId);
      if (!control || !['configuring', 'awaiting_owner'].includes(control.lifecycle) || control.bootstrap.consumedAt) throw new Error('instance_setup_closed');
      if (request.headers.get('if-match') !== etag(control.editRevision) || parsed.data.candidateVersion !== (control.candidate?.version ?? 0)) throw new Error('instance_conflict');
      if (control.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox) throw new Error('instance_unavailable');

      const validatedCandidate = await buildInstanceDraft(control, host.setupOrigin, parsed.data, host.keyring, 'bootstrap', now);
      validatedCandidate.runtime ??= instanceRuntimeInputs(host.config);
      const next = await updateInstance(storage.db, host.instanceId, control.revision, current => ({
        ...current, lifecycle: 'configuring', candidate: validatedCandidate, nextBundleVersion: current.nextBundleVersion + 1,
        auditOutbox: [...current.auditOutbox, { _id: randomUUID(), instanceId: host.instanceId, at: now, actor: 'bootstrap', operation: 'candidate_saved',
          fromVersion: current.candidate?.version ?? null, toVersion: validatedCandidate.version, resultCode: 'accepted', requestId: randomUUID() }],
      }), now);
      return Response.json(response(next, validatedCandidate, session.expiresAt, host.setupOrigin), {
        headers: { 'Cache-Control': 'private, no-store', ETag: etag(next.editRevision) },
      });
    } finally { await storage.client.close(); }
  } catch (error) { return instanceErrorResponse(error); }
}
