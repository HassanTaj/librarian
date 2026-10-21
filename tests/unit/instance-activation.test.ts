import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { beginInstanceActivation, commitInitialInstance, initialFinalizeReplay } from '../../lib/instance/activation';
import { InstanceDraftPatchSchema, buildInstanceDraft, InstanceControlSchema } from '../../lib/instance/store';
import { decryptInstanceSecret, rotateInstanceBundles } from '../../lib/instance/secrets';
import { issueSetupCandidateFlow, issueSetupOwnerProof, readInstanceSetupSession, verifySetupCandidateFlow, type InstanceSetupSession } from '../../lib/instance/access';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { LIMITS } from '../../lib/limits';

const keyring = { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } };
function dbFor(control: ReturnType<typeof readyInstance>) {
  return { collection: () => ({ findOne: async () => structuredClone(control), replaceOne: async (_filter: unknown, next: typeof control) => {
    Object.assign(control, next); return { matchedCount: 1 };
  } }) } as unknown as Db;
}

function checkedCandidate(control: ReturnType<typeof readyInstance>, now: Date) {
  const candidate = structuredClone(control.active ?? readyInstance(control.instanceId, control.createdAt).active)!;
  candidate.version = control.nextBundleVersion++;
  candidate.createdAt = now; candidate.createdBy = control.administrators[0]?.bindingId ?? 'synthetic-operator';
  candidate.impact = { categories: [], securityEpochIncrement: false, revalidateSources: false, confirmationNonce: randomUUID() };
  candidate.checks = ['database', 'zitadel_discovery', 'zitadel_owner_login', 'github_structure', 'github_authentication', 'github_permissions', 'github_installation', 'github_webhook'].map(type => ({
    type: type as typeof candidate.checks[number]['type'], candidateVersion: candidate.version, at: now, status: 'passed', code: 'provider_ok',
  }));
  control.candidate = candidate;
  candidate.ownerProof = issueSetupOwnerProof(control, { issuer: candidate.zitadel.issuer, subject: 'synthetic-owner', projectId: candidate.zitadel.projectId }, now);
  return candidate;
}

it('rejects missing, failed, stale and future activation evidence while leaving the active bundle untouched', async () => {
  const now = new Date();
  const cases: Array<(control: ReturnType<typeof readyInstance>) => void> = [
    value => { value.candidate!.checks = []; },
    value => { value.candidate!.checks[0].status = 'failed'; },
    value => { value.candidate!.checks[0].status = 'warning'; },
    value => { value.candidate!.checks[0].at = new Date(now.getTime() - LIMITS.instanceProofMs); value.candidate!.createdAt = value.createdAt; },
    value => { value.candidate!.checks[0].at = new Date(now.getTime() + 1); value.updatedAt = new Date(now.getTime() + 1); },
    value => { const check = value.candidate!.checks.find(item => item.type === 'github_installation')!; check.status = 'warning'; check.code = 'permission_denied'; },
    value => { const check = value.candidate!.checks.find(item => item.type === 'github_webhook')!; check.status = 'warning'; check.code = 'permission_denied'; },
  ];
  for (const mutate of cases) {
    const control = readyInstance(randomUUID(), new Date(now.getTime() - LIMITS.instanceProofMs));
    control.updatedAt = now; const candidate = checkedCandidate(control, now); mutate(control);
    const before = structuredClone(control.active);
    await expect(beginInstanceActivation(dbFor(control), control.instanceId, control.editRevision, candidate.version,
      candidate.impact!.confirmationNonce, control.administrators[0].bindingId, now)).rejects.toThrow();
    expect(control.active).toEqual(before); expect(control.gate.state).toBe('open');
  }
  const control = readyInstance(randomUUID(), now); const candidate = checkedCandidate(control, now);
  candidate.checks = candidate.checks.map(check => check.type === 'github_installation' || check.type === 'github_webhook'
    ? { ...check, status: 'warning', code: check.type === 'github_installation' ? 'installation_missing' : 'delivery_unverified' } : check);
  expect((await beginInstanceActivation(dbFor(control), control.instanceId, control.editRevision, candidate.version,
    candidate.impact!.confirmationNonce, control.administrators[0].bindingId, now)).activation?.phase).toBe('draining');
});

