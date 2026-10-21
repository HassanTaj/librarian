import { instanceRuntimeInputs } from '@/lib/config';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireLegacyEnrollmentAuthority, instanceErrorResponse, readInstanceJson, readInstanceSetupSession, issueSetupOwnerProof, type InstanceSetupSession } from '@/lib/instance/access';
import { legacyInstanceDigest, readInstanceHost } from '@/lib/instance/bootstrap';
import { buildInstanceDraft, instanceSnapshot, readInstance, updateInstance } from '@/lib/instance/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
const inputSchema = z.strictObject({ confirmImport: z.literal(true), confirmationNonce: z.uuid() });
export async function POST(request: Request) {
  try {
    const { db, config, identity } = await requireLegacyEnrollmentAuthority(request);
    const host = await readInstanceHost();
    const parsed = inputSchema.safeParse(await readInstanceJson(request));
    if (!parsed.success) throw new Error('instance_invalid');
    const tokens = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith('__Host-librarian_setup='));
    if (tokens.length !== 1) throw new Error('instance_setup_unauthorized');
    const token = tokens[0].slice('__Host-librarian_setup='.length);
    const session = await readInstanceSetupSession(db, host.instanceId, token);
    const record = await db.collection<InstanceSetupSession>('instance_setup_sessions').findOne({ _id: createHash('sha256').update(token).digest('hex'), instanceId: host.instanceId });
    const current = await readInstance(db, host.instanceId);
    if (session.purpose !== 'legacy_enrollment' || !record || record.lastNonceHash !== createHash('sha256').update(parsed.data.confirmationNonce).digest('hex') ||
        !current?.migration || current.initializedAt || current.active || current.candidate || current.lifecycle !== 'legacy_migrating' ||
        request.headers.get('if-match') !== `"${current.editRevision}"` || legacyInstanceDigest(config) !== current.migration.sourceDigest) throw new Error('instance_migration_conflict');
    const now = new Date();
    const draft = await buildInstanceDraft(current, host.setupOrigin, { candidateVersion: 0, changes: { publicOrigin: config.authUrl,
      zitadel: { issuer: config.zitadelIssuer, clientId: config.zitadelClientId, projectId: config.zitadelProjectId, apiAudience: config.zitadelApiAudience }, github: { appId: config.githubAppId } },
      secretReplacements: { zitadelClientSecret: { action: 'replace', value: config.zitadelSecret }, githubPrivateKey: { action: 'replace', value: config.githubPrivateKey }, githubWebhookSecret: { action: 'replace', value: config.githubWebhookSecret } },
    }, host.keyring, 'legacy_operator', now);
    const proof = issueSetupOwnerProof({ ...current, lifecycle: 'configuring', candidate: draft }, identity, now);
    draft.runtime = instanceRuntimeInputs(config);
    draft.ownerProof = proof;
    draft.checks = [{ type: 'zitadel_owner_login', candidateVersion: draft.version, at: now, status: 'passed', code: 'provider_ok' }];
    const next = await updateInstance(db, host.instanceId, current.revision, value => ({ ...value, lifecycle: 'awaiting_owner', candidate: draft,
      nextBundleVersion: value.nextBundleVersion + 1,
    }), now);
    return Response.json({ ...instanceSnapshot(next), nextUrl: '/instance/setup' }, { headers: { 'Cache-Control': 'private, no-store', ETag: `"${next.editRevision}"` } });
  } catch (error) { return instanceErrorResponse(error); }
}
