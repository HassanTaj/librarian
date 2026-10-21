import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { beginInstanceActivation, reconcileInstanceActivation } from '../../lib/instance/activation';
import { issueSetupOwnerProof } from '../../lib/instance/access';
import { createLibrarianAdapter, persistOAuthSignInTokens } from '../../lib/auth/adapter';
import { readInstance, updateInstance, type InstanceControl } from '../../lib/instance/store';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';

const checks = [
  ['database', 'passed', 'database_ok'], ['zitadel_discovery', 'passed', 'provider_ok'],
  ['github_structure', 'passed', 'provider_ok'], ['github_authentication', 'passed', 'provider_ok'],
  ['github_permissions', 'passed', 'provider_ok'], ['github_installation', 'warning', 'installation_missing'],
  ['github_webhook', 'warning', 'delivery_unverified'],
] as const;

async function saveCandidate(db: import('mongodb').Db, control: InstanceControl, changeIdentity = false) {
  const now = new Date(Math.max(Date.now(), control.updatedAt.getTime() + 1));
  const candidate = structuredClone(control.active!);
  candidate.version = control.nextBundleVersion;
  candidate.createdAt = now;
  candidate.createdBy = control.administrators[0].bindingId;
  candidate.checks = checks.map(([type, status, code]) => ({ type, status, code, candidateVersion: candidate.version, at: now }));
  candidate.ownerProof = null;
  candidate.previousUntil = null;
  candidate.impact = { categories: changeIdentity ? ['identity'] : ['preferences'], securityEpochIncrement: changeIdentity,
    revalidateSources: false, confirmationNonce: randomUUID() };
  if (changeIdentity) {
    candidate.zitadel = { ...candidate.zitadel, issuer: 'https://replacement.identity.example.test', projectId: 'replacement-project' };
    candidate.ownerProof = issueSetupOwnerProof({ ...control, candidate }, {
      issuer: candidate.zitadel.issuer, subject: 'replacement-owner', projectId: candidate.zitadel.projectId,
    }, now);
  }
  return updateInstance(db, control.instanceId, control.revision, current => ({ ...current,
    candidate, nextBundleVersion: candidate.version + 1,
  }), now);
}

it('keeps same-epoch sessions, invalidates old-epoch sessions, rejects stale callbacks, and preserves legacy OAuth ciphertext', async () => {
  const harness = await createInstanceHarness({ port: 3225 });
  const priorInstanceId = process.env.INSTANCE_ID;
  vi.stubEnv('INSTANCE_ID', harness.instanceId);
  try {
    const fixture = await seedReadyInstance(harness);
    const oauthKey = Buffer.from(await readFile(harness.env.OAUTH_TOKEN_ENCRYPTION_KEY_FILE!, 'utf8'), 'base64');
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    await persistOAuthSignInTokens(harness.storage.db, fixture.control.active!.zitadel.issuer, {
      provider: 'zitadel', providerAccountId: fixture.identity.subject, access_token: 'SYNTHETIC_OAUTH_ACCESS',
      refresh_token: 'SYNTHETIC_OAUTH_REFRESH', expires_at: expiresAt,
    }, oauthKey);
    const adapter = await createLibrarianAdapter(harness.storage.client, harness.storage.db, fixture.control.active!.zitadel.issuer, oauthKey);
    const account = await adapter.getAccount!(fixture.identity.subject, 'zitadel');
    expect(account).toMatchObject({ access_token: 'SYNTHETIC_OAUTH_ACCESS', refresh_token: 'SYNTHETIC_OAUTH_REFRESH' });

    const sessionToken = fixture.cookie.split('=', 2)[1];
    expect(await adapter.getSessionAndUser!(sessionToken)).toMatchObject({ user: { id: fixture.userId.toHexString() } });

    let current = await readInstance(harness.storage.db, harness.instanceId);
    let prepared = await saveCandidate(harness.storage.db, current!);
    await beginInstanceActivation(harness.storage.db, harness.instanceId, prepared.editRevision, prepared.candidate!.version,
      prepared.candidate!.impact!.confirmationNonce, fixture.control.administrators[0].bindingId);
    expect(await reconcileInstanceActivation(harness.env)).toBe(true);
    current = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(current.securityEpoch).toBe(fixture.control.securityEpoch);
    expect(await adapter.getSessionAndUser!(sessionToken)).not.toBeNull();

    prepared = await saveCandidate(harness.storage.db, current, true);
    await beginInstanceActivation(harness.storage.db, harness.instanceId, prepared.editRevision, prepared.candidate!.version,
      prepared.candidate!.impact!.confirmationNonce, fixture.control.administrators[0].bindingId);
    expect(await reconcileInstanceActivation(harness.env)).toBe(true);
    current = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(current.securityEpoch).toBe(fixture.control.securityEpoch + 1);
    expect(await adapter.getSessionAndUser!(sessionToken)).toBeNull();
    expect(await harness.storage.db.collection('sessions').findOne({ sessionToken })).toBeNull();
    expect(await adapter.getAccount!(fixture.identity.subject, 'zitadel')).toMatchObject({
      access_token: 'SYNTHETIC_OAUTH_ACCESS', refresh_token: 'SYNTHETIC_OAUTH_REFRESH',
    });

    const server = await harness.start();
    const staleCallback = await fetch(`${server.origin}/api/instance/auth/callback/zitadel?code=stale&state=stale`, { redirect: 'manual' });
    expect(staleCallback.status).toBe(401);
    expect(await staleCallback.text()).not.toMatch(/SYNTHETIC_OAUTH|ciphertext|replacement-owner/);
    expect(current.admissions).toHaveLength(0);
  } finally {
    if (priorInstanceId === undefined) delete process.env.INSTANCE_ID;
    else process.env.INSTANCE_ID = priorInstanceId;
    vi.unstubAllEnvs();
    await harness.close();
  }
}, 30_000);
