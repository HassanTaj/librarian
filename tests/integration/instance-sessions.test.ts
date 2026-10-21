import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { expect, it, vi } from 'vitest';
import { createLibrarianAdapter } from '../../lib/auth/adapter';
import { LIMITS } from '../../lib/limits';
import type { InstanceControl } from '../../lib/instance/store';
import { readyInstance, instanceControl } from '../fixtures/instance';
import { createStorageHarness } from './http-harness';

it('rejects damaged or stale instance sessions before renewal and deletes them before delivery', async () => {
  const storage = await createStorageHarness();
  try {
    const now = Date.now(); const control = readyInstance(undefined, new Date(now));
    vi.stubEnv('INSTANCE_ID', control.instanceId);
    const controls = storage.db.collection<InstanceControl>('instance_configuration');
    await controls.insertOne(control);
    const adapter = await createLibrarianAdapter(storage.client, storage.db, control.active!.zitadel.issuer, Buffer.alloc(32, 7), () => now);
    const user = await adapter.createUser!({ id: new ObjectId().toHexString(), name: null, email: 'synthetic-session@example.invalid', emailVerified: null, image: null });
    const sessions = storage.db.collection('sessions');
    const damage = [{ createdAt: null }, { absoluteExpiresAt: null }, { expires: null },
      { absoluteExpiresAt: new Date(now - 1) }, { expires: new Date(now - 1) },
      { instanceId: randomUUID() }, { securityEpoch: 2 }, { recoveryEpoch: 2 }];
    for (const [index, changes] of damage.entries()) {
      const token = `synthetic-damaged-session-${index}`;
      await adapter.createSession!({ sessionToken: token, userId: user.id, expires: new Date(now + LIMITS.sessionAbsoluteMs) });
      await sessions.updateOne({ sessionToken: token }, { $set: changes });
      expect(await adapter.updateSession!({ sessionToken: token })).toBeNull();
      expect(await adapter.getSessionAndUser!(token)).toBeNull();
      expect(await sessions.countDocuments({ sessionToken: token })).toBe(0);
    }
    const token = 'synthetic-current-instance-session';
    const created = await adapter.createSession!({ sessionToken: token, userId: user.id, expires: new Date(now + 1) });
    expect(await sessions.findOne({ sessionToken: token })).toMatchObject({ instanceId: control.instanceId, securityEpoch: 1, recoveryEpoch: 1 });
    expect((await adapter.updateSession!({ sessionToken: token }))?.expires).toEqual(created.expires);
    expect(await adapter.getSessionAndUser!(token)).toMatchObject({ user: { id: user.id } });
    await controls.updateOne({ _id: control._id }, { $set: { lifecycle: 'maintenance', 'gate.state': 'maintenance' } });
    await expect(adapter.createSession!({ sessionToken: 'blocked', userId: user.id, expires: created.expires })).rejects.toThrow('session_storage_unavailable');
    await expect(adapter.getSessionAndUser!(token)).rejects.toThrow('session_storage_unavailable');
    expect(await sessions.countDocuments({ sessionToken: token })).toBe(1);
    await controls.deleteMany({});
    const legacy = instanceControl(control.instanceId, new Date(now));
    legacy.lifecycle = 'legacy_migrating'; legacy.migration = { sourceDigest: 'b'.repeat(64), mode: 'import', at: new Date(now), verificationSummary: ['legacy_drained'] };
    await controls.insertOne(legacy);
    await adapter.createSession!({ sessionToken: 'synthetic-legacy-session', userId: user.id, expires: created.expires });
    expect(await sessions.findOne({ sessionToken: 'synthetic-legacy-session' })).not.toHaveProperty('instanceId');
    expect(await adapter.getSessionAndUser!('synthetic-legacy-session')).toMatchObject({ user: { id: user.id } });
  } finally { vi.unstubAllEnvs(); await storage.close(); }
});
