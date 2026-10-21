import { expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { parseInstanceControl } from '../../lib/instance/store';
import { authorizeInstanceSetup, issueSetupCandidateFlow, issueSetupOwnerProof, readInstanceSetupSession, verifyInstanceAuthority, verifySetupCandidateFlow, verifySetupOwnerProof, verifyInstancePreSessionMutation, instanceCsrfToken, verifyInstanceMutation, instanceErrorResponse, readInstanceJson, consumeInstanceRate, withInstanceProviderCheck } from '../../lib/instance/access';
import { instanceSnapshot } from '../../lib/instance/store';
import { issueBootstrapCredential } from '../../lib/instance/bootstrap';

it('requires an active binding and the independent instance role in the current identity/epochs', () => {
  const fixture = readyInstance(); const control = parseInstanceControl(fixture, fixture.instanceId);
  const identity = { issuer: fixture.active!.zitadel.issuer, subject: 'synthetic-owner', projectId: 'project' };
  const epochs = { securityEpoch: 1, recoveryEpoch: 1 };
  expect(verifyInstanceAuthority(control, identity, ['librarian-instance-admin'], epochs).kind).toBe('owner');
  for (const roles of [[], ['librarian-admin'], ['docs:private:reader']]) expect(() => verifyInstanceAuthority(control, identity, roles, epochs)).toThrow('instance_forbidden');
  for (const patch of [{ subject: 'other' }, { issuer: 'https://other.test' }, { projectId: 'other' }]) expect(() => verifyInstanceAuthority(control, { ...identity, ...patch }, ['librarian-instance-admin'], epochs)).toThrow('instance_forbidden');
  expect(() => verifyInstanceAuthority(control, identity, ['librarian-instance-admin'], { ...epochs, securityEpoch: 2 })).toThrow('instance_forbidden');
  expect(() => verifyInstanceAuthority(control, identity, ['librarian-instance-admin'], { ...epochs, recoveryEpoch: 2 })).toThrow('instance_forbidden');
});

it('rejects malformed signed candidate authority and validates default-clock owner and flow proofs', () => {
  const control = instanceControl(); control.candidate = readyInstance(control.instanceId, control.createdAt).active; control.nextBundleVersion = 2;
  const token = Buffer.alloc(32, 9).toString('base64url'); const secret = 'synthetic-flow-authority'.repeat(2);
  const signed = issueSetupCandidateFlow(secret, control, token);
  expect(verifySetupCandidateFlow(secret, signed, control, token)?.instanceId).toBe(control.instanceId);
  const signPayload = (text: string) => { const payload = Buffer.from(text).toString('base64url');
    return `${payload}.${createHmac('sha256', secret).update(`librarian-instance-candidate-flow\0${payload}`).digest('base64url')}`; };
  for (const value of ['', '.signature', 'payload.', `${signed}.extra`, 'x'.repeat(1025), signPayload('not JSON'), signPayload('{}')]) {
    expect(verifySetupCandidateFlow(secret, value, control, token)).toBeNull();
  }
  expect(verifySetupCandidateFlow('short', signed, control, token)).toBeNull();
  expect(verifySetupCandidateFlow(secret, signed, control, token, new Date(NaN))).toBeNull();
  const identity = { issuer: control.candidate!.zitadel.issuer, projectId: control.candidate!.zitadel.projectId, subject: 'synthetic-owner' };
  control.candidate!.ownerProof = issueSetupOwnerProof(control, identity); control.lifecycle = 'awaiting_owner';
  expect(verifySetupOwnerProof(control, identity)).toBe(true);
  expect(verifySetupOwnerProof(control, { ...identity, subject: 'other' })).toBe(false);
});

it('requires a canonical pre-session CSRF pair and denies a rejected durable rate update', async () => {
  const token = Buffer.alloc(32, 8).toString('base64url'); const origin = 'https://portal.test';
  const request = (headers: Record<string, string>) => new Request(origin, { method: 'POST', headers: { origin, ...headers } });
  expect(() => verifyInstancePreSessionMutation(request({ cookie: `__Host-librarian_pre_csrf=${token}`, 'x-csrf-token': token }), origin)).not.toThrow();
  for (const headers of [{}, { cookie: `__Host-librarian_pre_csrf=${token}` }, { 'x-csrf-token': token },
    { cookie: `__Host-librarian_pre_csrf=${token}`, 'x-csrf-token': Buffer.alloc(32, 7).toString('base64url') }] as Record<string, string>[]) {
    expect(() => verifyInstancePreSessionMutation(request(headers), origin)).toThrow('instance_csrf');
  }
  expect(() => verifyInstanceMutation(request({}), origin, token)).toThrow('instance_csrf');
  const db = { collection: () => ({ createIndex: async () => undefined, updateOne: async () => ({ matchedCount: 0, upsertedCount: 0 }) }) } as unknown as Db;
  await expect(consumeInstanceRate(db, randomUUID(), randomUUID(), 'check')).rejects.toThrow('instance_rate_limited');
});

it('releases a reserved setup slot when durable session creation fails and never returns partial authority', async () => {
  const now = new Date(); const control = instanceControl(undefined, now);
  const issued = issueBootstrapCredential(control.instanceId, 1, now);
  control.bootstrap.verifierHash = issued.verifierHash; control.bootstrap.expiresAt = issued.expiresAt;
  const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
  const insertOne = vi.fn().mockRejectedValue(new Error('SYNTHETIC_DATABASE_URI'));
  const createIndex = vi.fn().mockResolvedValue(undefined);
  const db = { collection: (name: string) => name === 'instance_configuration'
    ? { findOne: async () => structuredClone(control), updateOne }
    : { createIndex, insertOne } } as unknown as Db;
  await expect(authorizeInstanceSetup(db, control.instanceId, issued.credential, now)).rejects.toThrow('instance_unavailable');
  expect(updateOne).toHaveBeenCalledTimes(2);
  expect(updateOne.mock.calls[1][0]).toMatchObject({ 'bootstrap.sessionSlots.id': insertOne.mock.calls[0][0]._id });
  expect(updateOne.mock.calls[1][1]).toMatchObject({ $pull: { 'bootstrap.sessionSlots': { id: insertOne.mock.calls[0][0]._id } } });
  updateOne.mockReset().mockResolvedValueOnce({ matchedCount: 1 }).mockRejectedValueOnce(new Error('SYNTHETIC_DATABASE_URI'));
  await expect(authorizeInstanceSetup(db, control.instanceId, issued.credential, now)).rejects.toThrow('instance_unavailable');
  createIndex.mockRejectedValueOnce(new Error('SYNTHETIC_DATABASE_URI'));
  await expect(authorizeInstanceSetup(db, control.instanceId, issued.credential, now)).rejects.toThrow('instance_unavailable');
  await expect(authorizeInstanceSetup(db, control.instanceId, issued.credential, new Date(NaN))).rejects.toThrow('instance_invalid');
});

it('denies setup session reservation races and missing or damaged stored sessions', async () => {
  const now = new Date(); const control = instanceControl(undefined, now);
  const issued = issueBootstrapCredential(control.instanceId, 1, now);
  control.bootstrap.verifierHash = issued.verifierHash; control.bootstrap.expiresAt = issued.expiresAt;
  const updateOne = vi.fn().mockResolvedValue({ matchedCount: 0 });
  const sessions = { createIndex: async () => undefined, findOne: vi.fn().mockResolvedValue(null) };
  const db = { collection: (name: string) => name === 'instance_configuration'
    ? { findOne: async () => structuredClone(control), updateOne } : sessions } as unknown as Db;
  await expect(authorizeInstanceSetup(db, control.instanceId, issued.credential, now)).rejects.toThrow('instance_busy');
  await expect(readInstanceSetupSession(db, control.instanceId, issued.credential, undefined, now)).rejects.toThrow('instance_setup_unauthorized');
  sessions.findOne.mockResolvedValue({ _id: 'damaged' });
  await expect(readInstanceSetupSession(db, control.instanceId, issued.credential, undefined, now)).rejects.toThrow('instance_unavailable');
  await expect(readInstanceSetupSession(db, control.instanceId, issued.credential, undefined, new Date(NaN))).rejects.toThrow('instance_invalid');
  expect(updateOne).toHaveBeenCalledTimes(1);
});

it('never runs a provider check without its durable lease and releases the lease after an upstream failure', async () => {
  const updateOne = vi.fn().mockResolvedValue({ matchedCount: 0, upsertedCount: 0 });
  const deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 }); const operation = vi.fn(async () => 'checked');
  const db = { collection: () => ({ updateOne, deleteOne }) } as unknown as Db;
  await expect(withInstanceProviderCheck(db, randomUUID(), operation)).rejects.toThrow('instance_busy');
  expect(operation).not.toHaveBeenCalled(); expect(deleteOne).not.toHaveBeenCalled();
  updateOne.mockRejectedValueOnce(new Error('SYNTHETIC_DATABASE_URI'));
  await expect(withInstanceProviderCheck(db, randomUUID(), operation)).rejects.toThrow('instance_busy');
  updateOne.mockResolvedValue({ matchedCount: 1 }); operation.mockRejectedValueOnce(new Error('synthetic-provider-failure'));
  await expect(withInstanceProviderCheck(db, randomUUID(), operation)).rejects.toThrow('synthetic-provider-failure');
  expect(deleteOne).toHaveBeenCalledTimes(1);
});

