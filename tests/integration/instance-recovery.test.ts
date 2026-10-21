import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';
import { seedRuntimeCatalog } from './runtime-fixtures';
import type { Catalog } from '../../lib/catalog';
import { attachInstanceKeyring, readInstance, updateInstance } from '../../lib/instance/store';
import { issueSetupOwnerProof } from '../../lib/instance/access';
import { beginInstanceKeyRotation, decryptInstanceSecret, rotateInstanceBundles, serializeInstanceKeyring } from '../../lib/instance/secrets';
import { encryptOAuthToken, decryptOAuthToken } from '../../lib/auth/tokens';

type Harness = Awaited<ReturnType<typeof createInstanceHarness>>;
async function operator(harness: Harness, purpose: 'recover' | 'rotate-key' | 'transfer') {
  const marker = JSON.parse(await readFile(harness.env.INSTANCE_STATE_FILE, 'utf8'));
  await writeFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, JSON.stringify({ instanceId: harness.instanceId, epoch: marker.recoveryEpoch,
    purpose, credential: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
}
function run(harness: Harness, command: string, revision: number, extra: string[] = [], processesStopped = true) {
  const capture = process.env.LIBRARIAN_COVERAGE_PROCESS_DIR ? [`--import=${pathToFileURL(resolve('tests/integration/native-coverage-register.mjs')).href}`] : [];
  const result = spawnSync(process.execPath, [...capture, resolve('scripts/instance-operator.mjs'), command, '--instance-id', harness.instanceId,
    '--revision', String(revision), ...(processesStopped ? ['--processes-stopped'] : []), ...extra], { env: { ...process.env, ...harness.env }, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (command === 'rotate-key' && result.status === 0) {
    const stored = JSON.parse(readFileSync(harness.env.INSTANCE_KEYRING_FILE, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    attachInstanceKeyring(harness.storage.db, { activeKeyId: stored.activeKeyId,
      keys: Object.fromEntries(Object.entries(stored.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])) });
  }
  return result;
}

it('transfers ownership only with a current target proof and fresh roles for both owners', async () => {
  const harness = await createInstanceHarness({ port: 3217 });
  try {
    const fixture = await seedReadyInstance(harness);
    await operator(harness, 'transfer');
    expect(run(harness, 'transfer', fixture.control.revision, [], false).stderr).toContain('operator_invalid_arguments');
    expect(run(harness, 'transfer', fixture.control.revision).stderr).toContain('operator_verified_proof_required');
    const now = new Date();
    const candidate = structuredClone(fixture.control.active!); candidate.version = fixture.control.nextBundleVersion;
    candidate.createdBy = fixture.control.administrators[0].bindingId; candidate.createdAt = now;
    const identity = { issuer: candidate.zitadel.issuer, subject: 'synthetic-next-owner', projectId: candidate.zitadel.projectId };
    const proof = issueSetupOwnerProof({ ...fixture.control, candidate }, identity, now); candidate.ownerProof = proof;
    const prepared = await updateInstance(harness.storage.db, harness.instanceId, fixture.control.revision, value => ({ ...value,
      candidate, nextBundleVersion: candidate.version + 1, administrators: [...value.administrators,
        { ...value.administrators[0], bindingId: randomUUID(), subject: 'historical-owner', status: 'retired' as const }],
    }), now);
    const args = ['--proof-id', proof.nonce];
    expect(run(harness, 'transfer', prepared.revision, ['--proof-id', randomUUID()]).stderr).toContain('operator_verified_proof_required');
    expect(run(harness, 'transfer', prepared.revision, args).stderr).toContain('operator_verified_proof_required');
    const records = harness.storage.db.collection('identity_authorizations');
    for (const change of [
      { roles: ['librarian-admin'], verifiedAt: now },
      { roles: ['librarian-instance-admin'], verifiedAt: new Date(now.getTime() - 900_000) },
      { roles: ['librarian-instance-admin'], verifiedAt: new Date(Date.now() + 60_000) },
    ]) {
      await records.updateOne(identity, { $set: { ...identity, ...change } }, { upsert: true });
      expect(run(harness, 'transfer', prepared.revision, args).stderr).toContain('operator_verified_proof_required');
    }
    await records.updateOne(identity, { $set: { roles: ['librarian-instance-admin'], verifiedAt: new Date() } });
    await records.updateOne(fixture.identity, { $set: { roles: [] } });
    expect(run(harness, 'transfer', prepared.revision, args).stderr).toContain('operator_verified_proof_required');
    await records.updateOne(fixture.identity, { $set: { roles: ['librarian-instance-admin'], verifiedAt: new Date() } });
    const completed = run(harness, 'transfer', prepared.revision, args);
    expect(completed.status, completed.stderr).toBe(0); expect(JSON.parse(completed.stdout).result).toBe('owner_transferred');
    const transferred = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(transferred.administrators.filter(value => value.status === 'active').map(value => value.subject)).toEqual([identity.subject]);
    expect(transferred.administrators.filter(value => value.status === 'retired')).toHaveLength(2);
    expect(transferred.securityEpoch).toBe(fixture.control.securityEpoch + 1);
    expect(transferred.recoveryEpoch).toBe(fixture.control.recoveryEpoch);
    expect(transferred.active).toEqual(fixture.control.active); expect(transferred.candidate).toBeNull();
    expect(transferred.auditOutbox.at(-1)).toMatchObject({ operation: 'owner_transferred', resultCode: 'accepted' });
  } finally { await harness.close(); }
});

it('rejects a full host keyring and mismatched recovery epochs without changing persisted provider credentials', async () => {
  const harness = await createInstanceHarness({ port: 3218 });
  try {
    const fixture = await seedReadyInstance(harness); await operator(harness, 'rotate-key');
    const ring = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8'));
    for (let index = 0; index < 7; index++) ring.keys[`synthetic-retained-${index}`] = randomBytes(32).toString('base64');
    await writeFile(harness.env.INSTANCE_KEYRING_FILE, JSON.stringify(ring));
    expect(run(harness, 'rotate-key', fixture.control.revision).stderr).toContain('operator_keyring_limit');
    expect((await readInstance(harness.storage.db, harness.instanceId))!.active).toEqual(fixture.control.active);
    await writeFile(harness.env.INSTANCE_STATE_FILE, JSON.stringify({ instanceId: harness.instanceId, phase: 'initialized', recoveryEpoch: 3 }));
    expect(run(harness, 'rotate-key', fixture.control.revision).status).not.toBe(0);
    expect((await readInstance(harness.storage.db, harness.instanceId))!.revision).toBe(fixture.control.revision);
  } finally { await harness.close(); }
});

it('re-encrypts persisted provider bundles under maintenance with the native host command and retains backup keys', async () => {
  const harness = await createInstanceHarness({ port: 3213 });
  try {
    const fixture = await seedReadyInstance(harness);
    await operator(harness, 'rotate-key');
    const original = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    const result = run(harness, 'rotate-key', fixture.control.revision);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result).toBe('key_rotated');
    const current = await readInstance(harness.storage.db, harness.instanceId);
    expect(current?.lifecycle).toBe('ready'); expect(current?.gate.state).toBe('open');
    expect(current?.active?.version).toBe(1); expect(current?.bootstrap.consumedAt).toEqual(fixture.control.bootstrap.consumedAt);
    const persisted = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    expect(persisted.activeKeyId).not.toBe(original.activeKeyId);
    expect(persisted.keys[original.activeKeyId]).toBe(original.keys[original.activeKeyId]);
    expect(Object.keys(persisted.keys)).toHaveLength(2);
    const rootKey = Buffer.from(persisted.keys[persisted.activeKeyId], 'base64');
    const authSecret = await readFile(harness.env.AUTH_SECRET_FILE, 'utf8');
    const decodedAuth = Buffer.from(authSecret, 'base64url');
    expect(rootKey.equals(Buffer.from(authSecret))).toBe(false);
    if (decodedAuth.toString('base64url') === authSecret) expect(rootKey.equals(decodedAuth)).toBe(false);
    const oauthKey = Buffer.from(await readFile(harness.env.OAUTH_TOKEN_ENCRYPTION_KEY_FILE, 'utf8'), 'base64');
    expect(rootKey.equals(oauthKey)).toBe(false);
    const ring = { activeKeyId: persisted.activeKeyId, keys: Object.fromEntries(Object.entries(persisted.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])) };
    const envelope = current!.active!.secrets.zitadelClientSecret;
    expect(envelope.keyId).toBe(persisted.activeKeyId);
    expect(decryptInstanceSecret(envelope, { instanceId: harness.instanceId, purpose: 'zitadelClientSecret', credentialVersion: envelope.credentialVersion }, ring)).toBe('SYNTHETIC_CLIENT_SENTINEL');
    expect(result.stdout).not.toContain('SYNTHETIC_CLIENT_SENTINEL'); expect(result.stdout).not.toContain(persisted.keys[persisted.activeKeyId]);
    expect(run(harness, 'rotate-key', fixture.control.revision).status).not.toBe(0);
  } finally { await harness.close(); }
});

it('resumes an interrupted host-key rotation after maintenance was persisted', async () => {
  const harness = await createInstanceHarness({ port: 3215 });
  try {
    const fixture = await seedReadyInstance(harness);
    await operator(harness, 'rotate-key');
    const stored = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    const original = { activeKeyId: stored.activeKeyId, keys: Object.fromEntries(Object.entries(stored.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])) };
    const oauthKey = Buffer.from(await readFile(harness.env.OAUTH_TOKEN_ENCRYPTION_KEY_FILE, 'utf8'), 'base64');
    const pending = beginInstanceKeyRotation(original, fixture.control.revision, [oauthKey, Buffer.from(await readFile(harness.env.AUTH_SECRET_FILE, 'utf8'))]);
    await writeFile(harness.env.INSTANCE_KEYRING_FILE, JSON.stringify(serializeInstanceKeyring(pending)));
    await updateInstance(harness.storage.db, harness.instanceId, fixture.control.revision, value => ({ ...value, lifecycle: 'maintenance',
      gate: { state: 'maintenance', activationId: null, deadline: null }, admissions: [] }), new Date(fixture.control.updatedAt.getTime() + 1));

    const resumed = run(harness, 'rotate-key', fixture.control.revision);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).result).toBe('key_rotated');
    const current = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(current.lifecycle).toBe('ready'); expect(current.gate.state).toBe('open');
    expect(current.active!.secrets.zitadelClientSecret!.keyId).toBe(pending.activeKeyId);
    expect(JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8'))).not.toHaveProperty('rotation');
    expect(current.auditOutbox.some(event => event.operation === 'key_rotated' && event.requestId === pending.rotation!.id)).toBe(true);
  } finally { await harness.close(); }
});

it('finishes host-key marker cleanup after an already committed rotation without changing OAuth ciphertext', async () => {
  const harness = await createInstanceHarness({ port: 3216 });
  try {
    const fixture = await seedReadyInstance(harness);
    await operator(harness, 'rotate-key');
    const stored = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    const original = { activeKeyId: stored.activeKeyId, keys: Object.fromEntries(Object.entries(stored.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])) };
    const oauthKey = Buffer.from(await readFile(harness.env.OAUTH_TOKEN_ENCRYPTION_KEY_FILE, 'utf8'), 'base64');
    const oauthCiphertext = encryptOAuthToken('SYNTHETIC_OAUTH_TOKEN', oauthKey);
    const account = await harness.storage.db.collection('accounts').findOne({ providerAccountId: fixture.identity.subject });
    await harness.storage.db.collection('accounts').updateOne({ _id: account!._id }, { $set: { 'encryptedTokens.access_token': oauthCiphertext } });
    const pending = beginInstanceKeyRotation(original, fixture.control.revision, [oauthKey, Buffer.from(await readFile(harness.env.AUTH_SECRET_FILE, 'utf8'))]);
    await writeFile(harness.env.INSTANCE_KEYRING_FILE, JSON.stringify(serializeInstanceKeyring(pending)));
    const now = new Date(fixture.control.updatedAt.getTime() + 1);
    const rotated = rotateInstanceBundles(fixture.control, pending, now);
    const event = { _id: randomUUID(), instanceId: harness.instanceId, at: now, actor: 'synthetic-operator', operation: 'key_rotated' as const,
      fromVersion: fixture.control.active!.version, toVersion: fixture.control.active!.version, resultCode: 'accepted', requestId: pending.rotation!.id };
    await updateInstance(harness.storage.db, harness.instanceId, fixture.control.revision,
      value => ({ ...value, ...rotated, auditOutbox: [...value.auditOutbox, event] }), now);

    const resumed = run(harness, 'rotate-key', fixture.control.revision);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).result).toBe('key_rotated');
    const latestAccount = await harness.storage.db.collection('accounts').findOne({ _id: account!._id });
    expect(latestAccount!.encryptedTokens.access_token).toBe(oauthCiphertext);
    expect(decryptOAuthToken(latestAccount!.encryptedTokens.access_token, oauthKey)).toBe('SYNTHETIC_OAUTH_TOKEN');
    expect(JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8'))).not.toHaveProperty('rotation');
  } finally { await harness.close(); }
});

