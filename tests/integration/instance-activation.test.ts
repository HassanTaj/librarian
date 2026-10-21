import { createHmac, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { acquireInstanceAdmission, issueSetupOwnerProof, releaseInstanceAdmission, withInstanceAdmission } from '../../lib/instance/access';
import { beginInstanceActivation, commitInitialInstance, reconcileInitialAdoption, reconcileInstanceActivation } from '../../lib/instance/activation';
import type { Catalog } from '../../lib/catalog';
import { readInstance, updateInstance, type InstanceControl } from '../../lib/instance/store';
import { CatalogSchema } from '../../lib/catalog';
import { catalogs } from '../fixtures/catalogs';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';
import { encryptInstanceSecret } from '../../lib/instance/secrets';
import { instanceControl } from '../fixtures/instance';
import { createBlobCache } from '../../lib/content/blob-cache';
import { blobSha } from '../../lib/sync/github';
import { startNextHarness } from './http-harness';

const checkResults = [
  ['database', 'passed', 'database_ok'],
  ['zitadel_discovery', 'passed', 'provider_ok'],
  ['github_structure', 'passed', 'provider_ok'],
  ['github_authentication', 'passed', 'provider_ok'],
  ['github_permissions', 'passed', 'provider_ok'],
  ['github_installation', 'warning', 'installation_missing'],
  ['github_webhook', 'warning', 'delivery_unverified'],
] as const;

async function saveCandidate(harness: Awaited<ReturnType<typeof createInstanceHarness>>, control: InstanceControl) {
  const actor = control.administrators[0].bindingId;
  const now = new Date();
  const candidate = structuredClone(control.active!);
  candidate.version = control.nextBundleVersion;
  candidate.createdAt = now;
  candidate.createdBy = actor;
  candidate.preferences.displayName = 'Reviewed synthetic portal';
  candidate.checks = checkResults.map(([type, status, code]) => ({ type, status, code, candidateVersion: candidate.version, at: now }));
  candidate.ownerProof = null;
  candidate.previousUntil = null;
  candidate.impact = { categories: ['preferences'], securityEpochIncrement: false, revalidateSources: false, confirmationNonce: randomUUID() };
  return updateInstance(harness.storage.db, harness.instanceId, control.revision, current => ({ ...current,
    candidate, nextBundleVersion: candidate.version + 1,
  }), now);
}

it('drains a real request pin, fences catalog leases and commits one retained previous bundle', async () => {
  const harness = await createInstanceHarness({ port: 3215 });
  try {
    const fixture = await seedReadyInstance(harness);
    const original = structuredClone(fixture.control.active!);
    const candidateState = await saveCandidate(harness, fixture.control);
    const catalog = CatalogSchema.parse({ ...catalogs[0], createdAt: new Date(), updatedAt: new Date(), leaseFence: 1,
      lease: { owner: randomUUID(), fence: 1, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 30_000) },
      instanceRuntimeRevision: 1, instanceActivationId: null });
    await harness.storage.db.collection<Catalog>('catalogs').insertOne(catalog);

    const pin = await acquireInstanceAdmission(harness.storage.db, harness.instanceId, 'request');
    const closing = await beginInstanceActivation(harness.storage.db, harness.instanceId, candidateState.editRevision,
      candidateState.candidate!.version, candidateState.candidate!.impact!.confirmationNonce, fixture.control.administrators[0].bindingId);
    expect(closing.gate.state).toBe('closing');
    expect(await reconcileInstanceActivation(harness.env, process.cwd())).toBe(false);
    expect((await harness.storage.db.collection<InstanceControl>('instance_configuration').findOne({ _id: 'instance' }))?.lifecycle).toBe('ready');

    await releaseInstanceAdmission(harness.storage.db, harness.instanceId, pin.id);
    expect(await reconcileInstanceActivation(harness.env, process.cwd())).toBe(true);
    const activated = await harness.storage.db.collection<InstanceControl>('instance_configuration').findOne({ _id: 'instance' });
    expect(activated).toMatchObject({ lifecycle: 'ready', gate: { state: 'open' }, activation: null,
      active: { version: candidateState.candidate!.version, preferences: { displayName: 'Reviewed synthetic portal' } },
      previous: { version: original.version }, securityEpoch: fixture.control.securityEpoch,
      auditOutbox: [expect.objectContaining({ operation: 'activated', resultCode: 'accepted' })],
    });
    const fenced = await harness.storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id });
    expect(fenced).toMatchObject({ instanceRuntimeRevision: candidateState.candidate!.version, instanceActivationId: closing.activation!.id,
      configRevision: catalog.configRevision, leaseFence: 2, lease: null });
  } finally { await harness.close(); }
}, 30_000);

