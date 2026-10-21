import { expect, it } from 'vitest';
import { createStorageHarness, insertInstanceControl } from './http-harness';
import { readyInstance } from '../fixtures/instance';
import { acquireInstanceAdmission, verifyInstanceAdmission, releaseInstanceAdmission, requireInstanceAuthority, consumeInstanceRate, withInstanceAdmission, runInstanceEffect } from '../../lib/instance/access';
import { parseInstanceControl, type InstanceControl } from '../../lib/instance/store';
import { ensureAuthIndexes } from '../../lib/auth/adapter';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

it('bounds admissions, excludes new work during cutover and denies expired or old-epoch pins', async () => {
  const storage = await createStorageHarness();
  try {
    const fixture = readyInstance(); const control = parseInstanceControl(fixture, fixture.instanceId);
    await insertInstanceControl(storage.db, control);
    const now = fixture.createdAt;
    await expect(acquireInstanceAdmission(storage.db, fixture.instanceId, 'invalid' as 'worker', now)).rejects.toThrow('instance_invalid');
    await expect(acquireInstanceAdmission(storage.db, fixture.instanceId, 'worker', new Date(NaN))).rejects.toThrow('instance_invalid');
    await expect(acquireInstanceAdmission(storage.db, fixture.instanceId, 'worker', new Date(fixture.createdAt.getTime() - 1))).rejects.toThrow('instance_invalid');
    const pin = await acquireInstanceAdmission(storage.db, fixture.instanceId, 'worker', now);
    await expect(acquireInstanceAdmission(storage.db, fixture.instanceId, 'worker', now)).rejects.toThrow('instance_busy');
    await expect(verifyInstanceAdmission(storage.db, fixture.instanceId, pin)).resolves.toBeUndefined();
    await expect(verifyInstanceAdmission(storage.db, fixture.instanceId, pin, new Date(now.getTime() + 119_999))).resolves.toBeUndefined();
    await expect(verifyInstanceAdmission(storage.db, fixture.instanceId, { ...pin, purpose: 'request' }, new Date(now.getTime() + 1))).rejects.toThrow('instance_admission_expired');
    await expect(verifyInstanceAdmission(storage.db, fixture.instanceId, { ...pin, expiresAt: new Date(now.getTime() + 300_000) }, new Date(now.getTime() + 1))).rejects.toThrow('instance_admission_expired');
    await expect(verifyInstanceAdmission(storage.db, fixture.instanceId, pin, new Date(now.getTime() + 120_000))).rejects.toThrow('instance_admission_expired');
    await releaseInstanceAdmission(storage.db, fixture.instanceId, pin.id);
    const requests = await Promise.all(Array.from({ length: 64 }, () => acquireInstanceAdmission(storage.db, fixture.instanceId, 'request', now)));
    await expect(acquireInstanceAdmission(storage.db, fixture.instanceId, 'request', now)).rejects.toThrow('instance_busy');
    const activationId = randomUUID(); const deadline = new Date(now.getTime() + 120_000);
    await storage.db.collection<typeof control>('instance_configuration').updateOne({ _id: 'instance' }, { $set: {
      gate: { state: 'closing', activationId, deadline },
      activation: { id: activationId, from: 1, to: 1, phase: 'draining', actor: 'synthetic-owner', deadline, fencedCatalogIds: [], result: null },
    } });
    await expect(acquireInstanceAdmission(storage.db, fixture.instanceId, 'request', now)).rejects.toThrow('instance_busy');
    await expect(verifyInstanceAdmission(storage.db, fixture.instanceId, requests[0], now)).resolves.toBeUndefined();
    await storage.db.collection<typeof control>('instance_configuration').updateOne({ _id: 'instance' }, { $inc: { securityEpoch: 1 } });
    await expect(verifyInstanceAdmission(storage.db, fixture.instanceId, requests[0], now)).rejects.toThrow('instance_admission_expired');
    await storage.db.collection<typeof control>('instance_configuration').updateOne({ _id: 'instance' }, { $set: { securityEpoch: 1, recoveryEpoch: 2 } });
    await expect(verifyInstanceAdmission(storage.db, fixture.instanceId, requests[0], now)).rejects.toThrow('instance_admission_expired');
  } finally { await storage.close(); }
});

