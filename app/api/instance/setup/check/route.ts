import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { connectMongo } from '@/lib/mongo';
import { LIMITS } from '@/lib/limits';
import { readInstanceHost } from '@/lib/instance/bootstrap';
import { withInstanceProviderCheck, consumeInstanceRate, instanceErrorResponse, readInstanceJson, readInstanceSetupSession } from '@/lib/instance/access';
import { createProviderCheckRunner } from '@/lib/instance/validation';
import { decryptInstanceSecret } from '@/lib/instance/secrets';
import { INSTANCE_CHECK_TYPES, readInstance, recordInstanceCheck, type InstanceCheck, type InstanceControl } from '@/lib/instance/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const inputSchema = z.strictObject({ candidateVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), type: z.enum(INSTANCE_CHECK_TYPES) });
type CheckType = typeof INSTANCE_CHECK_TYPES[number];
type CheckResult = Pick<InstanceCheck, 'type' | 'candidateVersion' | 'status' | 'code'> & { at?: Date };

function setupCookie(request: Request) {
  return request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('__Host-librarian_setup='))?.slice('__Host-librarian_setup='.length) ?? '';
}

function credential(host: Awaited<ReturnType<typeof readInstanceHost>>, control: InstanceControl, purpose: 'zitadelClientSecret' | 'githubPrivateKey' | 'githubWebhookSecret') {
  const envelope = control.candidate?.secrets[purpose];
  if (!envelope) return null;
  try { return decryptInstanceSecret(envelope, { instanceId: host.instanceId, purpose, credentialVersion: envelope.credentialVersion }, host.keyring); }
  catch { return null; }
}

function proofIsCurrent(control: InstanceControl, check: InstanceCheck | undefined, now: Date) {
  const candidate = control.candidate;
  const proof = candidate?.ownerProof;
  return !!candidate && !!proof && !!check && check.type === 'zitadel_owner_login' && check.candidateVersion === candidate.version &&
    check.status === 'passed' && check.code === 'provider_ok' && proof.instanceId === control.instanceId && proof.candidateVersion === candidate.version &&
    proof.issuer === candidate.zitadel.issuer && proof.projectId === candidate.zitadel.projectId && proof.securityEpoch === control.securityEpoch && proof.expiresAt > now &&
    check.at.getTime() + LIMITS.instanceProofMs > now.getTime();
}

export async function POST(request: Request) {
  try {
    const host = await readInstanceHost();
    if (request.headers.get('origin') !== host.setupOrigin) throw new Error('instance_origin');
    const token = setupCookie(request);
    const csrfToken = request.headers.get('x-csrf-token') ?? '';
    const storage = await connectMongo(host.config, { initializeLegacy: false });
    try {
      await readInstanceSetupSession(storage.db, host.instanceId, token, csrfToken);
      await consumeInstanceRate(storage.db, host.instanceId, host.instanceId, 'setup_check');
      const parsed = inputSchema.safeParse(await readInstanceJson(request));
      if (!parsed.success) throw new Error('instance_invalid');
      const control = await readInstance(storage.db, host.instanceId);
      const candidate = control?.candidate;
      if (!control || !candidate || !['configuring', 'awaiting_owner'].includes(control.lifecycle) || control.bootstrap.consumedAt) throw new Error('instance_unavailable');
      if (request.headers.get('if-match') !== `"${control.editRevision}"` || parsed.data.candidateVersion !== candidate.version) throw new Error('instance_conflict');

      return await withInstanceProviderCheck(storage.db, host.instanceId, async () => {
      const type: CheckType = parsed.data.type;
      let result: CheckResult;
      const now = new Date();
      if (type === 'database') {
        try {
          await storage.db.command({ ping: 1 });
          result = { type, candidateVersion: candidate.version, status: 'passed', code: 'database_ok' };
        } catch { result = { type, candidateVersion: candidate.version, status: 'failed', code: 'provider_unavailable' }; }
      } else if (type === 'zitadel_owner_login') {
        const existing = candidate.checks.find(item => item.type === type);
        if (existing && proofIsCurrent(control, existing, now)) result = existing;
        else result = { type, candidateVersion: candidate.version, status: 'not_run', code: 'not_run' };
      } else if (type === 'github_webhook') {
        const existing = candidate.checks.find(item => item.type === type);
        if (existing?.status === 'passed' && existing.code === 'provider_ok' && existing.candidateVersion === candidate.version) result = existing;
        else result = { type, candidateVersion: candidate.version, status: 'warning', code: 'delivery_unverified' };
      } else {
        const testGitHubApiOrigin = process.env.NODE_ENV === 'development' ? process.env.LIBRARIAN_TEST_GITHUB_API_ORIGIN : undefined;
        const testProviderCaFile = testGitHubApiOrigin === candidate.zitadel.issuer && new URL(testGitHubApiOrigin).hostname === 'localhost' &&
          host.policy.origins.some(rule => rule.origin === testGitHubApiOrigin) ? process.env.LIBRARIAN_TEST_PROVIDER_CA_FILE : undefined;
        const runner = createProviderCheckRunner({ policy: host.policy, ...(testGitHubApiOrigin ? { githubApiOrigin: testGitHubApiOrigin } : {}),
          ...(testProviderCaFile ? { ca: { origin: testGitHubApiOrigin!, certificate: await readFile(testProviderCaFile) } } : {}) });
        const credentials = {
          zitadelClientSecret: credential(host, control, 'zitadelClientSecret'),
          githubPrivateKey: credential(host, control, 'githubPrivateKey'),
          githubWebhookSecret: credential(host, control, 'githubWebhookSecret'),
        };
        result = await runner.run(type, candidate, credentials);
      }

      await readInstanceSetupSession(storage.db, host.instanceId, token, csrfToken);
      if (result.at) return Response.json(result, { headers: { 'Cache-Control': 'private, no-store', ETag: `"${control.editRevision}"` } });
      const checked = await recordInstanceCheck(storage.db, host.instanceId, { ...result, at: new Date() });
      const saved = checked.candidate?.checks.find(item => item.type === type);
      if (!saved) throw new Error('instance_unavailable');
      return Response.json(saved, { headers: { 'Cache-Control': 'private, no-store', ETag: `"${checked.editRevision}"` } });
      });
    } finally { await storage.client.close(); }
  } catch (error) { return instanceErrorResponse(error); }
}