it('requires current owner continuity proof for a changed identity boundary', async () => {
  const now = new Date();
  for (const mutation of ['missing', 'epoch', 'expired', 'future-candidate', 'retired-actor', 'wrong-actor'] as const) {
    const control = readyInstance(randomUUID(), new Date(now.getTime() - 1000)); control.updatedAt = now;
    const candidate = checkedCandidate(control, now); candidate.impact!.categories = ['identity']; candidate.impact!.securityEpochIncrement = true;
    let actor = control.administrators[0].bindingId;
    if (mutation === 'missing') candidate.ownerProof = null;
    if (mutation === 'epoch') candidate.ownerProof!.securityEpoch++;
    if (mutation === 'expired') { candidate.createdAt = control.createdAt; candidate.ownerProof!.expiresAt = new Date(now.getTime() - 1); }
    if (mutation === 'future-candidate') { candidate.createdAt = new Date(now.getTime() + 1); control.updatedAt = candidate.createdAt; candidate.checks = candidate.checks.map(check => ({ ...check, at: candidate.createdAt })); }
    if (mutation === 'retired-actor') { control.administrators[0].status = 'retired'; control.administrators.push({ ...control.administrators[0], status: 'active', bindingId: randomUUID(), subject: 'replacement-owner' }); }
    if (mutation === 'wrong-actor') actor = randomUUID();
    await expect(beginInstanceActivation(dbFor(control), control.instanceId, control.editRevision, candidate.version,
      candidate.impact!.confirmationNonce, actor, now)).rejects.toThrow();
    expect(control.gate.state).toBe('open');
  }
  const valid = readyInstance(randomUUID(), now); const candidate = checkedCandidate(valid, now);
  candidate.impact!.categories = ['identity']; candidate.impact!.securityEpochIncrement = true;
  expect((await beginInstanceActivation(dbFor(valid), valid.instanceId, valid.editRevision, candidate.version,
    candidate.impact!.confirmationNonce, valid.administrators[0].bindingId, now)).gate.state).toBe('closing');
});

it('finalizes only complete fresh initial evidence and recognizes only the exact committed replay', async () => {
  const now = new Date();
  const mutations: Array<(control: ReturnType<typeof instanceControl>) => void> = [
    value => { value.bootstrap.expiresAt = now; }, value => { value.lifecycle = 'configuring'; },
    value => { value.candidate!.ownerProof!.securityEpoch++; },
    value => { value.candidate!.checks = value.candidate!.checks.filter(check => check.type !== 'database'); },
    value => { value.candidate!.checks.find(check => check.type === 'github_authentication')!.status = 'failed'; },
    value => { value.candidate!.checks.find(check => check.type === 'zitadel_owner_login')!.code = 'not_run'; },
    value => { value.candidate!.checks[0].at = new Date(now.getTime() - LIMITS.instanceProofMs); },
  ];
  for (const mutate of mutations) {
    const control = instanceControl(randomUUID(), new Date(now.getTime() - LIMITS.instanceProofMs));
    control.updatedAt = now; const candidate = checkedCandidate(control, now); control.lifecycle = 'awaiting_owner'; mutate(control);
    await expect(commitInitialInstance(dbFor(control), control.instanceId, control.revision, candidate.version,
      candidate.impact!.confirmationNonce, now)).rejects.toThrow();
    expect(control.active).toBeNull(); expect(control.bootstrap.consumedAt).toBeNull();
  }
  const control = instanceControl(randomUUID(), now); const candidate = checkedCandidate(control, now); control.lifecycle = 'awaiting_owner';
  const nonce = candidate.impact!.confirmationNonce;
  const finalized = await commitInitialInstance(dbFor(control), control.instanceId, control.revision, candidate.version, nonce, now);
  expect(finalized).toMatchObject({ lifecycle: 'maintenance', active: { version: candidate.version }, candidate: null,
    gate: { state: 'maintenance' }, activation: { phase: 'adopting', actor: 'bootstrap' }, bootstrap: { consumedAt: now } });
  expect(initialFinalizeReplay(finalized, candidate.version, nonce)).toBe(true);
  expect(initialFinalizeReplay(finalized, candidate.version + 1, nonce)).toBe(false);
  expect(initialFinalizeReplay(finalized, candidate.version, randomUUID())).toBe(false);
  expect(initialFinalizeReplay(null, candidate.version, nonce)).toBe(false);
});

