import { createHash } from 'node:crypto';
import { z } from 'zod';
import { connectMongo } from '@/lib/mongo';
import { LIMITS } from '@/lib/limits';
import { readInstanceHost } from '@/lib/instance/bootstrap';
import { consumeInstanceRate, instanceErrorResponse, readInstanceJson, readInstanceSetupSession } from '@/lib/instance/access';
import { commitInitialInstance, initialFinalizeReplay, reconcileInitialAdoption } from '@/lib/instance/activation';
import { readInstance } from '@/lib/instance/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const inputSchema = z.strictObject({ candidateVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), confirmationNonce: z.uuid(), confirm: z.literal(true) });

function setupCookie(request: Request) {
  return request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('__Host-librarian_setup='))?.slice('__Host-librarian_setup='.length) ?? '';
}

function pending(candidateVersion: number, editRevision?: number) {
  return Response.json({ status: 'pending', candidateVersion }, { status: 202,
    headers: { 'Cache-Control': 'private, no-store', ...(editRevision === undefined ? {} : { ETag: `"${editRevision}"` }) } });
}

function ready(candidateVersion: number, editRevision?: number) {
  return Response.json({ status: 'ready', candidateVersion, nextUrl: '/' }, { headers: {
    'Cache-Control': 'private, no-store', ...(editRevision === undefined ? {} : { ETag: `"${editRevision}"` }),
  } });
}

export async function POST(request: Request) {
  try {
    const host = await readInstanceHost();
    if (request.headers.get('origin') !== host.setupOrigin) throw new Error('instance_origin');
    const parsed = inputSchema.safeParse(await readInstanceJson(request));
    if (!parsed.success) throw new Error('instance_invalid');
    const { candidateVersion, confirmationNonce } = parsed.data;
    const storage = await connectMongo(host.config, { initializeLegacy: false });
    try {
      let current = await readInstance(storage.db, host.instanceId);
      if (initialFinalizeReplay(current, candidateVersion, confirmationNonce)) {
        const reconciled = await reconcileInitialAdoption();
        const latest = await readInstance(storage.db, host.instanceId);
        return reconciled && latest?.lifecycle === 'ready' && latest.gate.state === 'open'
          ? ready(candidateVersion, latest.editRevision) : pending(candidateVersion, latest?.editRevision);
      }
      const token = setupCookie(request);
      await readInstanceSetupSession(storage.db, host.instanceId, token, request.headers.get('x-csrf-token') ?? '');
      await consumeInstanceRate(storage.db, host.instanceId, host.instanceId, 'mutation');
      current = await readInstance(storage.db, host.instanceId);
      if (!current || !current.candidate || request.headers.get('if-match') !== `"${current.editRevision}"` || current.candidate.version !== candidateVersion) {
        throw new Error('instance_conflict');
      }
      const proof = current.candidate.ownerProof;
      if (!proof || proof.instanceId !== host.instanceId || proof.candidateVersion !== candidateVersion || proof.issuer !== current.candidate.zitadel.issuer ||
          proof.projectId !== current.candidate.zitadel.projectId || proof.securityEpoch !== current.securityEpoch || proof.expiresAt <= new Date()) {
        throw new Error('instance_owner_continuity_required');
      }
      const roleId = createHash('sha256').update(`${proof.issuer}\0${proof.subject}\0${proof.projectId}`).digest('hex');
      const roleState = await storage.db.collection<{ _id: string; issuer: string; subject: string; projectId: string; roles: string[]; verifiedAt: Date | null }>('identity_authorizations')
        .findOne({ _id: roleId });
      const now = new Date();
      if (!roleState || roleState.issuer !== proof.issuer || roleState.subject !== proof.subject || roleState.projectId !== proof.projectId ||
          !Array.isArray(roleState.roles) || !roleState.roles.includes('librarian-instance-admin') || !(roleState.verifiedAt instanceof Date) || roleState.verifiedAt > now ||
          now.getTime() - roleState.verifiedAt.getTime() >= LIMITS.roleFreshMs) throw new Error('instance_owner_continuity_required');
      try {
        const committed = await commitInitialInstance(storage.db, host.instanceId, current.revision, candidateVersion, confirmationNonce, now);
        const reconciled = await reconcileInitialAdoption();
        const latest = await readInstance(storage.db, host.instanceId);
        return reconciled && latest?.lifecycle === 'ready' && latest.gate.state === 'open'
          ? ready(candidateVersion, latest.editRevision) : pending(candidateVersion, committed.editRevision);
      } catch (error) {
        if (error instanceof Error && error.message === 'instance_conflict') {
          const latest = await readInstance(storage.db, host.instanceId).catch(() => null);
          if (initialFinalizeReplay(latest, candidateVersion, confirmationNonce)) return pending(candidateVersion, latest!.editRevision);
        }
        throw error;
      }
    } finally { await storage.client.close(); }
  } catch (error) { return instanceErrorResponse(error); }
}
