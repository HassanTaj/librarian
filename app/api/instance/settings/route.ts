import { randomUUID } from 'node:crypto';
import { requireInstanceAdmin, consumeInstanceRate, instanceErrorResponse, readInstanceJson, withInstanceAdmission } from '@/lib/instance/access';
import { buildInstanceDraft, InstanceDraftPatchSchema, instanceSnapshot, readInstance, updateInstance } from '@/lib/instance/store';
import { LIMITS } from '@/lib/limits';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { control, csrfToken, binding } = await requireInstanceAdmin(request);
    return Response.json({ ...instanceSnapshot(control), csrfToken, bindingKind: binding.kind,
      impact: control.candidate?.impact ?? null, previousVersion: control.previous?.version ?? null,
      rollbackNonce: control.active?.impact?.confirmationNonce ?? null,
      ownerProofId: binding.kind === 'owner' && control.candidate?.ownerProof && control.candidate.ownerProof.expiresAt > new Date() ? control.candidate.ownerProof.nonce : null,
      activation: { state: control.activation?.phase ?? (control.candidate ? 'draft' : 'active'), restartRequired: false },
      runtimeCallbackUrl: new URL('/api/auth/callback/zitadel', control.candidate?.publicOrigin ?? control.active!.publicOrigin).href,
      candidateCallbackUrl: new URL('/api/instance/auth/callback/zitadel', control.candidate?.publicOrigin ?? control.active!.publicOrigin).href,
      webhookUrl: (control.candidate ?? control.active)!.github.webhookUrl ?? new URL('/api/webhooks/github', control.candidate?.publicOrigin ?? control.active!.publicOrigin).href,
    }, { headers: { 'Cache-Control': 'private, no-store', ETag: `"${control.editRevision}"` } });
  } catch (error) { return instanceErrorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const { db, host, binding } = await requireInstanceAdmin(request, true);
    return await withInstanceAdmission(db, host.instanceId, 'request', async () => {
      await consumeInstanceRate(db, host.instanceId, binding.bindingId, 'mutation');
      const parsed = InstanceDraftPatchSchema.safeParse(await readInstanceJson(request));
      if (!parsed.success) throw new Error('instance_invalid');
      if (parsed.data.changes.database && binding.kind !== 'owner') throw new Error('instance_forbidden');
      if (parsed.data.changes.database && !process.env.INSTANCE_DATABASE_FILE) throw new Error('instance_operator_required');
      const control = await readInstance(db, host.instanceId);
      if (!control) throw new Error('instance_unavailable');
      if (request.headers.get('if-match') !== `"${control.editRevision}"` || parsed.data.candidateVersion !== (control.candidate?.version ?? 0)) throw new Error('instance_conflict');
      if (control.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox) throw new Error('instance_unavailable');
      const now = new Date();
      const candidate = await buildInstanceDraft(control, host.setupOrigin, parsed.data, host.keyring, binding.bindingId, now);
      const next = await updateInstance(db, host.instanceId, control.revision, current => ({ ...current, candidate,
        nextBundleVersion: current.nextBundleVersion + 1,
        auditOutbox: [...current.auditOutbox, { _id: randomUUID(), instanceId: host.instanceId, at: now, actor: binding.bindingId,
          operation: 'candidate_saved', fromVersion: current.candidate?.version ?? null, toVersion: candidate.version,
          resultCode: 'accepted', requestId: randomUUID() }],
      }), now);
      return Response.json({ ...instanceSnapshot(next), impact: candidate.impact }, {
        headers: { 'Cache-Control': 'private, no-store', ETag: `"${next.editRevision}"` },
      });
    });
  } catch (error) { return instanceErrorResponse(error); }
}