it('saves a strict partial draft without changing active state, retaining explicit secrets across later edits', async () => {
  const control = readyInstance();
  const original = structuredClone(control.active);
  const first = await buildInstanceDraft(control, control.active!.publicOrigin, InstanceDraftPatchSchema.parse({ candidateVersion: 0,
    changes: {}, secretReplacements: { githubWebhookSecret: { action: 'replace', value: 'REPLACEMENT_SENTINEL' } },
  }), keyring, control.administrators[0].bindingId);
  expect(control.active).toEqual(original);
  expect(first.impact?.categories).toEqual(['webhook']);
  const nextControl = { ...control, candidate: first, nextBundleVersion: first.version + 1 };
  const second = await buildInstanceDraft(nextControl, original!.publicOrigin, { candidateVersion: first.version, changes: { displayName: 'New name' } }, keyring, control.administrators[0].bindingId);
  expect(second.impact?.categories).toEqual(['preferences', 'webhook']);
  expect(second.secrets.githubWebhookSecret).toEqual(first.secrets.githubWebhookSecret);
  expect(second.checks).toEqual([]); expect(second.ownerProof).toBeNull();
  expect(second.impact?.confirmationNonce).not.toBe(first.impact?.confirmationNonce);
  expect(second.version).toBe(first.version + 1);
  for (const invalid of [
    { candidateVersion: 0, changes: { renderer: 'executable' } },
    { candidateVersion: 0, changes: {} },
    { candidateVersion: 0, changes: { defaultDocsFolder: '../private' } },
    { candidateVersion: 0, changes: { publicOrigin: 'https://portal.test/path' } },
    { candidateVersion: 0, changes: {}, secretReplacements: { githubWebhookSecret: { action: 'replace', value: '' } } },
  ]) expect(InstanceDraftPatchSchema.safeParse(invalid).success).toBe(false);
});

it('distinguishes client-secret replacement from an identity-boundary change', async () => {
  const control = readyInstance();
  const replacement = await buildInstanceDraft(control, control.active!.publicOrigin, { candidateVersion: 0, changes: {},
    secretReplacements: { zitadelClientSecret: { action: 'replace', value: 'new-synthetic-secret' } } }, keyring, control.administrators[0].bindingId);
  expect(replacement.impact?.categories).toEqual(['identity']);
  expect(replacement.impact?.securityEpochIncrement).toBe(false);
  const boundary = await buildInstanceDraft(control, control.active!.publicOrigin, { candidateVersion: 0, changes: { zitadel: { projectId: 'replacement-project' } } }, keyring, control.administrators[0].bindingId);
  expect(boundary.impact?.securityEpochIncrement).toBe(true);
});

it('closes admission for the exact current actor/revision/nonce and rejects stale or unverified activation', async () => {
  const now = new Date();
  const control = readyInstance(randomUUID(), now);
  const actor = control.administrators[0].bindingId;
  control.candidate = await buildInstanceDraft(control, control.active!.publicOrigin, { candidateVersion: 0, changes: { displayName: 'Reviewed' } }, keyring, actor, now);
  control.nextBundleVersion++;
  const candidate = control.candidate;
  candidate.checks = ['database', 'zitadel_discovery', 'github_structure', 'github_authentication', 'github_permissions', 'github_installation', 'github_webhook'].map(type => ({
    type: type as typeof candidate.checks[number]['type'], candidateVersion: candidate.version, at: now, status: 'passed', code: 'provider_ok',
  }));
  const nonce = candidate.impact!.confirmationNonce;
  const db = dbFor(control);
  await expect(beginInstanceActivation(db, control.instanceId, control.editRevision + 1, candidate.version, nonce, actor, now)).rejects.toThrow('instance_conflict');
  await expect(beginInstanceActivation(db, control.instanceId, control.editRevision, candidate.version, randomUUID(), actor, now)).rejects.toThrow('instance_conflict');
  await expect(beginInstanceActivation(db, control.instanceId, control.editRevision, candidate.version, nonce, actor, new Date(now.getTime() + 600_000))).rejects.toThrow('instance_conflict');
  const active = structuredClone(control.active);
  const result = await beginInstanceActivation(db, control.instanceId, control.editRevision, candidate.version, nonce, actor, now);
  expect(result.gate.state).toBe('closing'); expect(result.activation?.phase).toBe('draining');
  expect(result.active).toEqual(active); expect(result.activation?.deadline.getTime()).toBe(now.getTime() + 120_000);
  await expect(beginInstanceActivation(db, control.instanceId, control.editRevision, candidate.version, nonce, actor, now)).rejects.toThrow('instance_conflict');
});