it('cancels an oversized request stream even when cancellation fails and hides stream errors', async () => {
  const cancel = vi.fn(async () => { throw new Error('SYNTHETIC_PRIVATE_BODY'); });
  const oversized = new Request('https://portal.test', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel }), duplex: 'half' } as RequestInit);
  await expect(readInstanceJson(oversized)).rejects.toThrow('instance_request_too_large'); expect(cancel).toHaveBeenCalledTimes(1);
});

it('bounds JSON, rejects duplicate fields and returns only configured metadata for secrets', async () => {
  const request = (body: string) => new Request('https://portal.test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  await expect(readInstanceJson(request('{"confirm":true}'))).resolves.toEqual({ confirm: true });
  await expect(readInstanceJson(new Request('https://portal.test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2' }, body: '{}' }))).resolves.toEqual({});
  await expect(readInstanceJson(new Request('https://portal.test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' }, body: '{}' }))).rejects.toThrow('instance_request_too_large');
  for (const body of ['{"confirm":true,"confirm":false}', '{']) await expect(readInstanceJson(request(body))).rejects.toThrow('instance_invalid');
  await expect(readInstanceJson(request('x'.repeat(65537)))).rejects.toThrow('instance_request_too_large');
  await expect(readInstanceJson(new Request('https://portal.test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 'bad' }, body: '{}' }))).rejects.toThrow('instance_invalid');
  await expect(readInstanceJson(new Request('https://portal.test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new Uint8Array([0xff]) }))).rejects.toThrow('instance_invalid');
  await expect(readInstanceJson(new Request('https://portal.test', { method: 'POST', body: '{}' }))).rejects.toThrow('instance_invalid');
  await expect(readInstanceJson(new Request('https://portal.test', { headers: { 'Content-Type': 'application/json' } }))).rejects.toThrow('instance_invalid');
  const fixture = readyInstance();
  const snapshot = JSON.stringify(instanceSnapshot(parseInstanceControl(fixture, fixture.instanceId)));
  for (const forbidden of ['ciphertext', 'nonce', 'tag', 'keyId', 'verifierHash', 'synthetic-provider-secret']) expect(snapshot).not.toContain(`"${forbidden}"`);
});

it('verifies exact origin and session-bound CSRF without revealing untrusted errors', async () => {
  const secret = 'synthetic-session-key'; const session = randomUUID();
  const token = instanceCsrfToken(secret, session);
  const request = (origin: string, supplied: string) => new Request('https://portal.test/api/instance/settings', { method: 'PATCH', headers: { Origin: origin, 'X-CSRF-Token': supplied } });
  expect(() => verifyInstanceMutation(request('https://portal.test', token), 'https://portal.test', token)).not.toThrow();
  for (const [origin, supplied] of [['https://other.test', token], ['https://portal.test', 'bad'], ['https://portal.test', instanceCsrfToken(secret, randomUUID())]]) {
    expect(() => verifyInstanceMutation(request(origin, supplied), 'https://portal.test', token)).toThrow();
  }
  expect(() => verifyInstanceMutation(new Request('https://portal.test', { method: 'PATCH', headers: { 'X-CSRF-Token': token } }), 'https://portal.test', token)).toThrow('instance_origin');
  expect(() => verifyInstanceMutation(request('https://portal.test', ''), 'https://portal.test', token)).toThrow('instance_csrf');
  const response = instanceErrorResponse(new Error('SYNTHETIC_PRIVATE_BODY'));
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(JSON.stringify(await response.json())).not.toContain('SYNTHETIC_PRIVATE_BODY');
  const tooLarge = instanceErrorResponse(new Error('instance_request_too_large'));
  expect(tooLarge.status).toBe(413);
  expect(await tooLarge.json()).toMatchObject({ error: { code: 'request_too_large' } });
  const limited = instanceErrorResponse(new Error('instance_rate_limited'));
  expect(limited.headers.get('retry-after')).toBe('60');
  expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
  expect(instanceErrorResponse(null).status).toBe(503);
});

it('fails closed with an availability error when durable rate storage fails', async () => {
  const db = { collection: () => ({ createIndex: async () => undefined, updateOne: async () => { throw new Error('SYNTHETIC_DATABASE_URI'); } }) } as unknown as Db;
  await expect(consumeInstanceRate(db, randomUUID(), randomUUID(), 'mutation')).rejects.toThrow('instance_unavailable');
  const duplicate = { collection: () => ({ createIndex: async () => undefined, updateOne: async () => { throw Object.assign(new Error('duplicate key'), { code: 11000 }); } }) } as unknown as Db;
  await expect(consumeInstanceRate(duplicate, randomUUID(), randomUUID(), 'check')).rejects.toThrow('instance_rate_limited');
  const badIndex = { collection: () => ({ createIndex: async () => { throw new Error('SYNTHETIC_DATABASE_URI'); } }) } as unknown as Db;
  await expect(consumeInstanceRate(badIndex, randomUUID(), randomUUID(), 'mutation')).rejects.toThrow('instance_unavailable');
  await expect(consumeInstanceRate(db, randomUUID(), 'untrusted-actor', 'mutation')).rejects.toThrow('instance_invalid');
});
