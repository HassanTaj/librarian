import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { ObjectId, type Document } from 'mongodb';
import { expect, it, vi } from 'vitest';
import { encryptOAuthToken } from '../../lib/auth/tokens';
import { CatalogSchema } from '../../lib/catalog';
import { POST as authorizeMigration } from '../../app/api/instance/migration/authorize/route';
import { POST as importLegacyInstance } from '../../app/api/instance/migration/route';
import { legacyInstanceDigest, readInstanceHost } from '../../lib/instance/bootstrap';
import { decryptInstanceSecret } from '../../lib/instance/secrets';
import { ControlReceiptSchema, SyncJobSchema } from '../../lib/sync/jobs';
import { initializeInstance, readInstance, updateInstance, type InstanceControl } from '../../lib/instance/store';
import { instanceControl } from '../fixtures/instance';
import { createStorageHarness } from './http-harness';

const mocks = vi.hoisted(() => ({ requireLegacyEnrollmentAuthority: vi.fn(), readInstanceHost: vi.fn() }));
vi.mock('../../lib/instance/access', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/instance/access')>();
  return { ...actual, requireLegacyEnrollmentAuthority: mocks.requireLegacyEnrollmentAuthority };
});
vi.mock('../../lib/instance/bootstrap', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/instance/bootstrap')>();
  return { ...actual, readInstanceHost: mocks.readInstanceHost };
});

