import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { expect, it, vi } from 'vitest';
import { LIMITS } from '../../lib/limits';
import { buildInstanceDraft, cleanupInstanceState, drainInstanceAudit, initializeInstance, InstanceDraftPatchSchema, parseInstanceControl, readInstance, recordInstanceCheck, updateInstance, type InstanceControl } from '../../lib/instance/store';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { encryptedInstanceDb } from '../fixtures/encrypted-instance-db';

const keyring = { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } };

it('rejects ordinary control writes at a full audit outbox but permits reconciliation of an existing event', async () => {
  const stored = readyInstance();
  stored.auditOutbox = Array.from({ length: LIMITS.maxInstanceAuditOutbox }, () => ({
    _id: randomUUID(), instanceId: stored.instanceId, at: stored.createdAt, actor: 'synthetic-operator', operation: 'candidate_saved' as const,
    fromVersion: null, toVersion: null, resultCode: 'accepted', requestId: randomUUID(),
  }));
  let replaceCalls = 0;
  const { db } = encryptedInstanceDb(stored, keyring, { replace: async () => { replaceCalls++; return { matchedCount: 1 }; } });

  let mutationCalls = 0;
  await expect(updateInstance(db, stored.instanceId, stored.revision, value => {
    mutationCalls++;
    return { ...value, lifecycle: 'maintenance' };
  })).rejects.toThrow('instance_unavailable');
  expect(mutationCalls).toBe(0);
  expect(replaceCalls).toBe(0);

  const existingId = stored.auditOutbox[0]._id;
  const reconciled = await updateInstance(db, stored.instanceId, stored.revision, value => ({
    ...value,
    auditOutbox: value.auditOutbox.map(event => event._id === existingId ? { ...event, resultCode: 'accepted_after_recovery' } : event),
  }), new Date(stored.updatedAt.getTime() + 1), { allowFullAuditOutbox: true });
  expect(reconciled.auditOutbox[0].resultCode).toBe('accepted_after_recovery');
  expect(replaceCalls).toBe(1);

  const appended = { _id: randomUUID(), instanceId: stored.instanceId, at: new Date(stored.updatedAt.getTime() + 1), actor: 'synthetic-operator',
    operation: 'candidate_saved' as const, fromVersion: null, toVersion: null, resultCode: 'new', requestId: randomUUID() };
  await expect(updateInstance(db, stored.instanceId, stored.revision, value => ({ ...value, auditOutbox: [...value.auditOutbox, appended] }),
    appended.at, { allowFullAuditOutbox: true })).rejects.toThrow('instance_unavailable');
  expect(replaceCalls).toBe(1);
});

it('rejects malformed identities and duplicate or expired bootstrap reservations before writing state', async () => {
  const write = vi.fn(); const db = { collection: () => ({ insertOne: write }) } as unknown as Db;
  await expect(initializeInstance(db, { instanceId: 'invalid' })).rejects.toThrow('instance_invalid');
  await expect(readInstance(db, 'invalid')).rejects.toThrow('instance_invalid');
  const control = instanceControl(); const slot = { id: 'a'.repeat(64), expiresAt: new Date(control.createdAt.getTime() + 60_000) };
  for (const slots of [[slot, slot], [{ ...slot, expiresAt: control.createdAt }], [{ ...slot, expiresAt: new Date(control.bootstrap.expiresAt.getTime() + 1) }]]) {
    expect(() => parseInstanceControl({ ...control, bootstrap: { ...control.bootstrap, sessionSlots: slots } }, control.instanceId)).toThrow('instance_invalid');
  }
  expect(write).not.toHaveBeenCalled();
});