it('recovers only after protected epoch advance and current verified target proof, preserving consumed setup and enrollment history', async () => {
  const harness = await createInstanceHarness({ port: 3214 });
  try {
    const fixture = await seedReadyInstance(harness);
    await operator(harness, 'recover');
    const denied = run(harness, 'recover', fixture.control.revision);
    expect(denied.status).not.toBe(0); expect(denied.stderr).toContain('operator_verified_proof_required');
    const prepared = run(harness, 'recover', fixture.control.revision, ['--authorize']);
    expect(prepared.status, prepared.stderr).toBe(0);
    const pending = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(pending.lifecycle).toBe('maintenance'); expect(pending.gate.state).toBe('maintenance');
    expect(pending.recoveryEpoch).toBe(2); expect(pending.securityEpoch).toBe(2);
    expect(pending.initializedAt).toEqual(fixture.control.initializedAt); expect(pending.bootstrap.consumedAt).toEqual(fixture.control.bootstrap.consumedAt);
    expect(pending.candidate?.ownerProof).toBeNull();
    const authority = JSON.parse(await readFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, 'utf8'));
    expect(pending.bootstrap.verifierHash).toBe(createHash('sha256').update(authority.credential).digest('hex'));
    expect(JSON.stringify(pending)).not.toContain(authority.credential);
    const identity = { issuer: pending.active!.zitadel.issuer, projectId: pending.active!.zitadel.projectId, subject: 'verified-replacement-owner' };
    const now = new Date(); const proof = issueSetupOwnerProof(pending, identity, now);
    // The controlled provider login boundary is covered separately; here the native operator consumes its stored proof.
    const verified = await updateInstance(harness.storage.db, harness.instanceId, pending.revision, value => ({ ...value,
      candidate: { ...value.candidate!, ownerProof: proof },
    }), now);
    await harness.storage.db.collection<{ _id: string } & typeof identity & { roles: string[]; verifiedAt: Date }>('identity_authorizations').insertOne({
      _id: createHash('sha256').update(`${identity.issuer}\0${identity.subject}\0${identity.projectId}`).digest('hex'), ...identity,
      roles: ['librarian-instance-admin'], verifiedAt: now,
    });
    const completed = run(harness, 'recover', verified.revision, ['--proof-id', proof.nonce]);
    expect(completed.status, completed.stderr).toBe(0);
    const recovered = (await readInstance(harness.storage.db, harness.instanceId))!;
    expect(recovered.lifecycle).toBe('ready'); expect(recovered.recoveryEpoch).toBe(2); expect(recovered.securityEpoch).toBe(3);
    expect(recovered.administrators.filter(binding => binding.kind === 'owner' && binding.status === 'active').map(binding => binding.subject)).toEqual([identity.subject]);
    expect(recovered.administrators.find(binding => binding.bindingId === fixture.control.administrators[0].bindingId)?.status).toBe('retired');
    expect(recovered.bootstrap.consumedAt).toEqual(fixture.control.bootstrap.consumedAt); expect(recovered.candidate).toBeNull();
    expect(run(harness, 'recover', verified.revision, ['--proof-id', proof.nonce]).status).not.toBe(0);
    expect(completed.stdout).not.toContain(authority.credential);
  } finally { await harness.close(); }
});