it('reuses one nested admission and refuses effects after the admitted lifecycle changes', async () => {
  const storage = await createStorageHarness();
  try {
    const fixture = readyInstance(); const control = parseInstanceControl(fixture, fixture.instanceId);
    await insertInstanceControl(storage.db, control);
    await expect(withInstanceAdmission(storage.db, fixture.instanceId, 'request', async outer => {
      await withInstanceAdmission(storage.db, fixture.instanceId, 'request', async nested => {
        expect(nested.id).toBe(outer.id);
        expect((await storage.db.collection<InstanceControl>('instance_configuration').findOne({ _id: 'instance' }))?.admissions).toHaveLength(1);
      });
      expect(await runInstanceEffect(() => `effect:${outer.id}`)).toBe(`effect:${outer.id}`);
      await expect(withInstanceAdmission(storage.db, fixture.instanceId, 'worker', async () => undefined)).rejects.toThrow('instance_busy');
      await expect(withInstanceAdmission(storage.db, randomUUID(), 'request', async () => undefined)).rejects.toThrow('instance_busy');
      await storage.db.collection<typeof control>('instance_configuration').updateOne({ _id: 'instance' }, { $set: { lifecycle: 'maintenance' } });
      let effectRan = false;
      await expect(runInstanceEffect(async () => { effectRan = true; })).rejects.toThrow('instance_admission_expired');
      expect(effectRan).toBe(false);
    })).rejects.toThrow('instance_admission_expired');
    expect((await storage.db.collection<InstanceControl>('instance_configuration').findOne({ _id: 'instance' }))?.admissions).toHaveLength(0);
    await expect(runInstanceEffect(() => 'outside')).rejects.toThrow('instance_admission_expired');
  } finally { await storage.close(); }
});

it('rejects instance authority when the singleton has not been initialized', async () => {
  const storage = await createStorageHarness();
  try {
    await expect(requireInstanceAuthority({ db: storage.db, instanceId: randomUUID(), identity: { issuer: 'https://identity.example.test', subject: 'synthetic-owner', projectId: 'project' },
      epochs: { securityEpoch: 1, recoveryEpoch: 1 }, accessToken: async () => 'synthetic-token' })).rejects.toThrow('instance_unavailable');
  } finally { await storage.close(); }
});

it('shares durable rate limits between concurrent actors without an in-process counter', async () => {
  const storage = await createStorageHarness();
  try {
    const id = randomUUID(); const actor = randomUUID(); const now = new Date();
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => consumeInstanceRate(storage.db, id, actor, 'check', now)));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(6);
    await expect(consumeInstanceRate(storage.db, id, actor, 'check', now)).rejects.toThrow('instance_rate_limited');
    await expect(consumeInstanceRate(storage.db, id, randomUUID(), 'check', now)).resolves.toBeUndefined();
    const buckets = await storage.db.collection('instance_rate_buckets').find({}).toArray();
    expect(buckets).toHaveLength(2);
    expect(buckets.every(bucket => bucket.expiresAt instanceof Date)).toBe(true);
    expect(await storage.db.collection('instance_rate_buckets').listIndexes().toArray()).toContainEqual(expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }));
    const webhookAttempts = await Promise.allSettled(Array.from({ length: 8 }, () => consumeInstanceRate(storage.db, id, actor, 'webhook', now)));
    expect(webhookAttempts.filter(result => result.status === 'fulfilled')).toHaveLength(6);
    expect(await storage.db.collection('instance_rate_buckets').countDocuments()).toBe(3);
    const setupChecks = await Promise.allSettled(Array.from({ length: 10 }, () => consumeInstanceRate(storage.db, id, actor, 'setup_check', now)));
    expect(setupChecks.filter(result => result.status === 'fulfilled')).toHaveLength(8);
    await expect(consumeInstanceRate(storage.db, id, actor, 'setup_check', now)).rejects.toThrow('instance_rate_limited');
    const bootstrap = randomUUID();
    await consumeInstanceRate(storage.db, bootstrap, 'first', 'bootstrap', now);
    await consumeInstanceRate(storage.db, bootstrap, 'second', 'bootstrap', now);
    expect((await storage.db.collection('instance_rate_buckets').find({}).toArray()).filter(bucket => bucket.hits === 2)).toHaveLength(2);
  } finally { await storage.close(); }
});

it('refreshes roles at the exact 15-minute deadline and fails closed when refresh fails', async () => {
  const storage = await createStorageHarness();
  try {
    const fixture = readyInstance(); const control = parseInstanceControl(fixture, fixture.instanceId);
    await insertInstanceControl(storage.db, control);
    await ensureAuthIndexes(storage.db);
    const identity = { issuer: fixture.active!.zitadel.issuer, subject: 'synthetic-owner', projectId: 'project' };
    const verifiedAt = fixture.createdAt;
    const record = { _id: createHash('sha256').update(`${identity.issuer}\0${identity.subject}\0${identity.projectId}`).digest('hex'), ...identity, verifiedAt, roles: ['librarian-instance-admin'], leaseFence: 0, lease: null };
    await storage.db.collection<typeof record>('identity_authorizations').insertOne(record);
    const unavailable = async () => { throw new Error('synthetic-provider-unavailable'); };
    const args = { db: storage.db, instanceId: fixture.instanceId, identity, epochs: { securityEpoch: 1, recoveryEpoch: 1 }, accessToken: unavailable };
    await expect(requireInstanceAuthority({ ...args, now: () => verifiedAt.getTime() + 899_999 })).resolves.toMatchObject({ kind: 'owner' });
    await expect(requireInstanceAuthority({ ...args, now: () => verifiedAt.getTime() + 900_000 })).rejects.toThrow('instance_unavailable');
  } finally { await storage.close(); }
});