it('requires the bound owner to confirm identity and origin continuity impacts', async () => {
  const now = new Date();
  for (const changes of [{ zitadel: { projectId: 'replacement-project' } }, { publicOrigin: 'https://replacement.example.test' }]) {
    const control = readyInstance(randomUUID(), now);
    const owner = control.administrators[0];
    const adminId = randomUUID();
    control.administrators.push({ bindingId: adminId, issuer: owner.issuer, subject: 'synthetic-bound-admin', projectId: owner.projectId,
      kind: 'administrator', status: 'active', boundAt: now, boundByActionId: randomUUID() });
    control.candidate = await buildInstanceDraft(control, control.active!.publicOrigin, { candidateVersion: 0, changes }, keyring, adminId, now);
    control.nextBundleVersion++;
    const candidate = control.candidate;
    candidate.checks = ['database', 'zitadel_discovery', 'github_structure', 'github_authentication', 'github_permissions', 'github_installation', 'github_webhook'].map(type => ({
      type: type as typeof candidate.checks[number]['type'], candidateVersion: candidate.version, at: now,
      status: type === 'github_installation' || type === 'github_webhook' ? 'warning' : 'passed',
      code: type === 'github_installation' ? 'installation_missing' : type === 'github_webhook' ? 'delivery_unverified' : 'provider_ok',
    }));
    await expect(beginInstanceActivation(dbFor(control), control.instanceId, control.editRevision, candidate.version,
      candidate.impact!.confirmationNonce, adminId, now)).rejects.toThrow('instance_owner_continuity_required');
    expect(control.gate.state).toBe('open');
  }
});

it('rotates every retained envelope while preserving plaintext, credential identity, deadlines and old-key recovery', () => {
  const control = readyInstance();
  control.previous = structuredClone(control.active);
  control.previous!.previousUntil = new Date(control.createdAt.getTime() + 24 * 3600_000);
  control.candidate = structuredClone(control.active);
  control.active!.secrets.previousWebhook = { envelope: structuredClone(control.active!.secrets.githubWebhookSecret), acceptUntil: new Date(Date.now() + 300_000) };
  const ring = { activeKeyId: 'replacement-root', keys: { ...keyring.keys, 'replacement-root': Buffer.alloc(32, 2) } };
  const rotated = rotateInstanceBundles(control, ring);
  for (const bundle of [rotated.active, rotated.previous, rotated.candidate]) for (const purpose of ['zitadelClientSecret', 'githubPrivateKey', 'githubWebhookSecret'] as const) {
    const envelope = bundle!.secrets[purpose]!;
    expect(envelope.keyId).toBe('replacement-root');
    expect(decryptInstanceSecret(envelope, { instanceId: control.instanceId, purpose, credentialVersion: envelope.credentialVersion }, ring)).toBe('synthetic');
    expect(envelope.credentialVersion).toBe(control.active!.secrets[purpose].credentialVersion);
  }
  expect(rotated.active!.secrets.previousWebhook?.acceptUntil).toEqual(control.active!.secrets.previousWebhook.acceptUntil);
  expect(rotated.previous!.previousUntil).toEqual(control.previous!.previousUntil);
  expect(control.active!.secrets.githubPrivateKey.keyId).toBe('synthetic-root');
  expect(() => rotateInstanceBundles(control, { activeKeyId: 'replacement-root', keys: { 'replacement-root': Buffer.alloc(32, 2) } })).toThrow('instance_secret_invalid');
});

