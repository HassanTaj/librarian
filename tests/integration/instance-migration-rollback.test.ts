import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { CatalogSchema, type Catalog } from '../../lib/catalog';
import { encryptOAuthToken, decryptOAuthToken } from '../../lib/auth/tokens';
import { issueSetupOwnerProof } from '../../lib/instance/access';
import { commitInitialInstance, reconcileInitialAdoption } from '../../lib/instance/activation';
import { encryptInstanceSecret } from '../../lib/instance/secrets';
import { initializeInstance, readInstance, updateInstance } from '../../lib/instance/store';
import { loadConfig } from '../../lib/config';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { catalogs } from '../fixtures/catalogs';
import { createInstanceHarness } from './instance-harness';

it('rejects an undrained migration, preserves legacy authority before cutover, and resumes a committed cutover after a crash', async () => {
  const harness = await createInstanceHarness({ port: 3222 });
  try {
    const now = new Date();
    const instanceId = harness.instanceId;
    const stateRoot = dirname(harness.env.INSTANCE_STATE_FILE);
    const legacy = {
      authUrl: 'https://portal.synthetic.invalid',
      clientId: 'synthetic-legacy-client',
      issuer: 'https://identity.synthetic.invalid',
      projectId: 'synthetic-legacy-project',
      audience: 'synthetic-legacy-api',
      appId: '12345',
      oidcSecret: 'SYNTHETIC_LEGACY_OIDC_SECRET'.repeat(2),
      webhookSecret: 'SYNTHETIC_LEGACY_WEBHOOK_SECRET'.repeat(2),
    };
    const legacyFiles = {
      oidc: join(stateRoot, 'legacy-oidc.secret'),
      github: join(stateRoot, 'legacy-github.pem'),
      webhook: join(stateRoot, 'legacy-webhook.secret'),
    };
    await Promise.all([
      writeFile(legacyFiles.oidc, legacy.oidcSecret, { mode: 0o600 }),
      writeFile(legacyFiles.github, harness.providers.privateKey, { mode: 0o600 }),
      writeFile(legacyFiles.webhook, legacy.webhookSecret, { mode: 0o600 }),
      writeFile(harness.env.INSTANCE_STATE_FILE, JSON.stringify({ instanceId, phase: 'sealed', recoveryEpoch: 1 }), { mode: 0o600 }),
    ]);
    Object.assign(harness.env, {
      AUTH_URL: legacy.authUrl, AUTH_ZITADEL_ID: legacy.clientId, AUTH_ZITADEL_ISSUER: legacy.issuer,
      ZITADEL_PROJECT_ID: legacy.projectId, ZITADEL_API_AUDIENCE: legacy.audience, GITHUB_APP_ID: legacy.appId,
      AUTH_ZITADEL_SECRET_FILE: legacyFiles.oidc, GITHUB_APP_PRIVATE_KEY_FILE: legacyFiles.github,
      GITHUB_WEBHOOK_SECRET_FILE: legacyFiles.webhook,
    });

    const ready = readyInstance(instanceId, now);
    const control = instanceControl(instanceId, now);
    control.bootstrap.verifierHash = createHash('sha256').update('SYNTHETIC_MIGRATION_OPERATOR').digest('hex');
    const candidate = structuredClone(ready.active!);
    const encodedKeyring = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    const keyring = { activeKeyId: encodedKeyring.activeKeyId,
      keys: Object.fromEntries(Object.entries(encodedKeyring.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])) };
    candidate.version = 1;
    candidate.createdAt = now;
    candidate.createdBy = 'synthetic-legacy-owner';
    candidate.publicOrigin = legacy.authUrl;
    candidate.zitadel = { issuer: legacy.issuer, clientId: legacy.clientId, projectId: legacy.projectId, audience: legacy.audience };
    candidate.github = { provider: 'github', appId: legacy.appId };
    candidate.secrets = {
      zitadelClientSecret: encryptInstanceSecret(legacy.oidcSecret, { instanceId, purpose: 'zitadelClientSecret', credentialVersion: randomUUID() }, keyring, now),
      githubPrivateKey: encryptInstanceSecret(harness.providers.privateKey, { instanceId, purpose: 'githubPrivateKey', credentialVersion: randomUUID() }, keyring, now),
      githubWebhookSecret: encryptInstanceSecret(legacy.webhookSecret, { instanceId, purpose: 'githubWebhookSecret', credentialVersion: randomUUID() }, keyring, now),
      previousWebhook: null,
    };
    candidate.checks = ([
      'database', 'zitadel_discovery', 'zitadel_owner_login', 'github_structure', 'github_authentication', 'github_permissions',
      'github_installation', 'github_webhook',
    ] as const).map(type => ({ type, candidateVersion: 1, at: now, status: type === 'github_installation' || type === 'github_webhook' ? 'warning' as const : 'passed' as const,
      code: type === 'github_installation' ? 'installation_missing' as const : type === 'github_webhook' ? 'delivery_unverified' as const
        : type === 'database' ? 'database_ok' as const : 'provider_ok' as const }));
    candidate.impact = { categories: ['preferences'], securityEpochIncrement: false, revalidateSources: false, confirmationNonce: randomUUID() };
    const owner = { issuer: legacy.issuer, subject: 'synthetic-legacy-owner', projectId: legacy.projectId };
    candidate.ownerProof = issueSetupOwnerProof({ ...control, lifecycle: 'awaiting_owner', candidate }, owner, now);
    await initializeInstance(harness.storage.db, control);
    const migrating = await updateInstance(harness.storage.db, instanceId, 0, current => ({ ...current,
      lifecycle: 'awaiting_owner', migration: { sourceDigest: 'a'.repeat(64), mode: 'import', at: now, verificationSummary: [] },
      candidate, nextBundleVersion: 2,
    }), new Date(now.getTime() + 1));

    const legacyCatalog = CatalogSchema.parse(catalogs[0]);
    await harness.storage.db.collection<Catalog>('catalogs').insertOne(legacyCatalog);
    const oauthKey = Buffer.from(await readFile(harness.env.OAUTH_TOKEN_ENCRYPTION_KEY_FILE, 'utf8'), 'base64');
    const legacyAccount = { _id: new ObjectId(), provider: 'zitadel', providerAccountId: owner.subject,
      encryptedTokens: { access_token: encryptOAuthToken('SYNTHETIC_LEGACY_OAUTH_TOKEN', oauthKey) } };
    await harness.storage.db.collection('accounts').insertOne(legacyAccount);
    const legacySession = { _id: new ObjectId(), sessionToken: 'SYNTHETIC_LEGACY_SESSION', userId: 'synthetic-user',
      expires: new Date(now.getTime() + 60 * 60_000) };
    await harness.storage.db.collection('sessions').insertOne(legacySession);

    const before = await loadConfig(harness.env);
    expect(before).toMatchObject({ authUrl: legacy.authUrl, zitadelClientId: legacy.clientId, zitadelSecret: legacy.oidcSecret,
      zitadelIssuer: legacy.issuer, zitadelProjectId: legacy.projectId, zitadelApiAudience: legacy.audience,
      githubAppId: legacy.appId, githubWebhookSecret: legacy.webhookSecret });
    await expect(commitInitialInstance(harness.storage.db, instanceId, migrating.revision, 1, candidate.impact.confirmationNonce, new Date(now.getTime() + 2)))
      .rejects.toThrow('instance_migration_conflict');
    expect((await readInstance(harness.storage.db, instanceId))?.candidate?.version).toBe(1);
    expect(await harness.storage.db.collection<Catalog>('catalogs').findOne({ _id: legacyCatalog._id })).toEqual(legacyCatalog);

    const drained = await updateInstance(harness.storage.db, instanceId, migrating.revision, current => ({ ...current,
      migration: { ...current.migration!, verificationSummary: ['legacy_drained'] },
    }), new Date(now.getTime() + 3));
    const begun = await commitInitialInstance(harness.storage.db, instanceId, drained.revision, 1, candidate.impact.confirmationNonce, new Date(now.getTime() + 4));
    expect(begun).toMatchObject({ lifecycle: 'awaiting_owner', gate: { state: 'closing' }, activation: { phase: 'draining', actor: 'bootstrap' }, active: null });
    expect(await loadConfig(harness.env)).toMatchObject({ authUrl: legacy.authUrl, zitadelSecret: legacy.oidcSecret, githubAppId: legacy.appId });

    expect(await reconcileInitialAdoption(harness.env, process.cwd(), new Date(now.getTime() + 5))).toBe(true);
    const adopted = await readInstance(harness.storage.db, instanceId);
    expect(adopted).toMatchObject({ lifecycle: 'ready', gate: { state: 'open' }, activation: null, initializedAt: expect.any(Date),
      bootstrap: { consumedAt: expect.any(Date) }, active: { version: 1 }, candidate: null });
    expect(JSON.parse(await readFile(harness.env.INSTANCE_STATE_FILE, 'utf8'))).toMatchObject({ instanceId, phase: 'initialized', recoveryEpoch: 1 });
    expect(await loadConfig(harness.env)).toMatchObject({ authUrl: legacy.authUrl, zitadelSecret: legacy.oidcSecret, githubAppId: legacy.appId });
    const migratedCatalog = await harness.storage.db.collection<Catalog>('catalogs').findOne({ _id: legacyCatalog._id });
    expect(migratedCatalog).toMatchObject({ slug: legacyCatalog.slug, configRevision: legacyCatalog.configRevision, published: legacyCatalog.published,
      instanceRuntimeRevision: 1, instanceActivationId: expect.any(String), lease: null, leaseFence: legacyCatalog.leaseFence + 1 });
    const retainedAccount = await harness.storage.db.collection<typeof legacyAccount>('accounts').findOne({ _id: legacyAccount._id });
    expect(retainedAccount).toEqual(legacyAccount);
    expect(decryptOAuthToken(retainedAccount!.encryptedTokens.access_token, oauthKey)).toBe('SYNTHETIC_LEGACY_OAUTH_TOKEN');
    expect(await harness.storage.db.collection('sessions').findOne({ _id: legacySession._id })).toEqual(legacySession);
  } finally { await harness.close(); }
});