it('keeps provider checks out of closed or saturated state and never acknowledges an undrained audit outbox', async () => {
  const control = readyInstance(); control.candidate = structuredClone(control.active); control.candidate!.version = control.nextBundleVersion++;
  const event = { _id: randomUUID(), instanceId: control.instanceId, at: control.createdAt, actor: 'synthetic-operator', operation: 'candidate_saved' as const,
    fromVersion: 1, toVersion: 2, resultCode: 'accepted', requestId: randomUUID() };
  const check = { type: 'database' as const, candidateVersion: 2, at: control.createdAt, status: 'passed' as const, code: 'database_ok' as const };
  const replaceOne = vi.fn(); const ack = vi.fn().mockResolvedValue({ matchedCount: 0 });
  const claim = vi.fn().mockResolvedValue({ matchedCount: 0, upsertedCount: 0 }); const release = vi.fn();
  const insert = vi.fn();
  const events = { createIndex: async () => undefined, countDocuments: async () => 0,
    find: () => ({ project: () => ({ toArray: async () => [] }) }), updateOne: insert };
  control.auditOutbox = Array.from({ length: LIMITS.maxInstanceAuditOutbox }, () => ({ ...event, _id: randomUUID() }));
  const { db, setControl } = encryptedInstanceDb(control, keyring, { configuration: { updateOne: ack }, replace: async () => { replaceOne(); return { matchedCount: 1 }; }, collections: {
    instance_audit_drain_leases: { updateOne: claim, deleteOne: release }, instance_audit_events: events,
  } });
  await expect(recordInstanceCheck(db, control.instanceId, check)).rejects.toThrow('instance_unavailable');
  control.auditOutbox = [event]; control.lifecycle = 'maintenance'; control.gate.state = 'maintenance';
  await setControl(control);
  await expect(recordInstanceCheck(db, control.instanceId, check)).rejects.toThrow('instance_conflict'); expect(replaceOne).not.toHaveBeenCalled();
  await expect(drainInstanceAudit(db, control.instanceId)).rejects.toThrow('instance_busy'); expect(insert).not.toHaveBeenCalled();
  claim.mockResolvedValue({ matchedCount: 1 });
  await expect(drainInstanceAudit(db, control.instanceId)).rejects.toThrow('instance_busy');
  expect(insert).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce(); expect(control.auditOutbox).toEqual([event]);
  const absent = { collection: () => ({ findOne: async () => null }) } as unknown as Db;
  await expect(drainInstanceAudit(absent, control.instanceId)).rejects.toThrow('instance_unavailable');
  await cleanupInstanceState(absent, control.instanceId);
});

it('allows loopback development origins, rejects unsafe origins, and requires operator origin consistency during initial setup', async () => {
  const control = readyInstance(); const ring = { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } };
  const nodeEnv = process.env.NODE_ENV;
  try {
    vi.stubEnv('NODE_ENV', 'test');
    for (const publicOrigin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      const input = InstanceDraftPatchSchema.parse({ candidateVersion: 0, changes: { publicOrigin, github: { appId: '456' } } });
      const draft = await buildInstanceDraft(control, control.active!.publicOrigin, input, ring, control.administrators[0].bindingId);
      expect(draft.impact?.categories).toEqual(expect.arrayContaining(['origin', 'github'])); expect(draft.impact?.revalidateSources).toBe(true);
    }
    for (const publicOrigin of ['invalid', 'http://remote.example.test', 'https://portal.example.test/path']) {
      expect(InstanceDraftPatchSchema.safeParse({ candidateVersion: 0, changes: { publicOrigin } }).success).toBe(false);
    }
    vi.stubEnv('NODE_ENV', 'production');
    expect(InstanceDraftPatchSchema.safeParse({ candidateVersion: 0, changes: { publicOrigin: 'http://localhost:3000' } }).success).toBe(false);
    const fresh = instanceControl();
    await expect(buildInstanceDraft(fresh, 'https://setup.example.test', { candidateVersion: 0, changes: { publicOrigin: 'https://other.example.test' } }, ring, 'bootstrap'))
      .rejects.toThrow('instance_invalid');
  } finally { vi.stubEnv('NODE_ENV', nodeEnv); }
});