const setupOrigin = 'https://setup.example.test';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function legacyFixture(options: { purpose?: string; expiresAt?: Date; drained?: boolean } = {}) {
  const storage = await createStorageHarness();
  const instanceId = randomUUID();
  const now = new Date();
  const credential = randomBytes(32).toString('base64url');
  const keyring = { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': randomBytes(32) } };
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const config = {
    authSecret: randomBytes(32).toString('base64url'), authUrl: setupOrigin,
    zitadelIssuer: 'https://identity.synthetic.invalid', zitadelClientId: 'synthetic-client',
    zitadelProjectId: 'synthetic-project', zitadelApiAudience: 'synthetic-api', zitadelSecret: 'SYNTHETIC_OIDC_SECRET',
    githubAppId: '12345', githubPrivateKey: privateKey, githubWebhookSecret: 'SYNTHETIC_WEBHOOK_SECRET'.repeat(2),
  } as Parameters<typeof legacyInstanceDigest>[0];
  const expiresAt = options.expiresAt ?? new Date(now.getTime() + 60 * 60_000);
  const host = {
    instanceId, setupOrigin, keyring,
    operator: { purpose: options.purpose ?? 'enroll', expiresAt: expiresAt.toISOString() },
  } as unknown as Awaited<ReturnType<typeof readInstanceHost>>;
  const control = instanceControl(instanceId, now);
  control.bootstrap.verifierHash = digest(credential);
  control.bootstrap.expiresAt = expiresAt;
  await initializeInstance(storage.db, control);
  await updateInstance(storage.db, instanceId, 0, current => ({ ...current, lifecycle: 'legacy_migrating', migration: {
    sourceDigest: legacyInstanceDigest(config), mode: 'import', at: now,
    verificationSummary: options.drained === false ? [] : ['legacy_drained'],
  } }), new Date(now.getTime() + 1));
  mocks.requireLegacyEnrollmentAuthority.mockResolvedValue({ db: storage.db, config, userId: 'synthetic-admin',
    identity: { issuer: config.zitadelIssuer, subject: 'synthetic-owner', projectId: config.zitadelProjectId } });
  mocks.readInstanceHost.mockResolvedValue(host);
  return { storage, instanceId, credential, config, host, identity: { issuer: config.zitadelIssuer, subject: 'synthetic-owner', projectId: config.zitadelProjectId } };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`https://portal.synthetic.invalid${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

it('requires the protected enroll purpose and a drained legacy migration before issuing a setup session', async () => {
  const fixture = await legacyFixture({ purpose: 'bootstrap' });
  try {
    const wrongPurpose = await authorizeMigration(post('/api/instance/migration/authorize', { credential: fixture.credential }));
    expect(wrongPurpose.status).toBe(403);
    expect(await fixture.storage.db.collection('instance_setup_sessions').countDocuments({})).toBe(0);

    fixture.host.operator.purpose = 'enroll';
    fixture.host.operator.expiresAt = new Date(Date.now() - 1000).toISOString();
    mocks.readInstanceHost.mockResolvedValue(fixture.host);
    const expiredOperator = await authorizeMigration(post('/api/instance/migration/authorize', { credential: fixture.credential }));
    expect(expiredOperator.status).toBe(403);

    fixture.host.operator.expiresAt = new Date(Date.now() + 60_000).toISOString();
    mocks.readInstanceHost.mockResolvedValue(fixture.host);
    const unauthorized = await authorizeMigration(post('/api/instance/migration/authorize', { credential: randomBytes(32).toString('base64url') }));
    expect(unauthorized.status).toBe(401);
    const malformed = await authorizeMigration(post('/api/instance/migration/authorize', { credential: 'short' }));
    expect(malformed.status).toBe(400);
    expect(await fixture.storage.db.collection('instance_setup_sessions').countDocuments({})).toBe(0);
  } finally { await fixture.storage.close(); }

  const undrained = await legacyFixture({ drained: false });
  try {
    const response = await authorizeMigration(post('/api/instance/migration/authorize', { credential: undrained.credential }));
    expect(response.status).toBe(401);
    expect(await undrained.storage.db.collection('instance_setup_sessions').countDocuments({})).toBe(0);
  } finally { await undrained.storage.close(); }
});

it('issues one scoped enrollment session, rejects stale import proof, then imports a canonical encrypted draft without changing legacy records', async () => {
  const fixture = await legacyFixture();
  try {
    const now = new Date(); const catalogId = randomUUID(); const generationId = randomUUID();
    const generation = { generationId, commitSha: 'a'.repeat(40), jobId: `manual:${catalogId}:${randomUUID()}`,
      fence: 3, configRevision: 7, manifestDigest: 'b'.repeat(64), publishedAt: now };
    const catalog = CatalogSchema.parse({ _id: catalogId, github: { repositoryId: 12345, installationId: 67890, owner: 'synthetic-owner',
      name: 'existing-docs', branch: 'main', docsPath: 'docs' }, slug: 'existing-docs', title: 'Existing docs', publicDescription: '',
      visibility: 'private', readerRole: 'docs:private:reader', enabled: true, approvalRef: null, accessState: 'ready', configRevision: 7,
      authEpoch: 1, instanceRuntimeRevision: null, instanceActivationId: null, published: generation,
      publicationRevision: 3, retained: [{ ...generation, generationId: randomUUID(), retiredAt: now }],
      lease: { owner: randomUUID(), fence: 3, expiresAt: new Date(now.getTime() + 60_000), heartbeatAt: now }, leaseFence: 3,
      readPins: [{ requestId: randomUUID(), generationId, expiresAt: new Date(now.getTime() + 30_000) }], admissionReservations: 0,
      rateWindow: { window: now, count: 1 }, lastSuccess: { at: now, jobId: generation.jobId, commitSha: generation.commitSha },
      lastFailure: null, createdAt: now, updatedAt: now });
    const jobId = `manual:${catalogId}:${randomUUID()}`;
    const job = SyncJobSchema.parse({ _id: jobId, catalogId, configRevision: 7, origin: 'manual', event: 'manual', payloadDigest: 'c'.repeat(64),
      admissionSequence: 4, state: 'running', requestedAt: now, availableAt: now, attempts: 1, owner: randomUUID(), fence: 4,
      targetCommit: null, generationId: null, result: null, completedAt: null, detailExpiresAt: null });
    const controlReceipt = ControlReceiptSchema.parse({ _id: `github:12345:${randomUUID()}:${catalogId}`, catalogId, installationId: 67890,
      repositoryId: 12345, event: 'installation_repositories', action: 'removed', payloadDigest: 'd'.repeat(64), completedAt: now });
    const userId = new ObjectId();
    const ownerIdentity = { issuer: fixture.config.zitadelIssuer, subject: 'legacy-owner', projectId: fixture.config.zitadelProjectId };
    const grantId = digest(`${ownerIdentity.issuer}\0${ownerIdentity.subject}\0${ownerIdentity.projectId}`);
    const legacyRecords: Array<{ collection: string; document: Document }> = [
      { collection: 'accounts', document: { _id: new ObjectId(), userId, provider: 'zitadel', type: 'oidc', providerAccountId: ownerIdentity.subject,
        issuer: ownerIdentity.issuer, encryptedTokens: { access_token: encryptOAuthToken('SYNTHETIC_LEGACY_ACCESS_TOKEN', randomBytes(32)) }, tokenVersion: 3, refreshFence: 2 } },
      { collection: 'sessions', document: { _id: new ObjectId(), sessionToken: 'SYNTHETIC_LEGACY_SESSION', userId,
        expires: new Date(now.getTime() + 60 * 60_000), absoluteExpiresAt: new Date(now.getTime() + 24 * 60 * 60_000) } },
      { collection: 'identity_authorizations', document: { _id: grantId, ...ownerIdentity, roles: ['librarian-admin', 'docs:private:reader'], verifiedAt: now, leaseFence: 4, lease: null } },
      { collection: 'catalogs', document: catalog as Document },
      { collection: 'syncJobs', document: job as Document },
      { collection: 'controlReceipts', document: controlReceipt as Document },
      { collection: 'instance_setup_webhook_receipts', document: { _id: digest('legacy-webhook-receipt'), instanceId: fixture.instanceId,
        candidateVersion: 1, payloadDigest: 'e'.repeat(64), event: 'ping', expiresAt: new Date(now.getTime() + 60 * 60_000) } },
      { collection: 'instance_audit_events', document: { _id: randomUUID(), instanceId: fixture.instanceId, at: now, actor: 'legacy-admin',
        operation: 'activated', fromVersion: 1, toVersion: 2, resultCode: 'accepted', requestId: randomUUID() } },
      { collection: 'syncWorkerStatus', document: { _id: 'legacy-worker', owner: randomUUID(), enabled: true, healthy: true,
        active: false, updatedAt: now } },
    ];
    for (const { collection, document } of legacyRecords) await fixture.storage.db.collection<Document>(collection).insertOne(document);

    const authorization = await authorizeMigration(post('/api/instance/migration/authorize', { credential: fixture.credential }));
    expect(authorization.status).toBe(200);
    expect(authorization.headers.get('cache-control')).toBe('private, no-store');
    const authorizationBody = await authorization.json() as { csrfToken: string; confirmationNonce: string; editRevision: number };
    const cookies = authorization.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('__Host-librarian_setup=');
    expect(cookies).toContain('__Host-librarian_setup_csrf=');
    expect(cookies).toContain('HttpOnly');
    const sessionToken = cookies.match(/__Host-librarian_setup=([^;,]+)/)?.[1];
    expect(sessionToken).toBeTruthy();
    const sessionRecord = await fixture.storage.db.collection('instance_setup_sessions').findOne({ instanceId: fixture.instanceId });
    expect(sessionRecord?.purpose).toBe('legacy_enrollment');
    expect(sessionRecord?.lastNonceHash).toBe(digest(authorizationBody.confirmationNonce));
    expect(authorizationBody.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cookie = `__Host-librarian_setup=${sessionToken}`;
    const importRequest = (confirmationNonce: string, etag = authorization.headers.get('etag') ?? '') => post('/api/instance/migration', {
      confirmImport: true, confirmationNonce,
    }, { cookie, 'if-match': etag });
    const wrongNonce = await importLegacyInstance(importRequest(randomUUID()));
    expect(wrongNonce.status).toBe(409);
    const staleRevision = await importLegacyInstance(importRequest(authorizationBody.confirmationNonce, '"999"'));
    expect(staleRevision.status).toBe(409);

    fixture.config.githubAppId = '54321';
    const changedSource = await importLegacyInstance(importRequest(authorizationBody.confirmationNonce));
    expect(changedSource.status).toBe(409);
    fixture.config.githubAppId = '12345';

    const imported = await importLegacyInstance(importRequest(authorizationBody.confirmationNonce));
    expect(imported.status).toBe(200);
    expect(imported.headers.get('cache-control')).toBe('private, no-store');
    expect(imported.headers.get('etag')).toBe(`"${authorizationBody.editRevision + 1}"`);
    const body = await imported.json() as { state: string; activeVersion: number | null; candidateVersion: number; nextUrl: string };
    expect(body).toMatchObject({ state: 'awaiting_owner', activeVersion: null, candidateVersion: 1, nextUrl: '/instance/setup' });
    expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC_(?:OIDC|WEBHOOK|LEGACY)_/);

    const control = await readInstance(fixture.storage.db, fixture.instanceId) as InstanceControl;
    expect(control).toMatchObject({ lifecycle: 'awaiting_owner', initializedAt: null, active: null,
      migration: { mode: 'import', sourceDigest: legacyInstanceDigest(fixture.config) } });
    expect(control.candidate?.ownerProof).toMatchObject(fixture.identity);
    expect(control.candidate?.checks).toContainEqual(expect.objectContaining({ type: 'zitadel_owner_login', status: 'passed', code: 'provider_ok' }));
    const secrets = control.candidate!.secrets;
    expect(JSON.stringify(secrets)).not.toContain(fixture.config.zitadelSecret);
    expect(decryptInstanceSecret(secrets.zitadelClientSecret!, { instanceId: fixture.instanceId, purpose: 'zitadelClientSecret',
      credentialVersion: secrets.zitadelClientSecret!.credentialVersion }, fixture.host.keyring)).toBe(fixture.config.zitadelSecret);
    for (const { collection, document } of legacyRecords) {
      expect(await fixture.storage.db.collection<Document>(collection).findOne({ _id: document._id })).toEqual(document);
    }
    expect(control.candidate?.zitadel.issuer).toBe(fixture.config.zitadelIssuer);
    expect(control.candidate?.github.appId).toBe(fixture.config.githubAppId);
  } finally { await fixture.storage.close(); }
});

it('rejects malformed confirmation and missing session cookies without importing data', async () => {
  const fixture = await legacyFixture();
  try {
    const malformed = await importLegacyInstance(post('/api/instance/migration', '{'));
    expect(malformed.status).toBe(400);
    const invalidShape = await importLegacyInstance(post('/api/instance/migration', { confirmImport: false, confirmationNonce: randomUUID() }));
    expect(invalidShape.status).toBe(400);
    const missingCookie = await importLegacyInstance(post('/api/instance/migration', { confirmImport: true, confirmationNonce: randomUUID() }));
    expect(missingCookie.status).toBe(401);
    expect((await readInstance(fixture.storage.db, fixture.instanceId))?.candidate).toBeNull();
  } finally { await fixture.storage.close(); }
});
