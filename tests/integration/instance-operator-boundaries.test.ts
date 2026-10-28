import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { issueSetupOwnerProof } from '../../lib/instance/access';
import { beginInstanceKeyRotation, serializeInstanceKeyring } from '../../lib/instance/secrets';
import { readInstance, serializeInstanceControl, updateInstance, type InstanceControl, type StoredInstanceControl } from '../../lib/instance/store';
import { instanceControl } from '../fixtures/instance';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';
import { LIMITS } from '../../lib/limits';

it('fails closed on interrupted or conflicting host maintenance authority before changing the active bundle', async () => {
  const harness = await createInstanceHarness({ port: 3224 });
  try {
    const fixture = await seedReadyInstance(harness); const now = new Date();
    const candidate = structuredClone(fixture.control.active!); candidate.version = fixture.control.nextBundleVersion; candidate.createdAt = now;
    const identity = { issuer: candidate.zitadel.issuer, projectId: candidate.zitadel.projectId, subject: 'synthetic-next-owner' };
    candidate.ownerProof = issueSetupOwnerProof({ ...fixture.control, candidate }, identity, now);
    const base = await updateInstance(harness.storage.db, harness.instanceId, fixture.control.revision,
      value => ({ ...value, candidate, nextBundleVersion: candidate.version + 1 }), now);
    await harness.storage.db.collection<typeof identity & { _id: string; roles: string[]; verifiedAt: Date }>('identity_authorizations').insertOne({ _id: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
      ...identity, roles: ['librarian-instance-admin'], verifiedAt: now });
    const ringText = await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8'); const stored = JSON.parse(ringText);
    const ring = { activeKeyId: stored.activeKeyId, keys: Object.fromEntries(Object.entries(stored.keys as Record<string, string>).map(([id, value]) => [id, Buffer.from(value, 'base64')])) };
    const capture = process.env.LIBRARIAN_COVERAGE_PROCESS_DIR ? [`--import=${pathToFileURL(resolve('tests/integration/native-coverage-register.mjs')).href}`] : [];
    const controls = harness.storage.db.collection<StoredInstanceControl>('instance_configuration');
    const storeControl = async (control: InstanceControl) => controls.replaceOne({ _id: 'instance' },
      await serializeInstanceControl(control, harness.instanceId, ring), { upsert: true });
    const invoke = (command: string, extra: string[] = []) => spawnSync(process.execPath, [...capture, resolve('scripts/instance-operator.mjs'), command,
      '--instance-id', harness.instanceId, '--revision', String(base.revision), '--processes-stopped', '--proof-id', candidate.ownerProof!.nonce, ...extra],
    { env: { ...process.env, ...harness.env }, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const cases = ['wrong-id', 'wrong-purpose', 'expired', 'missing', 'uninitialized', 'activation', 'epoch', 'rotation',
      'rotation-revision', 'maintenance-gate', 'full-rotate', 'full-recover', 'full-transfer', 'ready-recovery', 'expired-proof', 'proof-epoch', 'proof-issuer', 'proof-project'] as const;
    for (const condition of cases) {
      const command = condition === 'full-recover' || condition === 'ready-recovery' ? 'recover'
        : ['rotation-revision', 'maintenance-gate', 'full-rotate'].includes(condition) ? 'rotate-key' : 'transfer';
      const current = structuredClone(base); const at = new Date(); current.updatedAt = at;
      await writeFile(harness.env.INSTANCE_KEYRING_FILE, ringText);
      let epoch = 1;
      if (condition === 'epoch') epoch = 2;
      await writeFile(harness.env.INSTANCE_STATE_FILE, JSON.stringify({ instanceId: harness.instanceId, phase: 'initialized', recoveryEpoch: epoch }));
      await writeFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, JSON.stringify({ instanceId: harness.instanceId, epoch,
        purpose: condition === 'wrong-purpose' ? 'recover' : command, credential: randomBytes(32).toString('base64url'),
        expiresAt: new Date(at.getTime() + (condition === 'expired' ? -1 : 3600_000)).toISOString() }));
      let expected = 'operator_verified_proof_required'; const extra: string[] = [];
      if (['wrong-id', 'wrong-purpose', 'expired', 'ready-recovery'].includes(condition)) expected = 'operator_invalid_arguments';
      if (condition === 'wrong-id') extra.push('--instance-id', randomUUID());
      if (['missing', 'uninitialized', 'activation', 'epoch', 'rotation-revision'].includes(condition)) expected = 'operator_revision_conflict';
      if (condition === 'activation') {
        const id = randomUUID(); const deadline = new Date(at.getTime() + 60_000);
        current.gate = { state: 'closing', activationId: id, deadline };
        current.activation = { id, from: 1, to: 2, phase: 'draining', actor: current.administrators[0].bindingId, deadline, fencedCatalogIds: [], result: null };
      }
      if (condition === 'rotation' || condition === 'rotation-revision') {
        const pending = beginInstanceKeyRotation(ring, base.revision + (condition === 'rotation-revision' ? 1 : 0), []);
        await writeFile(harness.env.INSTANCE_KEYRING_FILE, JSON.stringify(serializeInstanceKeyring(pending)));
      }
      if (condition === 'maintenance-gate') current.lifecycle = 'maintenance';
      if (condition.startsWith('full-')) current.auditOutbox = Array.from({ length: LIMITS.maxInstanceAuditOutbox }, () => ({
        _id: randomUUID(), instanceId: harness.instanceId, at, actor: 'synthetic-operator', operation: 'candidate_saved',
        fromVersion: 1, toVersion: 2, resultCode: 'accepted', requestId: randomUUID(),
      }));
      if (['rotation', 'maintenance-gate', 'full-rotate', 'full-recover', 'full-transfer'].includes(condition)) expected = 'operator_maintenance_pending';
      if (condition === 'full-recover') extra.push('--authorize');
      if (condition === 'expired-proof') current.candidate!.ownerProof!.expiresAt = new Date(at.getTime() - 1);
      if (condition === 'proof-epoch') current.candidate!.ownerProof!.securityEpoch++;
      if (condition === 'proof-issuer') { current.candidate!.zitadel.issuer = 'https://other-identity.example.test'; current.candidate!.ownerProof!.issuer = current.candidate!.zitadel.issuer; }
      if (condition === 'proof-project') { current.candidate!.zitadel.projectId = 'other-project'; current.candidate!.ownerProof!.projectId = 'other-project'; }
      await storeControl(current);
      if (condition === 'missing') await controls.deleteOne({ _id: 'instance' });
      if (condition === 'uninitialized') await storeControl(instanceControl(harness.instanceId, base.createdAt));
      const result = invoke(command, extra);
      expect(result.status, condition).toBe(1); expect(result.stderr, condition).toContain(expected);
      if (!['missing', 'uninitialized'].includes(condition)) expect((await readInstance(harness.storage.db, harness.instanceId))!.active, condition).toEqual(base.active);
    }
    await storeControl(base); await writeFile(harness.env.INSTANCE_KEYRING_FILE, ringText);
    await writeFile(harness.env.INSTANCE_STATE_FILE, JSON.stringify({ instanceId: harness.instanceId, phase: 'initialized', recoveryEpoch: 2 }));
    await writeFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, JSON.stringify({ instanceId: harness.instanceId, epoch: 2, purpose: 'recover',
      credential: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const resumed = invoke('recover', ['--authorize']); expect(resumed.status, resumed.stderr).toBe(0);
    expect(await readInstance(harness.storage.db, harness.instanceId)).toMatchObject({ recoveryEpoch: 2, lifecycle: 'maintenance',
      bootstrap: { consumedAt: fixture.control.bootstrap.consumedAt }, active: fixture.control.active });
  } finally { await harness.close(); }
});