it('retires expired rollback and webhook material independently without changing the active generation or edit revision', async () => {
  const now = new Date();
  for (const [previousExpired, webhookExpired] of [[false, false], [true, false], [false, true], [true, true]]) {
    const stored = readyInstance(randomUUID(), new Date(now.getTime() - 1000));
    stored.previous = structuredClone(stored.active);
    stored.previous!.previousUntil = new Date(now.getTime() + (previousExpired ? -1 : 1000));
    stored.active!.secrets.previousWebhook = { envelope: structuredClone(stored.active!.secrets.githubWebhookSecret),
      acceptUntil: new Date(now.getTime() + (webhookExpired ? -1 : 1000)) };
    const original = structuredClone(stored);
    let writes = 0;
    const { db, setControl } = encryptedInstanceDb(stored, keyring, { replace: async filter => {
      expect(filter).toEqual({ _id: 'instance', instanceId: stored.instanceId, revision: original.revision });
      writes++; return { matchedCount: 1 };
    } });
    await cleanupInstanceState(db, stored.instanceId, now);
    expect(writes).toBe(previousExpired || webhookExpired ? 1 : 0);
    expect(stored.previous === null).toBe(previousExpired);
    expect(stored.active!.secrets.previousWebhook === null).toBe(webhookExpired);
    expect(stored.active!.version).toBe(original.active!.version);
    expect(stored.active!.secrets.githubWebhookSecret).toEqual(original.active!.secrets.githubWebhookSecret);
    expect(stored.editRevision).toBe(original.editRevision);
    stored.lifecycle = 'maintenance'; stored.gate.state = 'maintenance';
    await setControl(stored);
    await cleanupInstanceState(db, stored.instanceId, new Date(now.getTime() + 2000));
    expect(writes).toBe(previousExpired || webhookExpired ? 1 : 0);
  }
});

it('preserves the latest provider proof and fails after bounded concurrent write conflicts', async () => {
  const now = new Date();
  const stored = readyInstance(randomUUID(), new Date(now.getTime() - 1000));
  stored.candidate = structuredClone(stored.active); stored.candidate!.version = stored.nextBundleVersion++;
  stored.updatedAt = now;
  const result = { type: 'database' as const, candidateVersion: stored.candidate!.version, at: new Date(now.getTime() - 100),
    status: 'passed' as const, code: 'database_ok' as const };
  stored.candidate!.checks = [{ ...result, at: now }];
  let writes = 0;
  const { db, setControl } = encryptedInstanceDb(stored, keyring, { replace: async () => { writes++; return { matchedCount: 0 }; } });
  expect(await recordInstanceCheck(db, stored.instanceId, result)).toEqual(stored);
  expect(writes).toBe(0);
  stored.candidate!.checks = [];
  await setControl(stored);
  await expect(recordInstanceCheck(db, stored.instanceId, result)).rejects.toThrow('instance_conflict');
  expect(writes).toBe(3);
  await expect(recordInstanceCheck(db, stored.instanceId, { ...result, at: new Date(Date.now() + 60_000) })).rejects.toThrow('instance_invalid');
});

it('rejects regressions of initialized authority, epochs and monotonic bundle versions atomically', async () => {
  const stored = readyInstance();
  stored.securityEpoch = 2; stored.recoveryEpoch = 2; stored.bootstrap.epoch = 2;
  const mutations: Array<(value: InstanceControl) => InstanceControl> = [
    value => ({ ...value, securityEpoch: 1 }), value => ({ ...value, recoveryEpoch: 1 }),
    value => ({ ...value, bootstrap: { ...value.bootstrap, epoch: 1 } }),
    value => ({ ...value, nextBundleVersion: value.nextBundleVersion - 1, active: { ...value.active!, version: 0 } }),
    value => ({ ...value, bootstrap: { ...value.bootstrap, consumedAt: new Date(value.bootstrap.consumedAt!.getTime() + 1) } }),
  ];
  let writes = 0;
  const { db } = encryptedInstanceDb(stored, keyring, { replace: async () => { writes++; return { matchedCount: 1 }; } });
  for (const mutate of mutations) await expect(updateInstance(db, stored.instanceId, stored.revision, mutate,
    new Date(stored.updatedAt.getTime() + 10))).rejects.toThrow('instance_invalid');
  expect(writes).toBe(0);
});
