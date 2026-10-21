import { expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { issueBootstrapCredential, verifyBootstrapCredential } from '../../lib/instance/bootstrap';
import { InstanceSetupSessionSchema, instanceErrorResponse, issueSetupCandidateFlow, issueSetupOwnerProof, verifySetupCandidateFlow, verifySetupOwnerProof } from '../../lib/instance/access';
import { InstanceControlSchema } from '../../lib/instance/store';

it('issues a high-entropy URL-safe bootstrap credential with exactly 24 hours of authority', async () => {
  const now = new Date('2026-10-19T00:00:00.000Z');
  const instanceId = randomUUID();
  const issued = issueBootstrapCredential(instanceId, 3, now);
  expect(() => issueBootstrapCredential('invalid', 3, now)).toThrow('instance_invalid');
  expect(() => issueBootstrapCredential(instanceId, 0, now)).toThrow('instance_invalid');
  expect(() => issueBootstrapCredential(instanceId, 3, new Date(NaN))).toThrow('instance_invalid');
  const bytes = Buffer.from(issued.credential, 'base64url');
  expect(bytes.byteLength).toBeGreaterThanOrEqual(32);
  expect(bytes.toString('base64url')).toBe(issued.credential);
  expect(issued.credential).not.toMatch(/[/?#]/);
  expect(issued.credential).not.toMatch(/^https?:/i);
  expect(issueBootstrapCredential(instanceId, 3, now).credential).not.toBe(issued.credential);
  expect(issued.expiresAt.getTime() - now.getTime()).toBe(24 * 60 * 60_000);

  const control = instanceControl(instanceId, now);
  control.bootstrap.epoch = 3;
  control.bootstrap.verifierHash = issued.verifierHash;
  control.bootstrap.expiresAt = issued.expiresAt;
  expect(verifyBootstrapCredential(control, issued.credential, new Date(issued.expiresAt.getTime() - 1))).toBe(true);
  expect(verifyBootstrapCredential(control, issued.credential, issued.expiresAt)).toBe(false);
  expect(verifyBootstrapCredential(control, 'wrong-credential', now)).toBe(false);
  expect(verifyBootstrapCredential(control, 'not/base64url?', now)).toBe(false);
  expect(verifyBootstrapCredential(control, issued.credential, new Date(now.getTime() - 1))).toBe(false);
  expect(verifyBootstrapCredential(control, issued.credential, new Date(NaN))).toBe(false);
  expect(verifyBootstrapCredential({ ...control, lifecycle: 'maintenance' }, issued.credential, now)).toBe(false);
  control.bootstrap.consumedAt = new Date(now.getTime() + 1);
  expect(verifyBootstrapCredential(control, issued.credential, new Date(now.getTime() + 2))).toBe(false);
  expect(await instanceErrorResponse(new Error('instance_unavailable')).text()).not.toContain(issued.credential);
});

it('stores only hashes for bounded setup sessions and rejects expiry beyond the hard deadline', () => {
  const now = new Date('2026-10-19T00:00:00.000Z');
  const token = randomUUID() + randomUUID();
  const csrfToken = randomUUID() + randomUUID();
  const expiresAt = new Date(now.getTime() + 30 * 60_000);
  const session = {
    _id: createHash('sha256').update(token).digest('hex'), instanceId: randomUUID(), setupEpoch: 2, recoveryEpoch: 4,
    createdAt: now, expiresAt, purgeAt: new Date(expiresAt.getTime() + 60 * 60_000), csrfHash: createHash('sha256').update(csrfToken).digest('hex'),
    candidateVersion: 0, lastNonceHash: null, purpose: 'bootstrap' as const,
  };
  expect(InstanceSetupSessionSchema.parse(session)).toEqual(session);
  expect(JSON.stringify(session)).not.toContain(token);
  expect(JSON.stringify(session)).not.toContain(csrfToken);
  expect(InstanceSetupSessionSchema.safeParse({ ...session, expiresAt: new Date(expiresAt.getTime() + 1) }).success).toBe(false);
  expect(InstanceSetupSessionSchema.safeParse({ ...session, purgeAt: expiresAt }).success).toBe(false);
  expect(InstanceSetupSessionSchema.safeParse({ ...session, unexpected: 'credential' }).success).toBe(false);
});

it('keeps only eight live session reservations in the singleton bootstrap state', () => {
  const control = instanceControl();
  const expiresAt = new Date(control.createdAt.getTime() + 30 * 60_000);
  control.bootstrap.sessionSlots = Array.from({ length: 8 }, (_, index) => ({ id: String(index).padStart(64, '0'), expiresAt }));
  expect(InstanceControlSchema.safeParse(control).success).toBe(true);
  control.bootstrap.sessionSlots.push({ id: 'f'.repeat(64), expiresAt });
  expect(InstanceControlSchema.safeParse(control).success).toBe(false);
});

it('binds a ten-minute owner proof to the current setup candidate and identity', () => {
  const control = readyInstance();
  const now = control.createdAt;
  control.lifecycle = 'awaiting_owner';
  control.nextBundleVersion = 3;
  control.candidate = structuredClone(control.active!);
  control.candidate.version = 2;
  control.candidate.ownerProof = null;
  const identity = { issuer: control.candidate.zitadel.issuer, subject: 'synthetic-candidate-owner', projectId: control.candidate.zitadel.projectId };
  const proof = issueSetupOwnerProof(control, identity, now);
  control.candidate.ownerProof = proof;
  expect(proof.expiresAt.getTime() - now.getTime()).toBe(10 * 60_000);
  expect(proof.nonce).toMatch(/^[0-9a-f-]{36}$/i);
  expect(issueSetupOwnerProof(control, identity, now).nonce).not.toBe(proof.nonce);
  expect(proof).not.toHaveProperty('email');
  expect(verifySetupOwnerProof(control, identity, new Date(proof.expiresAt.getTime() - 1))).toBe(true);
  expect(verifySetupOwnerProof(control, identity, proof.expiresAt)).toBe(false);
  expect(verifySetupOwnerProof(control, { ...identity, subject: 'other' }, now)).toBe(false);
  expect(verifySetupOwnerProof({ ...control, securityEpoch: control.securityEpoch + 1 }, identity, now)).toBe(false);
  expect(verifySetupOwnerProof(control, { ...identity, issuer: 'https://substituted.example.test' }, now)).toBe(false);
  expect(verifySetupOwnerProof(control, { ...identity, projectId: 'substituted-project' }, now)).toBe(false);
  expect(verifySetupOwnerProof({ ...control, lifecycle: 'ready' }, identity, now)).toBe(false);
  control.candidate.version++;
  expect(verifySetupOwnerProof(control, identity, now)).toBe(false);
  expect(() => issueSetupOwnerProof(control, identity, new Date(now.getTime() - 1))).toThrow('instance_forbidden');
  expect(() => issueSetupOwnerProof({ ...control, candidate: null }, identity, now)).toThrow('instance_forbidden');
  expect(() => issueSetupOwnerProof(control, { ...identity, issuer: 'https://other.example.test' }, now)).toThrow('instance_forbidden');
  expect(() => issueSetupOwnerProof(control, { ...identity, projectId: 'other' }, now)).toThrow('instance_forbidden');
  expect(() => issueSetupOwnerProof(control, { ...identity, subject: '' }, now)).toThrow('instance_forbidden');
  expect(() => issueSetupOwnerProof(control, identity, new Date(NaN))).toThrow('instance_forbidden');
});

it('binds candidate login state to the setup session, candidate revision and current epochs', () => {
  const control = instanceControl();
  const now = control.createdAt;
  const candidate = readyInstance(control.instanceId, now).active;
  if (!candidate) throw new Error('Synthetic candidate unavailable');
  control.candidate = structuredClone(candidate);
  control.nextBundleVersion = candidate.version + 1;
  const setupToken = randomBytes(32).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const flowToken = issueSetupCandidateFlow(secret, control, setupToken, now);

  expect(verifySetupCandidateFlow(secret, flowToken, control, setupToken, now)).toMatchObject({ instanceId: control.instanceId,
    candidateVersion: candidate.version, setupSessionHash: createHash('sha256').update(setupToken).digest('hex'), expiresAt: new Date(now.getTime() + 10 * 60_000) });
  expect(verifySetupCandidateFlow(secret, flowToken, control, randomBytes(32).toString('base64url'), now)).toBeNull();
  expect(verifySetupCandidateFlow(`${secret}changed`, flowToken, control, setupToken, now)).toBeNull();
  expect(verifySetupCandidateFlow(secret, flowToken, { ...control, securityEpoch: control.securityEpoch + 1 }, setupToken, now)).toBeNull();
  const edited = structuredClone(control);
  edited.candidate!.version++;
  expect(verifySetupCandidateFlow(secret, flowToken, edited, setupToken, now)).toBeNull();
  expect(verifySetupCandidateFlow(secret, flowToken, control, setupToken, new Date(now.getTime() + 10 * 60_000))).toBeNull();
  expect(() => issueSetupCandidateFlow(secret, control, 'bad-token', now)).toThrow('instance_forbidden');
});
