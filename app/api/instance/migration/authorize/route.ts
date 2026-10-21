import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorizeInstanceSetup, requireLegacyEnrollmentAuthority, instanceErrorResponse, readInstanceJson, type InstanceSetupSession } from '@/lib/instance/access';
import { readInstanceHost, legacyInstanceDigest } from '@/lib/instance/bootstrap';
import { readInstance, updateInstance } from '@/lib/instance/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
const inputSchema = z.strictObject({ credential: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/) });
export async function POST(request: Request) {
  try {
    const { db, config } = await requireLegacyEnrollmentAuthority(request);
    const host = await readInstanceHost();
    if (host.operator.purpose !== 'enroll' || Date.parse(host.operator.expiresAt) <= Date.now()) throw new Error('instance_forbidden');
    const input = inputSchema.safeParse(await readInstanceJson(request));
    if (!input.success) throw new Error('instance_invalid');
    const session = await authorizeInstanceSetup(db, host.instanceId, input.data.credential, new Date(), 'legacy_enrollment');
    const current = await readInstance(db, host.instanceId);
    if (!current?.migration || current.initializedAt || current.active) throw new Error('instance_conflict');
    const next = await updateInstance(db, host.instanceId, current.revision, value => ({ ...value,
      migration: { ...value.migration!, sourceDigest: legacyInstanceDigest(config) },
    }));
    const confirmationNonce = randomUUID();
    await db.collection<InstanceSetupSession>('instance_setup_sessions').updateOne({ _id: createHash('sha256').update(session.token).digest('hex'), instanceId: host.instanceId },
      { $set: { lastNonceHash: createHash('sha256').update(confirmationNonce).digest('hex') } });
    const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
    const headers = new Headers({ 'Cache-Control': 'private, no-store', ETag: `"${next.editRevision}"` });
    headers.append('Set-Cookie', `__Host-librarian_setup=${session.token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`);
    headers.append('Set-Cookie', `__Host-librarian_setup_csrf=${session.csrfToken}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`);
    return Response.json({ expiresAt: session.expiresAt, csrfToken: session.csrfToken, editRevision: next.editRevision, confirmationNonce,
      message: 'Review and explicitly import the current legacy configuration. Catalogs, accounts and snapshots are retained.' }, { headers });
  } catch (error) { return instanceErrorResponse(error); }
}