it('limits recovery candidate login to initialized maintenance and the current setup/recovery/security epochs', () => {
  const control = readyInstance(); const now = control.createdAt;
  control.lifecycle = 'maintenance'; control.gate.state = 'maintenance';
  control.candidate = structuredClone(control.active); control.candidate!.version = control.nextBundleVersion++;
  const token = Buffer.alloc(32, 3).toString('base64url'); const secret = 'synthetic-authority'.repeat(3);
  const flow = issueSetupCandidateFlow(secret, control, token, now, undefined, true);
  expect(verifySetupCandidateFlow(secret, flow, control, token, now)?.recovery).toBe(true);
  expect(verifySetupCandidateFlow(secret, flow, { ...control, recoveryEpoch: 2 }, token, now)).toBeNull();
  expect(verifySetupCandidateFlow(secret, flow, { ...control, securityEpoch: 2 }, token, now)).toBeNull();
  expect(verifySetupCandidateFlow(secret, flow, { ...control, lifecycle: 'ready' }, token, now)).toBeNull();
  expect(verifySetupCandidateFlow(secret, flow, control, token, new Date(now.getTime() + 600_000))).toBeNull();
  expect(InstanceControlSchema.safeParse(control).success).toBe(true);
  const proof = issueSetupOwnerProof(control, { issuer: control.active!.zitadel.issuer, subject: 'verified-target', projectId: control.active!.zitadel.projectId }, now);
  expect(proof.subject).toBe('verified-target'); expect(proof.expiresAt.getTime()).toBe(now.getTime() + 600_000);
});

it('keeps recovery sessions narrowly scoped and expires them even when TTL deletion has not run', async () => {
  const now = new Date(); const control = readyInstance(randomUUID(), now);
  control.lifecycle = 'maintenance'; control.gate.state = 'maintenance';
  const token = Buffer.alloc(32, 4).toString('base64url'); const csrf = Buffer.alloc(32, 5).toString('base64url');
  const expiresAt = new Date(now.getTime() + 30 * 60_000);
  const session: InstanceSetupSession = { _id: createHash('sha256').update(token).digest('hex'), instanceId: control.instanceId,
    setupEpoch: control.bootstrap.epoch, recoveryEpoch: control.recoveryEpoch, createdAt: now, expiresAt,
    purgeAt: new Date(expiresAt.getTime() + 3600_000), csrfHash: createHash('sha256').update(csrf).digest('hex'),
    candidateVersion: 0, lastNonceHash: null, purpose: 'recovery' };
  const db = { collection: (name: string) => ({ findOne: async () => structuredClone(name === 'instance_configuration' ? control : session) }) } as unknown as Db;
  await expect(readInstanceSetupSession(db, control.instanceId, token, csrf, now)).resolves.toMatchObject({ purpose: 'recovery' });
  await expect(readInstanceSetupSession(db, control.instanceId, token, 'wrong', now)).rejects.toThrow('instance_csrf');
  await expect(readInstanceSetupSession(db, control.instanceId, token, csrf, expiresAt)).rejects.toThrow('instance_setup_unauthorized');
  session.recoveryEpoch++;
  await expect(readInstanceSetupSession(db, control.instanceId, token, csrf, now)).rejects.toThrow('instance_setup_unauthorized');
  session.recoveryEpoch--; session.purpose = 'bootstrap';
  await expect(readInstanceSetupSession(db, control.instanceId, token, csrf, now)).rejects.toThrow('instance_setup_closed');
  session.purpose = 'recovery'; control.lifecycle = 'ready'; control.gate.state = 'open';
  await expect(readInstanceSetupSession(db, control.instanceId, token, csrf, now)).rejects.toThrow('instance_setup_closed');
});

it('binds ready-instance candidate continuity to the current owner rather than a catalog administrator', () => {
  const control = readyInstance(); const now = control.createdAt;
  control.candidate = structuredClone(control.active); control.candidate!.version = control.nextBundleVersion++;
  const token = Buffer.alloc(32, 6).toString('base64url'); const secret = 'synthetic-authority'.repeat(3);
  const ownerId = control.administrators[0].bindingId;
  const signed = issueSetupCandidateFlow(secret, control, token, now, ownerId);
  expect(verifySetupCandidateFlow(secret, signed, control, token, now)?.ownerBindingId).toBe(ownerId);
  expect(() => issueSetupCandidateFlow(secret, control, token, now, randomUUID())).toThrow('instance_forbidden');
  control.administrators[0].status = 'retired';
  expect(verifySetupCandidateFlow(secret, signed, control, token, now)).toBeNull();
});