it('restores a quiesced database, host files, and published snapshot as one recovery set', async () => {
  const harness = await createInstanceHarness({ port: 3219 });
  const recoveryName = `librarian_test_restore_${randomUUID().replaceAll('-', '')}`;
  const recoveryDb = harness.storage.client.db(recoveryName);
  try {
    const fixture = await seedReadyInstance(harness);
    const runtime = await seedRuntimeCatalog('public', harness.storage);
    runtime.catalog.instanceRuntimeRevision = fixture.control.active!.version;
    runtime.catalog.instanceActivationId = null;
    await harness.storage.db.collection<Catalog>('catalogs').updateOne({ _id: runtime.catalog._id }, { $set: {
      instanceRuntimeRevision: runtime.catalog.instanceRuntimeRevision, instanceActivationId: null,
    } });
    await writeFile(join(runtime.root, 'restore-sentinel.md'), '# Consistent recovery sentinel');

    const server = await harness.start();
    expect((await fetch(server.origin + '/public-project')).status).toBe(200);
    await harness.stop();

    const backupRoot = join(harness.storage.root, 'restore-set');
    const restoredContent = join(backupRoot, 'content');
    const restoredProtected = join(backupRoot, 'protected');
    await mkdir(backupRoot);
    await cp(harness.storage.contentRoot, restoredContent, { recursive: true });
    await mkdir(restoredProtected, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      const owner = spawnSync('whoami', [], { encoding: 'utf8', windowsHide: true });
      const secured = spawnSync('icacls', [restoredProtected, '/inheritance:r', '/grant:r', `${owner.stdout.trim()}:(OI)(CI)F`],
        { encoding: 'utf8', windowsHide: true });
      if (owner.status !== 0 || secured.status !== 0) throw new Error('Could not protect restored host inputs');
    }
    for (const name of await readdir(dirname(harness.env.INSTANCE_STATE_FILE))) {
      await writeFile(join(restoredProtected, name), await readFile(join(dirname(harness.env.INSTANCE_STATE_FILE), name)), { mode: 0o600 });
    }

    for (const { name } of await harness.storage.db.listCollections({}, { nameOnly: true }).toArray()) {
      const documents = await harness.storage.db.collection(name).find({}).toArray();
      await recoveryDb.createCollection(name);
      if (documents.length) await recoveryDb.collection(name).insertMany(documents);
    }

    harness.env.MONGODB_DATABASE = recoveryName;
    harness.env.CONTENT_ROOT = restoredContent;
    for (const key of ['INSTANCE_STATE_FILE', 'INSTANCE_KEYRING_FILE', 'INSTANCE_OPERATOR_AUTH_FILE', 'INSTANCE_OUTBOUND_POLICY_FILE',
      'AUTH_SECRET_FILE', 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE', 'MONGODB_URI_FILE', 'PUBLIC_CATALOG_APPROVALS_FILE'] as const) {
      const originalPath = harness.env[key];
      if (originalPath) harness.env[key] = join(restoredProtected, basename(originalPath));
    }
    await writeFile(harness.env.MONGODB_URI_FILE, `mongodb://127.0.0.1:27018/${recoveryName}`, { mode: 0o600 });

    const restoredServer = await harness.start();
    const page = await fetch(restoredServer.origin + '/public-project');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Synthetic Portal');
    expect((await readInstance(recoveryDb, harness.instanceId))?.bootstrap.consumedAt).toEqual(fixture.control.bootstrap.consumedAt);
    expect((await recoveryDb.collection<Catalog>('catalogs').findOne({ _id: runtime.catalog._id }))?.published).toEqual(runtime.catalog.published);
    expect(await readFile(join(restoredContent, relative(harness.storage.contentRoot, runtime.root), 'restore-sentinel.md'), 'utf8'))
      .toBe('# Consistent recovery sentinel');
  } finally {
    try { await harness.stop(); }
    finally {
      try { await recoveryDb.dropDatabase(); }
      finally { await harness.close(); }
    }
  }
});
