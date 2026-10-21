import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { withInstanceProviderCheck, requireInstanceAdmin, consumeInstanceRate, instanceErrorResponse, readInstanceJson } from '@/lib/instance/access';
import { createProviderCheckRunner } from '@/lib/instance/validation';
import { decryptInstanceSecret } from '@/lib/instance/secrets';
import { INSTANCE_CHECK_TYPES, readInstance, recordInstanceCheck, type InstanceCheck } from '@/lib/instance/store';
import { LIMITS } from '@/lib/limits';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const inputSchema = z.strictObject({ candidateVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), type: z.enum(INSTANCE_CHECK_TYPES) });
export async function POST(request: Request) {
  try {
    const { db, host, control, binding } = await requireInstanceAdmin(request, true);
    await consumeInstanceRate(db, host.instanceId, binding.bindingId, 'check');
    await consumeInstanceRate(db, host.instanceId, binding.bindingId, 'mutation');
    const parsed = inputSchema.safeParse(await readInstanceJson(request));
    if (!parsed.success) throw new Error('instance_invalid');
    const candidate = control.candidate;
    if (!candidate || request.headers.get('if-match') !== `"${control.editRevision}"` || parsed.data.candidateVersion !== candidate.version) throw new Error('instance_conflict');
    const now = new Date();
    return await withInstanceProviderCheck(db, host.instanceId, async () => {
      const { type } = parsed.data;
      let result: Pick<InstanceCheck, 'status' | 'code'>;
      if (type === 'database') {
        await db.command({ ping: 1 });
        result = { status: 'passed', code: 'database_ok' };
      } else if (type === 'zitadel_owner_login') {
        const proof = candidate.ownerProof;
        const check = candidate.checks.find(item => item.type === type);
        result = proof && proof.expiresAt > now && proof.securityEpoch === control.securityEpoch &&
          check?.status === 'passed' && now.getTime() - check.at.getTime() < LIMITS.instanceProofMs
          ? { status: 'passed', code: 'provider_ok' } : { status: 'not_run', code: 'not_run' };
      } else {
        const decrypt = (purpose: 'zitadelClientSecret' | 'githubPrivateKey' | 'githubWebhookSecret') => {
          const envelope = candidate.secrets[purpose];
          return envelope ? decryptInstanceSecret(envelope, { instanceId: host.instanceId, purpose, credentialVersion: envelope.credentialVersion }, host.keyring) : null;
        };
        const testGitHubApiOrigin = process.env.NODE_ENV === 'development' ? process.env.LIBRARIAN_TEST_GITHUB_API_ORIGIN : undefined;
        const testProviderCaFile = testGitHubApiOrigin === candidate.zitadel.issuer && new URL(testGitHubApiOrigin).hostname === 'localhost' &&
          host.policy.origins.some(rule => rule.origin === testGitHubApiOrigin) ? process.env.LIBRARIAN_TEST_PROVIDER_CA_FILE : undefined;
        result = await createProviderCheckRunner({ policy: host.policy, ...(testGitHubApiOrigin ? { githubApiOrigin: testGitHubApiOrigin } : {}),
          ...(testProviderCaFile ? { ca: { origin: testGitHubApiOrigin!, certificate: await readFile(testProviderCaFile) } } : {}) }).run(type, candidate, {
          zitadelClientSecret: decrypt('zitadelClientSecret'), githubPrivateKey: decrypt('githubPrivateKey'), githubWebhookSecret: decrypt('githubWebhookSecret'),
        });
      }
      await requireInstanceAdmin(request, true);
      const latest = await readInstance(db, host.instanceId);
      if (latest?.editRevision !== control.editRevision) throw new Error('instance_conflict');
      const checked = await recordInstanceCheck(db, host.instanceId, { type, candidateVersion: candidate.version, ...result, at: new Date() });
      return Response.json(checked.candidate!.checks.find(item => item.type === type), {
        headers: { 'Cache-Control': 'private, no-store', ETag: `"${checked.editRevision}"` },
      });
    });
  } catch (error) { return instanceErrorResponse(error); }
}
