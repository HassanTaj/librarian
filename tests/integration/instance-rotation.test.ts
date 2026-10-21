import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { CatalogSchema, type Catalog } from '../../lib/catalog';
import { beginInstanceActivation, reconcileInstanceActivation } from '../../lib/instance/activation';
import { encryptInstanceSecret } from '../../lib/instance/secrets';
import { readInstance, updateInstance } from '../../lib/instance/store';
import { catalogs } from '../fixtures/catalogs';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';

const checks = [
  ['database', 'passed', 'database_ok'], ['zitadel_discovery', 'passed', 'provider_ok'],
  ['github_structure', 'passed', 'provider_ok'], ['github_authentication', 'passed', 'provider_ok'],
  ['github_permissions', 'passed', 'provider_ok'], ['github_installation', 'warning', 'installation_missing'],
  ['github_webhook', 'warning', 'delivery_unverified'],
] as const;

it('uses the original signed bytes once, then retires the prior webhook secret at the exact five-minute boundary', async () => {
  const harness = await createInstanceHarness({ port: 3226 });
  try {
    const fixture = await seedReadyInstance(harness);
    const stored = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE!, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    const keyring = { activeKeyId: stored.activeKeyId,
      keys: Object.fromEntries(Object.entries(stored.keys).map(([id, key]) => [id, Buffer.from(key, 'base64')])) };
    const catalog = CatalogSchema.parse({ ...catalogs[0], leaseFence: 1, lease: null,
      instanceRuntimeRevision: 1, instanceActivationId: null });
    await harness.storage.db.collection<Catalog>('catalogs').insertOne(catalog);

    const now = new Date(Math.max(Date.now(), fixture.control.updatedAt.getTime() + 1));
    const candidate = structuredClone(fixture.control.active!);
    candidate.version = fixture.control.nextBundleVersion;
    candidate.createdAt = now;
    candidate.createdBy = fixture.control.administrators[0].bindingId;
    candidate.checks = checks.map(([type, status, code]) => ({ type, status, code, candidateVersion: candidate.version, at: now }));
    candidate.ownerProof = null;
    candidate.previousUntil = null;
    candidate.secrets.githubWebhookSecret = encryptInstanceSecret('SYNTHETIC_ROTATED_WEBHOOK_SECRET'.repeat(2), {
      instanceId: harness.instanceId, purpose: 'githubWebhookSecret', credentialVersion: randomUUID(),
    }, keyring, now);
    candidate.impact = { categories: ['github', 'webhook'], securityEpochIncrement: false,
      revalidateSources: false, confirmationNonce: randomUUID() };
    let prepared = await updateInstance(harness.storage.db, harness.instanceId, fixture.control.revision, value => ({ ...value,
      candidate, nextBundleVersion: candidate.version + 1,
    }), now);
    await beginInstanceActivation(harness.storage.db, harness.instanceId, prepared.editRevision, candidate.version,
      candidate.impact!.confirmationNonce, fixture.control.administrators[0].bindingId);
    expect(await reconcileInstanceActivation(harness.env)).toBe(true);
    let current = (await readInstance(harness.storage.db, harness.instanceId))!;
    const activatedAt = current.auditOutbox.find(event => event.operation === 'activated')!.at;
    expect(current.active!.secrets.previousWebhook!.acceptUntil.getTime() - activatedAt.getTime()).toBe(5 * 60_000);
    expect(current.active!.secrets.githubWebhookSecret.credentialVersion).not.toBe(fixture.control.active!.secrets.githubWebhookSecret.credentialVersion);

    const server = await harness.start();
    const deliveryId = randomUUID();
    const payload = { installation: { id: catalog.github.installationId }, repository: {
      id: catalog.github.repositoryId, full_name: `${catalog.github.owner}/${catalog.github.name}`,
    }, ref: `refs/heads/${catalog.github.branch}` };
    const originalBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
    const sign = (bytes: Buffer, secret: string) => `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
    const deliver = (bytes: Buffer) => fetch(`${server.origin}/api/webhooks/github`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-github-delivery': deliveryId, 'x-github-event': 'push',
      'x-hub-signature-256': sign(bytes, 'SYNTHETIC_WEBHOOK_SENTINEL'.repeat(2)),
    }, body: new Uint8Array(bytes) });
    expect((await deliver(originalBytes)).status).toBe(202);
    expect((await deliver(originalBytes)).status).toBe(200);
    const byteVariant = Buffer.from(JSON.stringify(payload));
    expect((await deliver(byteVariant)).status).toBe(409);
    const jobs = await harness.storage.db.collection('syncJobs').find({ 'payloadDigest': { $exists: true } }).toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payloadDigest).toBe(createHash('sha256').update(originalBytes).digest('hex'));

    current = (await readInstance(harness.storage.db, harness.instanceId))!;
    prepared = await updateInstance(harness.storage.db, harness.instanceId, current.revision, value => ({ ...value,
      active: { ...value.active!, secrets: { ...value.active!.secrets,
        previousWebhook: { ...value.active!.secrets.previousWebhook!, acceptUntil: new Date() } } },
    }));
    const expired = await deliver(originalBytes);
    expect(expired.status).toBe(403);
    expect(await expired.json()).toMatchObject({ status: 'forbidden' });
    expect(prepared.active!.secrets.previousWebhook!.acceptUntil.getTime()).toBeLessThanOrEqual(Date.now());
  } finally { await harness.close(); }
}, 30_000);

it('leaves the active App and recoverable credentials unchanged when replacement checks fail', async () => {
  const harness = await createInstanceHarness({ port: 3227 });
  try {
    const fixture = await seedReadyInstance(harness);
    const now = new Date(Math.max(Date.now(), fixture.control.updatedAt.getTime() + 1));
    const candidate = structuredClone(fixture.control.active!);
    candidate.version = fixture.control.nextBundleVersion;
    candidate.createdAt = now;
    candidate.createdBy = fixture.control.administrators[0].bindingId;
    candidate.github.appId = '99999';
    candidate.checks = checks.map(([type, status, code]) => ({ type, status, code, candidateVersion: candidate.version, at: now }));
    candidate.checks = candidate.checks.map(check => check.type === 'github_authentication'
      ? { ...check, status: 'failed', code: 'authentication_failed' } : check);
    candidate.ownerProof = null;
    candidate.previousUntil = null;
    candidate.impact = { categories: ['github'], securityEpochIncrement: false,
      revalidateSources: false, confirmationNonce: randomUUID() };
    await updateInstance(harness.storage.db, harness.instanceId, fixture.control.revision, value => ({ ...value,
      candidate, nextBundleVersion: candidate.version + 1,
    }), now);
    await expect(beginInstanceActivation(harness.storage.db, harness.instanceId, fixture.control.editRevision + 1, candidate.version,
      candidate.impact!.confirmationNonce, fixture.control.administrators[0].bindingId)).rejects.toThrow('instance_setup_incomplete');
    const current = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(current.active!.github.appId).toBe(fixture.control.active!.github.appId);
    expect(current.active!.secrets.githubPrivateKey).toEqual(fixture.control.active!.secrets.githubPrivateKey);
    expect(current.candidate!.github.appId).toBe('99999');
  } finally { await harness.close(); }
}, 30_000);
