import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireInstanceAdmin, consumeInstanceRate, instanceErrorResponse, readInstanceJson } from '@/lib/instance/access';
import { instanceSnapshot, updateInstance } from '@/lib/instance/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
const inputSchema = z.strictObject({ previousVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), confirmationNonce: z.uuid(), confirm: z.literal(true) });
export async function POST(request: Request) {
  try {
    const { db, host, control, binding } = await requireInstanceAdmin(request, true);
    await consumeInstanceRate(db, host.instanceId, binding.bindingId, 'mutation');
    const parsed = inputSchema.safeParse(await readInstanceJson(request));
    if (!parsed.success) throw new Error('instance_invalid');
    const previous = control.previous;
    const active = control.active!;
    if (!previous || previous.previousUntil! <= new Date() || parsed.data.previousVersion !== previous.version ||
        parsed.data.confirmationNonce !== active.impact?.confirmationNonce || request.headers.get('if-match') !== `"${control.editRevision}"`) throw new Error('instance_conflict');
    if (binding.kind !== 'owner') throw new Error('instance_forbidden');
    // A retired webhook credential needs a new explicit replacement, never a renewed overlap.
    if (previous.secrets.githubWebhookSecret.credentialVersion !== active.secrets.githubWebhookSecret.credentialVersion) throw new Error('instance_owner_continuity_required');
    const now = new Date();
    const candidate = { ...structuredClone(previous), version: control.nextBundleVersion, createdAt: now, createdBy: binding.bindingId,
      previousUntil: null, checks: [], ownerProof: null,
      impact: { categories: ['preferences', 'origin', 'identity', 'github'] as ('preferences' | 'origin' | 'identity' | 'github')[],
        securityEpochIncrement: true, revalidateSources: true, confirmationNonce: randomUUID() } };
    const next = await updateInstance(db, host.instanceId, control.revision, value => ({ ...value, candidate, nextBundleVersion: value.nextBundleVersion + 1,
      auditOutbox: [...value.auditOutbox, { _id: randomUUID(), instanceId: host.instanceId, at: now, actor: binding.bindingId,
        operation: 'rollback', fromVersion: active.version, toVersion: candidate.version, resultCode: 'candidate_created', requestId: randomUUID() }],
    }), now);
    return Response.json({ ...instanceSnapshot(next), impact: candidate.impact }, { headers: { 'Cache-Control': 'private, no-store', ETag: `"${next.editRevision}"` } });
  } catch (error) { return instanceErrorResponse(error); }
}
