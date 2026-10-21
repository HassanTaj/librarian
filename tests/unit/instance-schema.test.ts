import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { InstanceBundleSchema, InstanceControlSchema, InstanceEnvelopeSchema, instanceSnapshot, parseInstanceControl, type InstanceControl } from '../../lib/instance/store';

it('accepts an exact instance singleton and rejects cross-instance, unknown fields and unsupported schema', () => {
  const input = instanceControl();
  const result = InstanceControlSchema.safeParse(input);
  expect(result.success, result.success ? '' : JSON.stringify(result.error.issues.map(issue => ({ path: issue.path, message: issue.message })))).toBe(true);
  expect(parseInstanceControl(input, input.instanceId)).toEqual(input);
  expect(() => parseInstanceControl(input, randomUUID())).toThrow('instance_invalid');
  for (const patch of [{ _id: 'other' }, { schemaVersion: 2 }, { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { lifecycle: 'fresh' }, { secret: 'untrusted' }, { active: {} }, { initializedAt: input.createdAt }]) {
    expect(() => parseInstanceControl({ ...input, ...patch }, input.instanceId)).toThrow('instance_invalid');
  }
});

it('persists an incomplete setup candidate while keeping active bundles complete', () => {
  const control = instanceControl();
  const candidate = {
    version: 1, createdAt: control.createdAt, createdBy: 'bootstrap',
    preferences: { displayName: 'Librarian', description: '', docsFolder: 'docs' },
    publicOrigin: 'https://setup.example.test',
    zitadel: { issuer: '', clientId: '', projectId: '', audience: '' },
    github: { provider: 'github', appId: '' },
    secrets: { zitadelClientSecret: null, githubPrivateKey: null, githubWebhookSecret: null, previousWebhook: null },
    checks: [], ownerProof: null, impact: { categories: [], securityEpochIncrement: false, revalidateSources: false, confirmationNonce: randomUUID() }, previousUntil: null,
  };
  const saved = parseInstanceControl({ ...control, candidate, nextBundleVersion: 2, updatedAt: new Date(control.updatedAt.getTime() + 1) }, control.instanceId);
  expect(saved.candidate?.zitadel).toEqual(candidate.zitadel);
  expect(saved.candidate?.secrets.githubPrivateKey).toBeNull();
  expect(instanceSnapshot(saved).candidate?.secrets.githubPrivateKey).toEqual({ configured: false, updatedAt: null });
  expect(() => parseInstanceControl({ ...control, active: candidate }, control.instanceId)).toThrow('instance_invalid');
  expect(parseInstanceControl({ ...control, candidate: { ...candidate, publicOrigin: 'http://127.0.0.1:3200' }, nextBundleVersion: 2,
    updatedAt: new Date(control.updatedAt.getTime() + 1) }, control.instanceId).candidate?.publicOrigin).toBe('http://127.0.0.1:3200');
});

it('validates complete ready bundles and rejects unsafe preferences, origins, authority and expired pins', () => {
  const input = readyInstance();
  expect(parseInstanceControl(input, input.instanceId).lifecycle).toBe('ready');
  for (const patch of [{ displayName: '' }, { displayName: 'x'.repeat(121) }, { description: '<script>' }, { docsFolder: '../escape' }, { docsFolder: '/docs' }, { docsFolder: 'a/'.repeat(33) }, { docsFolder: '\\escape' }]) {
    const changed = structuredClone(input); changed.active!.preferences = { ...changed.active!.preferences, ...patch };
    expect(() => parseInstanceControl(changed, input.instanceId)).toThrow('instance_invalid');
  }
  for (const publicOrigin of ['https://example.test/', 'https://user:pass@example.test', 'http://private.test', 'invalid']) {
    expect(() => parseInstanceControl({ ...input, active: { ...input.active, publicOrigin } }, input.instanceId)).toThrow('instance_invalid');
  }
  for (const patch of [{ administrators: [] }, { administrators: [...input.administrators, input.administrators[0]] }, { bootstrap: { ...input.bootstrap, consumedAt: null } }, { initializedAt: new Date(input.updatedAt.getTime() + 1) }]) {
    expect(() => parseInstanceControl({ ...input, ...patch }, input.instanceId)).toThrow('instance_invalid');
  }
  const pin = { id: randomUUID(), bundleVersion: 1, securityEpoch: 1, recoveryEpoch: 1, purpose: 'request', createdAt: input.createdAt, expiresAt: new Date(input.createdAt.getTime() + 30_000) };
  expect(parseInstanceControl({ ...input, admissions: [pin] }, input.instanceId).admissions).toHaveLength(1);
  for (const admissions of [[{ ...pin, expiresAt: pin.createdAt }], [{ ...pin, expiresAt: new Date(pin.createdAt.getTime() + 30_001) }], [pin, pin], Array.from({ length: 65 }, () => ({ ...pin, id: randomUUID() })), [1, 2].map(() => ({ ...pin, id: randomUUID(), purpose: 'worker' }))]) {
    expect(() => parseInstanceControl({ ...input, admissions }, input.instanceId)).toThrow('instance_invalid');
  }
});

it('rejects backwards and invalid dates and unbounded authority arrays', () => {
  const input = instanceControl();
  for (const patch of [{ updatedAt: new Date(input.createdAt.getTime() - 1) }, { createdAt: new Date(NaN) }, { auditOutbox: Array(129).fill({}) }, { admissions: Array(66).fill({}) }, { administrators: Array(21).fill({}) }]) {
    expect(() => parseInstanceControl({ ...input, ...patch }, input.instanceId)).toThrow('instance_invalid');
  }
  expect(() => parseInstanceControl({ ...input, lifecycle: 'ready' }, input.instanceId)).toThrow('instance_invalid');
});

it('validates every nested persisted entity and its independent boundary values', () => {
  const input = readyInstance();
  const parsed = InstanceControlSchema.parse(input);
  expect(InstanceBundleSchema.parse(parsed.active)).toEqual(parsed.active);
  expect(InstanceEnvelopeSchema.parse(parsed.active!.secrets.githubPrivateKey)).toEqual(parsed.active!.secrets.githubPrivateKey);

  const invalid: Array<(value: ReturnType<typeof readyInstance>) => void> = [
    value => { value.active!.secrets.githubPrivateKey.nonce = Buffer.alloc(11).toString('base64'); },
    value => { value.active!.secrets.githubWebhookSecret.tag = Buffer.alloc(15).toString('base64'); },
    value => { value.active!.secrets.zitadelClientSecret.ciphertext = 'not canonical base64!'; },
    value => { value.active!.github.appId = '0'; },
    value => { value.active!.github.provider = 'gitlab' as 'github'; },
    value => { value.active!.checks = [{ type: 'github_webhook', candidateVersion: 1, at: input.createdAt, status: 'passed', code: 'synthetic-secret-value' as 'database_ok' }]; },
    value => { value.active!.preferences.docsFolder = 'docs/../private'; },
    value => { value.active!.version = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.gate.state = 'fresh' as 'open'; },
    value => { value.activation = { id: randomUUID(), from: 0, to: 1, phase: 'adopting', actor: 'operator', deadline: new Date(input.updatedAt.getTime() - 1), fencedCatalogIds: [], result: null }; },
    value => { value.migration = { sourceDigest: 'z'.repeat(64), mode: 'import', at: input.createdAt, verificationSummary: [] }; },
    value => { value.administrators[0].status = 'unknown' as 'active'; },
  ];
  for (const [index, mutate] of invalid.entries()) {
    const changed = structuredClone(input);
    mutate(changed);
    expect(() => parseInstanceControl(changed, input.instanceId), `nested case ${index}`).toThrow('instance_invalid');
  }
});

it('binds nested proofs, checks, events and server timestamps to their owning candidate and instance', () => {
  const input = readyInstance();
  const futureBundle = structuredClone(input);
  futureBundle.updatedAt = new Date(input.updatedAt.getTime() + 10_000);
  futureBundle.candidate = structuredClone(input.active!);
  futureBundle.candidate!.createdAt = new Date(futureBundle.updatedAt.getTime() + 1);
  expect(() => parseInstanceControl(futureBundle, input.instanceId), 'candidate creation cannot follow control update').toThrow('instance_invalid');

  const mismatchedProof = structuredClone(input);
  mismatchedProof.updatedAt = new Date(input.updatedAt.getTime() + 10_000);
  mismatchedProof.nextBundleVersion = 3;
  mismatchedProof.candidate = structuredClone(input.active!);
  mismatchedProof.candidate!.version = 2;
  mismatchedProof.candidate!.checks = [{ type: 'database', candidateVersion: 2, at: input.createdAt, status: 'passed', code: 'database_ok' }];
  mismatchedProof.candidate!.ownerProof = { instanceId: randomUUID(), candidateVersion: 2, issuer: input.active!.zitadel.issuer, subject: 'synthetic-owner', projectId: 'project', securityEpoch: 1, nonce: randomUUID(), expiresAt: new Date(mismatchedProof.updatedAt.getTime() + 60_000) };
  expect(() => parseInstanceControl(mismatchedProof, input.instanceId), 'candidate proof and checks must match owner and version').toThrow('instance_invalid');

  const eventControl = instanceControl(input.instanceId, input.createdAt);
  eventControl.updatedAt = new Date(input.updatedAt.getTime() + 10_000);
  eventControl.auditOutbox = [{ _id: randomUUID(), instanceId: input.instanceId, at: new Date(input.updatedAt.getTime() + 11_000), actor: 'synthetic-operator', operation: 'candidate_saved', fromVersion: null, toVersion: 1, resultCode: 'accepted', requestId: randomUUID() }];
  expect(() => parseInstanceControl(eventControl, input.instanceId), 'outbox chronology').toThrow('instance_invalid');
  expect(() => parseInstanceControl(input, randomUUID())).toThrow('instance_invalid');
});

it('rejects owner proofs bound to another instance, candidate version, issuer or project, or expired at creation', () => {
  const base = readyInstance();
  base.updatedAt = new Date(base.updatedAt.getTime() + 10_000);
  base.nextBundleVersion = 3;
  const candidate = structuredClone(base.active!);
  candidate.version = 2;
  candidate.checks = [{ type: 'database', candidateVersion: 2, at: candidate.createdAt, status: 'passed', code: 'database_ok' }];
  const proof = { instanceId: base.instanceId, candidateVersion: 2, issuer: candidate.zitadel.issuer, subject: 'synthetic-owner', projectId: candidate.zitadel.projectId, securityEpoch: base.securityEpoch, nonce: randomUUID(), expiresAt: new Date(candidate.createdAt.getTime() + 1_000) };
  const invalidProofs = [
    { ...proof, instanceId: randomUUID() },
    { ...proof, candidateVersion: 1 },
    { ...proof, issuer: 'https://wrong.example' },
    { ...proof, projectId: 'wrong-project' },
    { ...proof, expiresAt: candidate.createdAt },
  ];
  for (const ownerProof of invalidProofs) {
    expect(() => parseInstanceControl({ ...base, candidate: { ...candidate, ownerProof } }, base.instanceId)).toThrow('instance_invalid');
  }
});

it('rejects every invalid lifecycle, bundle, gate, admission and migration boundary', () => {
  const base = readyInstance();
  const before = new Date(base.createdAt.getTime() - 1);
  const after = new Date(base.updatedAt.getTime() + 1);
  const invalid: Array<(value: InstanceControl) => void> = [
    value => { value.bootstrap.expiresAt = before; },
    value => { value.bootstrap.consumedAt = after; },
    value => { value.lifecycle = 'awaiting_owner'; value.candidate = null; },
    value => { value.administrators.push({ ...value.administrators[0], bindingId: randomUUID() }); },
    value => { value.administrators[0].kind = 'administrator'; },
    value => { value.administrators[0].boundAt = before; },
    value => { value.initializedAt = null; },
    value => { value.active = null; },
    value => { value.bootstrap.consumedAt = null; },
    value => { value.nextBundleVersion = value.active!.version; },
    value => { value.active!.createdAt = before; },
    value => { value.active!.checks = [{ type: 'database', candidateVersion: value.active!.version + 1, at: value.createdAt, status: 'passed', code: 'database_ok' }]; },
    value => { value.active!.checks = [{ type: 'database', candidateVersion: value.active!.version, at: after, status: 'passed', code: 'database_ok' }]; },
    value => { value.active!.impact = { categories: ['github', 'github'], securityEpochIncrement: false, revalidateSources: false, confirmationNonce: randomUUID() }; },
    value => { value.active!.ownerProof = { instanceId: randomUUID(), candidateVersion: value.active!.version, issuer: value.active!.zitadel.issuer, subject: 'synthetic-owner', projectId: value.active!.zitadel.projectId, securityEpoch: 1, nonce: randomUUID(), expiresAt: after }; },
    value => { value.previous = structuredClone(value.active); value.previous!.previousUntil = null; },
    value => { value.previous = structuredClone(value.active); value.previous!.previousUntil = new Date(value.previous!.createdAt.getTime() + 86_400_001); },
    value => { value.active!.previousUntil = after; },
    value => { value.gate.activationId = randomUUID(); },
    value => { value.gate.state = 'closing'; },
    value => { value.gate.state = 'closing'; value.gate.activationId = randomUUID(); value.gate.deadline = after; },
    value => { value.activation = { id: randomUUID(), from: 1, to: 1, phase: 'draining', actor: 'operator', deadline: before, fencedCatalogIds: [], result: null }; value.gate = { state: 'closing', activationId: value.activation.id, deadline: value.activation.deadline }; },
    value => { value.activation = { id: randomUUID(), from: 1, to: 1, phase: 'draining', actor: 'operator', deadline: new Date(value.updatedAt.getTime() + 120_001), fencedCatalogIds: [], result: null }; value.gate = { state: 'closing', activationId: value.activation.id, deadline: value.activation.deadline }; },
    value => { value.activation = { id: randomUUID(), from: 1, to: 2, phase: 'draining', actor: 'operator', deadline: value.updatedAt, fencedCatalogIds: [], result: null }; value.gate = { state: 'closing', activationId: value.activation.id, deadline: value.activation.deadline }; },
    value => { value.admissions = Array.from({ length: 65 }, () => ({ id: randomUUID(), bundleVersion: 1, securityEpoch: 1, recoveryEpoch: 1, purpose: 'request' as const, createdAt: value.createdAt, expiresAt: new Date(value.createdAt.getTime() + 30_000) })); },
    value => { value.admissions = Array.from({ length: 2 }, () => ({ id: randomUUID(), bundleVersion: 1, securityEpoch: 1, recoveryEpoch: 1, purpose: 'worker' as const, createdAt: value.createdAt, expiresAt: new Date(value.createdAt.getTime() + 120_000) })); },
    value => { value.admissions = [{ id: randomUUID(), bundleVersion: 1, securityEpoch: 1, recoveryEpoch: 1, purpose: 'request', createdAt: after, expiresAt: new Date(after.getTime() + 30_000) }]; },
    value => { value.auditOutbox = [{ _id: randomUUID(), instanceId: randomUUID(), at: value.createdAt, actor: 'operator', operation: 'candidate_saved', fromVersion: null, toVersion: null, resultCode: 'accepted', requestId: randomUUID() }]; },
    value => { value.migration = { sourceDigest: 'a'.repeat(64), mode: 'import', at: after, verificationSummary: [] }; },
  ];
  for (const [index, mutate] of invalid.entries()) {
    const value = structuredClone(base);
    mutate(value);
    expect(() => parseInstanceControl(value, value.instanceId), `invalid state boundary ${index}`).toThrow('instance_invalid');
  }
});