it('shares the activation gate and committed revision across two app processes and a peer restart', async () => {
  const harness = await createInstanceHarness({ port: 3230 });
  let peer: Awaited<ReturnType<typeof startNextHarness>> | undefined;
  try {
    const fixture = await seedReadyInstance(harness);
    const primary = await harness.start();
    peer = await startNextHarness({ appRoot: process.cwd(), port: 3231, env: harness.env });
    const peerState = async () => {
      const response = await fetch(`${peer!.origin}/api/instance/settings`, { headers: fixture.headers() });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await peerState()).toMatchObject({ activeVersion: 1, candidateVersion: null });

    const candidate = await saveCandidate(harness, fixture.control);
    const pin = await acquireInstanceAdmission(harness.storage.db, harness.instanceId, 'request');
    const pending = await fetch(`${primary.origin}/api/instance/settings/activate`, {
      method: 'POST', headers: fixture.headers({ 'Content-Type': 'application/json', 'If-Match': `"${candidate.editRevision}"` }),
      body: JSON.stringify({ candidateVersion: candidate.candidate!.version,
        confirmationNonce: candidate.candidate!.impact!.confirmationNonce, confirm: true }),
    });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ status: 'pending', activeVersion: 1, candidateVersion: 2 });
    const health = await fetch(`${peer.origin}/api/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: 'not_ready' });

    await releaseInstanceAdmission(harness.storage.db, harness.instanceId, pin.id);
    expect(await reconcileInstanceActivation(harness.env, process.cwd())).toBe(true);
    expect(await peerState()).toMatchObject({ activeVersion: 2, candidateVersion: null });
    const committed = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(await reconcileInstanceActivation(harness.env, process.cwd())).toBe(false);
    expect((await readInstance(harness.storage.db, harness.instanceId))!.revision).toBe(committed.revision);

    await peer.close();
    peer = await startNextHarness({ appRoot: process.cwd(), port: 3231, env: harness.env });
    expect(await peerState()).toMatchObject({ activeVersion: 2, candidateVersion: null });
  } finally {
    await peer?.close();
    await harness.close();
  }
}, 90_000);

it('does not rename a blob after its worker admission expires during the write', async () => {
  const harness = await createInstanceHarness({ port: 3224 });
  const previousInstanceId = process.env.INSTANCE_ID;
  process.env.INSTANCE_ID = harness.instanceId;
  try {
    await seedReadyInstance(harness);
    const catalogId = CatalogSchema.parse(catalogs[0])._id;
    const bytes = Buffer.from('synthetic fenced blob');
    const sha = blobSha(bytes);
    let releaseWrite!: () => void;
    let enteredWrite!: () => void;
    const writeEntered = new Promise<void>(resolve => { enteredWrite = resolve; });
    const allowWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    let checks = 0;
    const cache = createBlobCache(harness.storage.contentRoot, catalogId, 1, 1024, new AbortController().signal, async () => {
      if (++checks === 2) { enteredWrite(); await allowWrite; }
      return true;
    });
    const operation = withInstanceAdmission(harness.storage.db, harness.instanceId, 'worker', () => cache.put(sha, bytes));
    await writeEntered;
    await harness.storage.db.collection<InstanceControl>('instance_configuration').updateOne({ _id: 'instance' },
      { $set: { 'admissions.$[pin].expiresAt': new Date(Date.now() - 1) } }, { arrayFilters: [{ 'pin.purpose': 'worker' }] });
    releaseWrite();
    await expect(operation).rejects.toThrow('instance_admission_expired');
    await expect(cache.get(sha, bytes.length)).resolves.toBeUndefined();
    expect(await readdir(`${harness.storage.contentRoot}/${catalogId}/blob-cache`)).toEqual([]);
  } finally {
    if (previousInstanceId === undefined) delete process.env.INSTANCE_ID;
    else process.env.INSTANCE_ID = previousInstanceId;
    await harness.close();
  }
}, 30_000);

it('reports pending Apply while a request drains and reports active only with current worker health', async () => {
  const harness = await createInstanceHarness({ port: 3222 });
  try {
    const fixture = await seedReadyInstance(harness); const candidate = await saveCandidate(harness, fixture.control);
    const server = await harness.start();
    const apply = (body: unknown, revision = candidate.editRevision) => fetch(`${server.origin}/api/instance/settings/activate`, {
      method: 'POST', headers: fixture.headers({ 'content-type': 'application/json', 'if-match': `"${revision}"` }), body: JSON.stringify(body),
    });
    const input = { candidateVersion: candidate.candidate!.version, confirmationNonce: candidate.candidate!.impact!.confirmationNonce, confirm: true };
    expect((await apply({ ...input, confirm: false })).status).toBe(400);
    expect((await apply(input, candidate.editRevision - 1)).status).toBe(409);
    const pin = await acquireInstanceAdmission(harness.storage.db, harness.instanceId, 'request');
    const pending = await apply(input);
    expect(pending.status, await pending.clone().text()).toBe(202);
    expect(await pending.json()).toMatchObject({ status: 'pending', activeVersion: 1, candidateVersion: 2 });
    await releaseInstanceAdmission(harness.storage.db, harness.instanceId, pin.id);
    expect(await reconcileInstanceActivation(harness.env)).toBe(true);
    const active = (await readInstance(harness.storage.db, harness.instanceId))!;
    const next = await saveCandidate(harness, active);
    await harness.storage.db.collection('syncWorkerStatus').insertOne({ enabled: true, healthy: true, active: false, updatedAt: new Date(),
      instanceId: harness.instanceId, activeVersion: next.candidate!.version, securityEpoch: next.securityEpoch, recoveryEpoch: next.recoveryEpoch });
    const completed = await apply({ candidateVersion: next.candidate!.version, confirmationNonce: next.candidate!.impact!.confirmationNonce, confirm: true }, next.editRevision);
    expect(completed.status, await completed.clone().text()).toBe(200);
    const result = await completed.json(); expect(result).toMatchObject({ status: 'active', activeVersion: 3, candidateVersion: null });
    expect(JSON.stringify(result)).not.toMatch(/ciphertext|SYNTHETIC_CLIENT_SENTINEL/);
  } finally { await harness.close(); }
}, 30_000);

it('keeps a committed candidate in maintenance when local marker adoption evidence is incomplete', async () => {
  const harness = await createInstanceHarness({ port: 3224 });
  try {
    const fixture = await seedReadyInstance(harness);
    const candidate = await saveCandidate(harness, fixture.control);
    const owner = candidate.administrators[0];
    await beginInstanceActivation(harness.storage.db, harness.instanceId, candidate.editRevision, candidate.candidate!.version,
      candidate.candidate!.impact!.confirmationNonce, owner.bindingId);
    await writeFile(harness.env.INSTANCE_STATE_FILE!, JSON.stringify({ instanceId: harness.instanceId, phase: 'sealed', recoveryEpoch: candidate.recoveryEpoch }), { mode: 0o600 });

    expect(await reconcileInstanceActivation(harness.env)).toBe(false);
    const pending = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(pending).toMatchObject({ lifecycle: 'maintenance', gate: { state: 'maintenance' },
      active: { version: candidate.candidate!.version }, previous: { version: 1 }, candidate: null,
      activation: { phase: 'adopting' } });
  } finally { await harness.close(); }
}, 30_000);

it('accepts a previous webhook credential only during its explicit ready-state overlap window', async () => {
  const harness = await createInstanceHarness({ port: 3223 });
  try {
    const fixture = await seedReadyInstance(harness);
    const keys = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8'));
    const ring = { activeKeyId: keys.activeKeyId, keys: Object.fromEntries(Object.entries(keys.keys as Record<string, string>).map(([id, value]) => [id, Buffer.from(value, 'base64')])) };
    const envelope = encryptInstanceSecret('SYNTHETIC_PREVIOUS_WEBHOOK', { instanceId: harness.instanceId,
      purpose: 'githubWebhookSecret', credentialVersion: randomUUID() }, ring);
    let current = await updateInstance(harness.storage.db, harness.instanceId, fixture.control.revision, value => ({ ...value,
      active: { ...value.active!, secrets: { ...value.active!.secrets, previousWebhook: { envelope, acceptUntil: new Date(Date.now() + 300_000) } } },
    }));
    const server = await harness.start(); const body = '{}';
    const deliver = (secret: string) => fetch(`${server.origin}/api/webhooks/github`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-github-delivery': randomUUID(), 'x-github-event': 'ping',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    }, body });
    expect((await deliver('SYNTHETIC_PREVIOUS_WEBHOOK')).status).toBe(202);
    expect((await deliver('SYNTHETIC_WRONG_WEBHOOK')).status).toBe(403);
    current = (await readInstance(harness.storage.db, harness.instanceId))!;
    await updateInstance(harness.storage.db, harness.instanceId, current.revision, value => ({ ...value,
      active: { ...value.active!, secrets: { ...value.active!.secrets, previousWebhook: { envelope, acceptUntil: new Date(Date.now() - 1) } } },
    }));
    expect((await deliver('SYNTHETIC_PREVIOUS_WEBHOOK')).status).toBe(403);
    expect((await deliver('SYNTHETIC_WEBHOOK_SENTINEL'.repeat(2))).status).toBe(202);
    expect((await readInstance(harness.storage.db, harness.instanceId))!.admissions).toHaveLength(0);
  } finally { await harness.close(); }
}, 30_000);

it('keeps timed-out activation in maintenance across retries and preserves the last active bundle', async () => {
  const harness = await createInstanceHarness({ port: 3219 });
  try {
    const fixture = await seedReadyInstance(harness); const candidate = await saveCandidate(harness, fixture.control);
    const closing = await beginInstanceActivation(harness.storage.db, harness.instanceId, candidate.editRevision,
      candidate.candidate!.version, candidate.candidate!.impact!.confirmationNonce, fixture.control.administrators[0].bindingId);
    const deadline = new Date(fixture.control.createdAt.getTime() + 1);
    await harness.storage.db.collection<InstanceControl>('instance_configuration').updateOne({ _id: 'instance' }, {
      $set: { 'activation.deadline': deadline, 'gate.deadline': deadline },
    });
    expect(await reconcileInstanceActivation(harness.env)).toBe(false);
    const timedOut = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(timedOut).toMatchObject({ lifecycle: 'maintenance', gate: { state: 'maintenance' },
      activation: { id: closing.activation!.id, phase: 'maintenance', result: 'activation_timeout' }, active: fixture.control.active });
    expect(await reconcileInstanceActivation(harness.env)).toBe(false);
    expect((await readInstance(harness.storage.db, harness.instanceId))!.revision).toBe(timedOut.revision);
  } finally { await harness.close(); }
});

it('atomically replaces identity authority and retains only the bounded prior webhook secret on activation', async () => {
  const harness = await createInstanceHarness({ port: 3220 });
  try {
    const fixture = await seedReadyInstance(harness); let prepared = await saveCandidate(harness, fixture.control);
    const storedRing = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8'));
    const ring = { activeKeyId: storedRing.activeKeyId, keys: Object.fromEntries(Object.entries(storedRing.keys as Record<string, string>).map(([key, value]) => [key, Buffer.from(value, 'base64')])) };
    const now = new Date(); const candidate = prepared.candidate!;
    candidate.zitadel.projectId = 'synthetic-replacement-project';
    candidate.impact = { categories: ['identity', 'webhook'], securityEpochIncrement: true, revalidateSources: false, confirmationNonce: randomUUID() };
    candidate.secrets.githubWebhookSecret = encryptInstanceSecret('SYNTHETIC_REPLACEMENT_WEBHOOK', { instanceId: harness.instanceId,
      purpose: 'githubWebhookSecret', credentialVersion: randomUUID() }, ring, now);
    candidate.ownerProof = issueSetupOwnerProof({ ...prepared, candidate }, { issuer: candidate.zitadel.issuer,
      subject: 'synthetic-replacement-owner', projectId: candidate.zitadel.projectId }, now);
    prepared = await updateInstance(harness.storage.db, harness.instanceId, prepared.revision, value => ({ ...value, candidate }), now);
    await beginInstanceActivation(harness.storage.db, harness.instanceId, prepared.editRevision, candidate.version,
      candidate.impact.confirmationNonce, fixture.control.administrators[0].bindingId);
    expect(await reconcileInstanceActivation(harness.env)).toBe(true);
    const active = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(active.securityEpoch).toBe(fixture.control.securityEpoch + 1);
    expect(active.administrators.filter(binding => binding.status === 'active')).toEqual([expect.objectContaining({
      subject: 'synthetic-replacement-owner', projectId: candidate.zitadel.projectId, kind: 'owner',
    })]);
    expect(active.administrators.find(binding => binding.bindingId === fixture.control.administrators[0].bindingId)?.status).toBe('retired');
    expect(active.active!.secrets.previousWebhook?.envelope).toEqual(fixture.control.active!.secrets.githubWebhookSecret);
    expect(active.active!.secrets.previousWebhook!.acceptUntil.getTime() - active.active!.createdAt.getTime()).toBeLessThanOrEqual(301_000);
    expect(active.previous!.secrets.githubWebhookSecret).toEqual(fixture.control.active!.secrets.githubWebhookSecret);
  } finally { await harness.close(); }
});

it('resumes initial legacy adoption after requests drain and fences persisted catalogs before becoming ready', async () => {
  const harness = await createInstanceHarness({ port: 3221 });
  try {
    const fixture = await seedReadyInstance(harness); const now = new Date();
    const control = instanceControl(harness.instanceId, fixture.control.createdAt);
    control.updatedAt = now; control.lifecycle = 'awaiting_owner'; control.nextBundleVersion = 2;
    control.candidate = structuredClone(fixture.control.active!);
    control.candidate.impact = { categories: ['identity', 'github'], securityEpochIncrement: true, revalidateSources: true, confirmationNonce: randomUUID() };
    control.candidate.checks = [...checkResults.map(([type, status, code]) => ({ type, status, code, candidateVersion: 1, at: now })),
      { type: 'zitadel_owner_login', status: 'passed', code: 'provider_ok', candidateVersion: 1, at: now }];
    control.candidate.ownerProof = issueSetupOwnerProof(control, { issuer: control.candidate.zitadel.issuer,
      subject: 'synthetic-owner', projectId: control.candidate.zitadel.projectId }, now);
    control.migration = { sourceDigest: 'b'.repeat(64), mode: 'import', at: now, verificationSummary: ['legacy_drained'] };
    await harness.storage.db.collection<InstanceControl>('instance_configuration').replaceOne({ _id: 'instance' }, control);
    await writeFile(harness.env.INSTANCE_STATE_FILE, JSON.stringify({ instanceId: harness.instanceId, phase: 'sealed', recoveryEpoch: 1 }));
    const catalog = CatalogSchema.parse(catalogs[0]); await harness.storage.db.collection<Catalog>('catalogs').insertOne(catalog);
    const pin = await acquireInstanceAdmission(harness.storage.db, harness.instanceId, 'request');
    const admitted = (await readInstance(harness.storage.db, harness.instanceId))!;
    const closing = await commitInitialInstance(harness.storage.db, harness.instanceId, admitted.revision, 1, control.candidate.impact.confirmationNonce);
    expect(closing.gate.state).toBe('closing');
    expect(await reconcileInitialAdoption(harness.env)).toBe(false);
    expect((await readInstance(harness.storage.db, harness.instanceId))!.initializedAt).toBeNull();
    await releaseInstanceAdmission(harness.storage.db, harness.instanceId, pin.id);
    expect(await reconcileInitialAdoption(harness.env)).toBe(true);
    const adopted = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(adopted).toMatchObject({ lifecycle: 'ready', gate: { state: 'open' }, activation: null, securityEpoch: 2 });
    expect(await harness.storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id })).toMatchObject({
      leaseFence: catalog.leaseFence + 1, lease: null, instanceRuntimeRevision: 1, instanceActivationId: closing.activation!.id,
    });
    expect(JSON.parse(await readFile(harness.env.INSTANCE_STATE_FILE, 'utf8')).phase).toBe('initialized');
    expect(await reconcileInitialAdoption(harness.env)).toBe(true);
  } finally { await harness.close(); }
});

it('turns rollback into a monotonic candidate and rejects stale confirmation without changing active state', async () => {
  const harness = await createInstanceHarness({ port: 3216 });
  try {
    const fixture = await seedReadyInstance(harness);
    const now = new Date();
    const active = structuredClone(fixture.control.active!);
    active.version = 2;
    active.createdAt = now;
    active.impact = { categories: ['preferences'], securityEpochIncrement: false, revalidateSources: false, confirmationNonce: randomUUID() };
    const previous = structuredClone(fixture.control.active!);
    previous.previousUntil = new Date(now.getTime() + 60 * 60_000);
    const prepared = await updateInstance(harness.storage.db, harness.instanceId, fixture.control.revision, current => ({ ...current,
      active, previous, nextBundleVersion: 3,
    }), now);
    const server = await harness.start();
    const headers = fixture.headers({ 'content-type': 'application/json', 'if-match': `"${prepared.editRevision}"` });
    const rollback = await fetch(`${server.origin}/api/instance/settings/rollback`, { method: 'POST', headers,
      body: JSON.stringify({ previousVersion: previous.version, confirmationNonce: active.impact!.confirmationNonce, confirm: true }),
    });
    expect(rollback.status, await rollback.clone().text()).toBe(200);
    const draft = await rollback.json();
    expect(draft).toMatchObject({ state: 'ready', activeVersion: 2, candidateVersion: 3,
      impact: { securityEpochIncrement: true, categories: ['preferences', 'origin', 'identity', 'github'] },
    });
    expect(JSON.stringify(draft)).not.toContain('SYNTHETIC_CLIENT_SENTINEL');
    expect(JSON.stringify(draft)).not.toContain('ciphertext');
    const current = await harness.storage.db.collection<InstanceControl>('instance_configuration').findOne({ _id: 'instance' });
    expect(current).toMatchObject({ active: { version: 2 }, previous: { version: 1 }, candidate: { version: 3 }, nextBundleVersion: 4 });
    expect(current!.active!.secrets.githubWebhookSecret.credentialVersion).toBe(previous.secrets.githubWebhookSecret.credentialVersion);

    const storedRing = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE!, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    const keyring = { activeKeyId: storedRing.activeKeyId,
      keys: Object.fromEntries(Object.entries(storedRing.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])) };
    const retiredAt = new Date(Math.max(Date.now(), current!.updatedAt.getTime() + 1));
    const retiredWebhook = encryptInstanceSecret('SYNTHETIC_RETIRED_WEBHOOK', { instanceId: harness.instanceId,
      purpose: 'githubWebhookSecret', credentialVersion: randomUUID() }, keyring, retiredAt);
    const retired = await updateInstance(harness.storage.db, harness.instanceId, current!.revision, value => ({ ...value,
      previous: { ...value.previous!, secrets: { ...value.previous!.secrets, githubWebhookSecret: retiredWebhook } },
    }), retiredAt);
    const retiredRollback = await fetch(`${server.origin}/api/instance/settings/rollback`, { method: 'POST', headers: fixture.headers({
      'content-type': 'application/json', 'if-match': `"${retired.editRevision}"`,
    }), body: JSON.stringify({ previousVersion: previous.version, confirmationNonce: active.impact!.confirmationNonce, confirm: true }),
    });
    expect(retiredRollback.status).toBe(409);
    expect(await retiredRollback.json()).toMatchObject({ error: { code: 'owner_continuity_required' } });
    expect(await harness.storage.db.collection<InstanceControl>('instance_configuration').findOne({ _id: 'instance' }))
      .toMatchObject({ active: { version: 2 }, candidate: { version: 3 } });

    const stale = await fetch(`${server.origin}/api/instance/settings/rollback`, { method: 'POST', headers,
      body: JSON.stringify({ previousVersion: previous.version, confirmationNonce: active.impact!.confirmationNonce, confirm: true }),
    });
    expect(stale.status).toBe(409);
    expect((await harness.storage.db.collection<InstanceControl>('instance_configuration').findOne({ _id: 'instance' }))?.active?.version).toBe(2);
  } finally { await harness.close(); }
}, 30_000);
