import { readFile, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { processNextSyncJob } from '../../lib/sync/worker';
import { closeMongo } from '../../lib/mongo';
import { instanceControl } from '../fixtures/instance';
import { serializeInstanceControl, type StoredInstanceControl } from '../../lib/instance/store';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';

it('refreshes stale worker authority from the active bundle and rejects unavailable or closing authority before claiming jobs', async () => {
  const harness = await createInstanceHarness({ port: 3228 });
  try {
    const fixture = await seedReadyInstance(harness);
    for (const [key, value] of Object.entries(harness.env)) vi.stubEnv(key, value);
    const current = { instanceId: harness.instanceId, activeVersion: 1, securityEpoch: 1, recoveryEpoch: 1 };
    const readCandidate = vi.fn();
    for (const authority of [undefined, { ...current, activeVersion: 0 }, { ...current, securityEpoch: 0 }, { ...current, recoveryEpoch: 0 }, current]) {
      const options: Parameters<typeof processNextSyncJob>[0] = { db: harness.storage.db, contentRoot: harness.storage.contentRoot, instance: authority, readCandidate };
      expect(await processNextSyncJob(options)).toBe('idle'); expect(options.instance).toEqual(current);
      if (authority !== current) expect(options.github?.githubAppId).toBe(fixture.control.active!.github.appId);
    }
    expect(readCandidate).not.toHaveBeenCalled();
    const controls = harness.storage.db.collection<StoredInstanceControl>('instance_configuration');
    const keyData = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    const keyring = { activeKeyId: keyData.activeKeyId, keys: Object.fromEntries(Object.entries(keyData.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])) };
    const legacy = instanceControl(harness.instanceId, fixture.control.createdAt); legacy.lifecycle = 'legacy_migrating';
    legacy.migration = { sourceDigest: 'b'.repeat(64), mode: 'import', at: legacy.createdAt, verificationSummary: ['legacy_drained'] };
    await controls.replaceOne({ _id: 'instance' }, await serializeInstanceControl(legacy, harness.instanceId, keyring));
    await writeFile(harness.env.INSTANCE_STATE_FILE, JSON.stringify({ instanceId: harness.instanceId, phase: 'sealed', recoveryEpoch: 1 }));
    expect(await processNextSyncJob({ db: harness.storage.db, contentRoot: harness.storage.contentRoot, readCandidate })).toBe('idle');
    vi.stubEnv('INSTANCE_ID', undefined); vi.stubEnv('INSTANCE_STATE_FILE', undefined);
    for (const value of [instanceControl(harness.instanceId, fixture.control.createdAt),
      { ...fixture.control, lifecycle: 'maintenance' as const }, { ...fixture.control, gate: { ...fixture.control.gate, state: 'maintenance' as const } }]) {
      await controls.replaceOne({ _id: 'instance' }, await serializeInstanceControl(value, harness.instanceId, keyring));
      await expect(processNextSyncJob({ db: harness.storage.db, contentRoot: harness.storage.contentRoot, readCandidate, instance: current })).rejects.toThrow('instance_busy');
    }
    await controls.deleteOne({ _id: 'instance' });
    await expect(processNextSyncJob({ db: harness.storage.db, contentRoot: harness.storage.contentRoot, readCandidate, instance: current })).rejects.toThrow('instance_busy');
    expect(readCandidate).not.toHaveBeenCalled();
  } finally { await closeMongo(); vi.unstubAllEnvs(); await harness.close(); }
});
