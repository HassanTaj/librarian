import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { createStorageHarness, insertInstanceControl } from './http-harness';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { initializeInstance, readInstance, updateInstance, drainInstanceAudit, type StoredInstanceControl } from '../../lib/instance/store';
import { createInstanceHarness } from './instance-harness';
import { readInstanceHost } from '../../lib/instance/bootstrap';
import { writeFile, readFile } from 'node:fs/promises';

it('stores the active logical configuration only as authenticated ciphertext', async () => {
  const storage = await createStorageHarness();
  try {
    const control = readyInstance();
    await insertInstanceControl(storage.db, control);
    const stored = await storage.db.collection<StoredInstanceControl>('instance_configuration').findOne({ _id: 'instance' });
    expect(stored?.active?.configuration).toMatchObject({ formatVersion: 2, algorithm: 'aes-256-gcm', bundleVersion: control.active!.version });
    const rawConfiguration = JSON.stringify(stored?.active);
    for (const value of ['https://portal.example.test', 'https://identity.example.test', 'Synthetic', '"synthetic"']) expect(rawConfiguration).not.toContain(value);
    await expect(readInstance(storage.db, control.instanceId)).resolves.toEqual(control);

    const ciphertext = Buffer.from(stored!.active!.configuration.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    await storage.db.collection<StoredInstanceControl>('instance_configuration').updateOne({ _id: 'instance' }, {
      $set: { 'active.configuration.ciphertext': ciphertext.toString('base64') },
    });
    await expect(readInstance(storage.db, control.instanceId)).rejects.toThrow('instance_unavailable');
  } finally { await storage.close(); }
});

function faultDb(db: Db, failure: 'audit-ack' | 'audit-index') {
  let armed = true;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const wrapped = {
    client: db.client,
    collection(name: string) {
      const collection = db.collection(name);
      const intercept = failure === 'audit-ack' ? name === 'instance_configuration' : name === 'instance_audit_events';
      if (!intercept) return collection;
      return new Proxy(collection, {
        get(target, property) {
          if (failure === 'audit-ack' && property === 'updateOne') return (...args: Parameters<typeof collection.updateOne>) => {
            const update = args[1];
            const pull = update && !Array.isArray(update) && '$pull' in update ? update.$pull : undefined;
            if (armed && pull && typeof pull === 'object' && 'auditOutbox' in pull) {
              armed = false;
              throw new Error('simulated process interruption before audit acknowledgement');
            }
            return collection.updateOne(...args);
          };
          if (failure === 'audit-index' && property === 'createIndex') return async (...args: Parameters<typeof collection.createIndex>) => {
            if (armed) { armed = false; entered(); await blocked; }
            return collection.createIndex(...args);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Db;
  return { db: wrapped, reached, release };
}

it('serializes singleton creation and CAS edits on real standalone Mongo and denies cross-instance access', async () => {
  const storage = await createStorageHarness();
  try {
    const control = instanceControl();
    const created = await Promise.allSettled([initializeInstance(storage.db, control), initializeInstance(storage.db, control)]);
    expect(created.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await readInstance(storage.db, control.instanceId)).toMatchObject({ revision: 0, editRevision: 0 });
    await expect(readInstance(storage.db, randomUUID())).rejects.toThrow('instance_mismatch');
    const now = new Date(control.updatedAt.getTime() + 1);
    const results = await Promise.allSettled([1, 2].map(() => updateInstance(storage.db, control.instanceId, 0, value => ({ ...value, lifecycle: 'maintenance' }), now)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await readInstance(storage.db, control.instanceId)).toMatchObject({ revision: 1, editRevision: 1, lifecycle: 'maintenance' });
    await expect(updateInstance(storage.db, control.instanceId, 0, value => value, now)).rejects.toThrow('instance_conflict');
    expect(await storage.db.collection('instance_configuration').countDocuments()).toBe(1);
  } finally { await storage.close(); }
});

it('refuses to create an initialized installation through the fresh-instance path', async () => {
  const storage = await createStorageHarness();
  try {
    const control = readyInstance();
    await expect(initializeInstance(storage.db, control)).rejects.toThrow('instance_invalid');
    await expect(readInstance(storage.db, control.instanceId)).resolves.toBeNull();
  } finally { await storage.close(); }
});

it('commits the first active bundle, owner, bootstrap consumption and audit in one CAS write', async () => {
  const storage = await createStorageHarness();
  try {
    const initial = instanceControl();
    await initializeInstance(storage.db, initial);
    const ready = readyInstance(initial.instanceId, initial.createdAt);
    const committedAt = new Date(initial.createdAt.getTime() + 1);
    const event = { _id: randomUUID(), instanceId: initial.instanceId, at: committedAt, actor: 'synthetic-owner', operation: 'setup_finalized' as const, fromVersion: null, toVersion: 1, resultCode: 'accepted', requestId: randomUUID() };
    await updateInstance(storage.db, initial.instanceId, 0, current => ({ ...current, lifecycle: ready.lifecycle, initializedAt: ready.initializedAt,
      bootstrap: ready.bootstrap, active: ready.active, nextBundleVersion: ready.nextBundleVersion, administrators: ready.administrators, auditOutbox: [event] }), committedAt);
    await expect(readInstance(storage.db, initial.instanceId)).resolves.toMatchObject({ revision: 1, lifecycle: 'ready', initializedAt: initial.createdAt,
      bootstrap: { consumedAt: initial.createdAt }, active: { version: 1 }, administrators: [{ kind: 'owner', subject: 'synthetic-owner' }], auditOutbox: [event] });
  } finally { await storage.close(); }
});

it('loads independent protected host trust without optional providers and rejects missing, reused or mismatched roots', async () => {
  const fixture = await createInstanceHarness({ port: 3193 });
  try {
    const host = await readInstanceHost(fixture.env);
    expect(host.instanceId).toBe(fixture.instanceId);
    expect(host.marker.phase).toBe('prepared');
    expect(host.config.mongodbDatabase).toBe(fixture.storage.db.databaseName);
    expect(host.operator.purpose).toBe('bootstrap');
    await expect(readInstanceHost({ ...fixture.env, INSTANCE_ID: randomUUID() })).rejects.toThrow('instance_host_unavailable');
    await expect(readInstanceHost({ ...fixture.env, INSTANCE_KEYRING_FILE: '' })).rejects.toThrow('instance_host_unavailable');
    const oauth = await readFile(fixture.env.OAUTH_TOKEN_ENCRYPTION_KEY_FILE, 'utf8');
    await writeFile(fixture.env.INSTANCE_KEYRING_FILE, JSON.stringify({ activeKeyId: 'root', keys: { root: oauth } }));
    await expect(readInstanceHost(fixture.env)).rejects.toThrow('instance_host_unavailable');
    const authSecret = 'A'.repeat(32);
    await writeFile(fixture.env.AUTH_SECRET_FILE, authSecret);
    await writeFile(fixture.env.INSTANCE_KEYRING_FILE, JSON.stringify({ activeKeyId: 'root', keys: { root: Buffer.from(authSecret).toString('base64') } }));
    await expect(readInstanceHost(fixture.env)).rejects.toThrow('instance_host_unavailable');
  } finally { await fixture.close(); }
});

it('validates trusted setup origins, optional outbound policy and marker/operator epochs', async () => {
  const fixture = await createInstanceHarness({ port: 3194 });
  try {
    await expect(readInstanceHost({ ...fixture.env, INSTANCE_SETUP_ORIGIN: 'http://remote.example.test' })).rejects.toThrow('instance_host_unavailable');
    await expect(readInstanceHost({ ...fixture.env, NODE_ENV: 'production' })).rejects.toThrow('instance_host_unavailable');
    await expect(readInstanceHost({ ...fixture.env, INSTANCE_OUTBOUND_POLICY_FILE: '' })).resolves.toMatchObject({ policy: { origins: [] } });
    await writeFile(fixture.env.INSTANCE_OUTBOUND_POLICY_FILE!, JSON.stringify({ origins: [{ origin: 'http://remote.example.test', addresses: ['127.0.0.1'] }] }));
    await expect(readInstanceHost(fixture.env)).rejects.toThrow('instance_host_unavailable');
    await writeFile(fixture.env.INSTANCE_OUTBOUND_POLICY_FILE!, JSON.stringify({ origins: [{ origin: 'http://127.0.0.1:3194', addresses: ['not-an-ip'] }] }));
    await expect(readInstanceHost(fixture.env)).rejects.toThrow('instance_host_unavailable');
    await writeFile(fixture.env.INSTANCE_OUTBOUND_POLICY_FILE!, JSON.stringify({ origins: [{ origin: 'http://127.0.0.1:3194', addresses: ['127.0.0.1'] }] }));
    const marker = JSON.parse(await readFile(fixture.env.INSTANCE_STATE_FILE, 'utf8')) as { instanceId: string; phase: string; recoveryEpoch: number };
    await writeFile(fixture.env.INSTANCE_STATE_FILE, JSON.stringify({ ...marker, recoveryEpoch: marker.recoveryEpoch + 1 }));
    await expect(readInstanceHost(fixture.env)).rejects.toThrow('instance_host_unavailable');
    await writeFile(fixture.env.INSTANCE_STATE_FILE, JSON.stringify({ ...marker, phase: 'initialized' }));
    const operator = JSON.parse(await readFile(fixture.env.INSTANCE_OPERATOR_AUTH_FILE!, 'utf8')) as { expiresAt: string };
    await writeFile(fixture.env.INSTANCE_OPERATOR_AUTH_FILE!, JSON.stringify({ ...operator, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    await expect(readInstanceHost(fixture.env).then(host => host.marker.phase)).resolves.toBe('initialized');
  } finally { await fixture.close(); }
});

it('replays audit outbox writes idempotently after interrupted acknowledgement', async () => {
  const storage = await createStorageHarness();
  try {
    const control = instanceControl();
    await initializeInstance(storage.db, control);
    const event = { _id: randomUUID(), instanceId: control.instanceId, at: control.createdAt, actor: 'operator-synthetic', operation: 'candidate_saved', fromVersion: null, toVersion: null, resultCode: 'accepted', requestId: randomUUID() };
    await updateInstance(storage.db, control.instanceId, 0, value => ({ ...value, auditOutbox: [event] }));
    const interrupted = faultDb(storage.db, 'audit-ack');
    await expect(drainInstanceAudit(interrupted.db, control.instanceId)).rejects.toThrow('simulated process interruption');
    expect((await readInstance(storage.db, control.instanceId))?.auditOutbox).toHaveLength(1);
    expect(await storage.db.collection<typeof event>('instance_audit_events').countDocuments({ _id: event._id })).toBe(1);
    await drainInstanceAudit(storage.db, control.instanceId);
    expect(await storage.db.collection('instance_audit_events').countDocuments()).toBe(1);
    expect((await readInstance(storage.db, control.instanceId))?.auditOutbox).toEqual([]);
    const indexes = await storage.db.collection('instance_audit_events').listIndexes().toArray();
    expect(indexes).toContainEqual(expect.objectContaining({ key: { instanceId: 1, at: 1 } }));
    expect(indexes).toContainEqual(expect.objectContaining({ key: { at: 1 }, expireAfterSeconds: 90 * 24 * 60 * 60 }));
  } finally { await storage.close(); }
});

it('rejects backwards server timestamps and preserves the last committed revision', async () => {
  const storage = await createStorageHarness();
  try {
    const control = instanceControl();
    await initializeInstance(storage.db, control);
    const firstTime = new Date(control.createdAt.getTime() + 10);
    await updateInstance(storage.db, control.instanceId, 0, value => ({ ...value, lifecycle: 'maintenance' }), firstTime);
    await expect(updateInstance(storage.db, control.instanceId, 1, value => value, new Date(control.createdAt.getTime() + 5))).rejects.toThrow('instance_invalid');
    await expect(readInstance(storage.db, control.instanceId)).resolves.toMatchObject({ revision: 1, editRevision: 1, updatedAt: firstTime });
  } finally { await storage.close(); }
});

it('keeps the bounded audit collection under its hard per-instance limit', async () => {
  const storage = await createStorageHarness();
  try {
    const control = instanceControl();
    await initializeInstance(storage.db, control);
    const events = storage.db.collection<{ _id: string; instanceId: string; at: Date; actor: string; operation: string; fromVersion: number | null; toVersion: number | null; resultCode: string; requestId: string }>('instance_audit_events');
    await events.insertMany(Array.from({ length: 10_001 }, (_, index) => ({
      _id: randomUUID(), instanceId: control.instanceId, at: new Date(control.createdAt.getTime() + index), actor: 'synthetic-operator',
      operation: 'candidate_saved', fromVersion: null, toVersion: index, resultCode: 'accepted', requestId: randomUUID(),
    })));
    const event = { _id: randomUUID(), instanceId: control.instanceId, at: new Date(control.createdAt.getTime() + 10_002), actor: 'synthetic-operator', operation: 'candidate_saved' as const, fromVersion: null, toVersion: 1, resultCode: 'accepted', requestId: randomUUID() };
    await updateInstance(storage.db, control.instanceId, 0, value => ({ ...value, auditOutbox: [event] }), event.at);
    const held = faultDb(storage.db, 'audit-index');
    const draining = drainInstanceAudit(held.db, control.instanceId);
    await held.reached;
    await expect(drainInstanceAudit(storage.db, control.instanceId)).rejects.toThrow('instance_busy');
    held.release();
    await draining;
    expect(await events.countDocuments({ instanceId: control.instanceId })).toBeLessThanOrEqual(10_000);
    expect(await events.countDocuments({ _id: event._id, instanceId: control.instanceId })).toBe(1);
  } finally { await storage.close(); }
});

it('preserves first-owner identity and consumed bootstrap state across durable edits', async () => {
  const storage = await createStorageHarness();
  try {
    const control = readyInstance();
    await insertInstanceControl(storage.db, control);
    await expect(updateInstance(storage.db, control.instanceId, 0, value => {
      value.administrators[0].subject = 'different-owner';
      return value;
    }, new Date(control.updatedAt.getTime() + 1))).rejects.toThrow('instance_invalid');
    await expect(updateInstance(storage.db, control.instanceId, 0, value => {
      value.bootstrap.consumedAt = null;
      return value;
    }, new Date(control.updatedAt.getTime() + 1))).rejects.toThrow('instance_invalid');
    await expect(readInstance(storage.db, control.instanceId)).resolves.toMatchObject({
      revision: 0, bootstrap: { consumedAt: control.bootstrap.consumedAt }, administrators: [{ subject: 'synthetic-owner', status: 'active' }],
    });
  } finally { await storage.close(); }
});
