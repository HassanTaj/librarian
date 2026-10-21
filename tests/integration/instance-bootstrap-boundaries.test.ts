import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hasInstanceRecovery, hasLegacyEnrollment, readInstanceHost, readInstancePreferences, readInstanceSetupStatus } from '../../lib/instance/bootstrap';
import { closeMongo } from '../../lib/mongo';
import type { InstanceControl } from '../../lib/instance/store';
import { instanceControl } from '../fixtures/instance';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';

it('keeps host files private and derives enrollment, recovery and public preferences only from current durable authority', async () => {
  const harness = await createInstanceHarness({ port: 3225 });
  try {
    const fixture = await seedReadyInstance(harness);
    for (const [key, value] of Object.entries(harness.env)) vi.stubEnv(key, value);
    const controls = harness.storage.db.collection<InstanceControl>('instance_configuration');
    const markerText = await readFile(harness.env.INSTANCE_STATE_FILE, 'utf8');
    const operator = JSON.parse(await readFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, 'utf8'));
    const hidden = join(harness.storage.contentRoot, 'synthetic-host-marker.json'); await writeFile(hidden, markerText);
    for (const path of [hidden, dirname(harness.env.INSTANCE_STATE_FILE)]) {
      await expect(readInstanceHost({ ...harness.env, INSTANCE_STATE_FILE: path })).rejects.toThrow('instance_host_unavailable');
    }
    await expect(readInstanceHost({ ...harness.env, NODE_ENV: 'production', INSTANCE_SETUP_ORIGIN: 'http://localhost:3225' })).rejects.toThrow('instance_host_unavailable');
    const policyPath = join(dirname(harness.env.INSTANCE_STATE_FILE), 'policy.json');
    for (const origin of ['not-a-url', 'http://identity.example.test']) {
      await writeFile(policyPath, JSON.stringify({ origins: [{ origin, addresses: ['127.0.0.1'] }] }));
      await expect(readInstanceHost({ ...harness.env, INSTANCE_OUTBOUND_POLICY_FILE: policyPath })).rejects.toThrow('instance_host_unavailable');
    }
    expect(await readInstancePreferences()).toEqual(fixture.control.active!.preferences);
    await controls.updateOne({ _id: 'instance' }, { $set: { lifecycle: 'maintenance', 'gate.state': 'maintenance' } });
    expect(await readInstancePreferences()).toBeNull();
    expect(await hasInstanceRecovery()).toBe(false);
    await writeFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, JSON.stringify({ ...operator, purpose: 'recover' }));
    expect(await hasInstanceRecovery()).toBe(true);
    await controls.updateOne({ _id: 'instance' }, { $set: { 'gate.state': 'open' } }); expect(await hasInstanceRecovery()).toBe(false);
    await controls.updateOne({ _id: 'instance' }, { $set: { 'gate.state': 'maintenance', recoveryEpoch: 2 } }); expect(await hasInstanceRecovery()).toBe(false);
    await writeFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, JSON.stringify({ ...operator, purpose: 'recover', expiresAt: new Date(Date.now() - 1).toISOString() }));
    expect(await hasInstanceRecovery()).toBe(false);
    const legacy = instanceControl(harness.instanceId, fixture.control.createdAt); legacy.lifecycle = 'legacy_migrating';
    legacy.migration = { sourceDigest: 'b'.repeat(64), mode: 'import', at: legacy.createdAt, verificationSummary: ['legacy_drained'] };
    await controls.replaceOne({ _id: 'instance' }, legacy);
    await writeFile(harness.env.INSTANCE_STATE_FILE, JSON.stringify({ instanceId: harness.instanceId, phase: 'sealed', recoveryEpoch: 1 }));
    await writeFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, JSON.stringify({ ...operator, purpose: 'bootstrap' }));
    expect(await hasLegacyEnrollment()).toBe(false);
    await writeFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, JSON.stringify({ ...operator, purpose: 'enroll' })); expect(await hasLegacyEnrollment()).toBe(true);
    await writeFile(harness.env.INSTANCE_STATE_FILE, markerText);
    await controls.replaceOne({ _id: 'instance' }, { ...fixture.control, migration: legacy.migration }); expect(await hasLegacyEnrollment()).toBe(false);
    await controls.deleteOne({ _id: 'instance' });
    await writeFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, JSON.stringify({ ...operator, purpose: 'recover' })); expect(await hasInstanceRecovery()).toBe(false);
  } finally { await closeMongo(); vi.unstubAllEnvs(); await harness.close(); }
});

it('classifies a prepared database using bounded actual collection contents instead of treating missing configuration as empty', async () => {
  const harness = await createInstanceHarness({ port: 3226 });
  try {
    expect(await readInstanceSetupStatus(harness.env)).toMatchObject({ state: 'setup_required' });
    await harness.storage.db.createCollection('synthetic_empty');
    expect(await readInstanceSetupStatus(harness.env)).toMatchObject({ state: 'setup_required' });
    await harness.storage.db.collection('synthetic_empty').insertOne({ synthetic: true });
    expect(await readInstanceSetupStatus(harness.env)).toMatchObject({ state: 'maintenance' });
    await harness.storage.db.collection('synthetic_empty').deleteMany({});
    for (let index = 0; index < 65; index++) await harness.storage.db.createCollection(`synthetic_empty_${index}`);
    expect(await readInstanceSetupStatus(harness.env)).toMatchObject({ state: 'maintenance' });
  } finally { await harness.close(); }
});
