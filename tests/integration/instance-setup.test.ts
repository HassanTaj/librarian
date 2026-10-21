import { loadHostConfig, instanceRuntimeInputs } from '../../lib/config';
import { expect, it } from 'vitest';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStorageHarness, insertInstanceControl, startNextHarness } from './http-harness';
import { createInstanceHarness } from './instance-harness';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { catalogs } from '../fixtures/catalogs';
import { attachInstanceKeyring, initializeInstance, InstanceControlSchema, StoredInstanceControlSchema, readInstance, serializeInstanceControl, updateInstance, type StoredInstanceControl } from '../../lib/instance/store';
import { issueBootstrapCredential, readInstanceHost, readInstanceSetupStatus } from '../../lib/instance/bootstrap';
import { commitInitialInstance } from '../../lib/instance/activation';
import { authorizeInstanceSetup, readInstanceSetupSession, type InstanceSetupSession } from '../../lib/instance/access';
import { encryptInstanceSecret } from '../../lib/instance/secrets';

const setupOrigin = 'https://setup.example.test';
const setupAppKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

async function createSetupApiFixture(port: number, withCandidate = false) {
  const fixture = await createInstanceHarness({ port });
  try {
    fixture.env.INSTANCE_SETUP_ORIGIN = setupOrigin;
    fixture.env.INSTANCE_OUTBOUND_POLICY_FILE = '';
    const operator = JSON.parse(await readFile(fixture.env.INSTANCE_OPERATOR_AUTH_FILE!, 'utf8')) as { credential: string; expiresAt: string };
    const now = new Date();
    const control = instanceControl(fixture.instanceId, now);
    control.bootstrap.verifierHash = createHash('sha256').update(operator.credential).digest('hex');
    control.bootstrap.expiresAt = new Date(operator.expiresAt);
    await initializeInstance(fixture.storage.db, control);

    if (withCandidate) {
      const key = Buffer.alloc(32, 7);
      const keyring = { activeKeyId: 'setup-test-key', keys: { 'setup-test-key': key } };
      await writeFile(fixture.env.INSTANCE_KEYRING_FILE!, JSON.stringify({ activeKeyId: keyring.activeKeyId,
        keys: { 'setup-test-key': key.toString('base64') } }));
      attachInstanceKeyring(fixture.storage.db, keyring);
      const ready = readyInstance(fixture.instanceId, now);
      const candidate = structuredClone(ready.active);
      if (!candidate) throw new Error('Synthetic candidate unavailable');
      candidate.runtime = instanceRuntimeInputs(await loadHostConfig(fixture.env), fixture.env);
      candidate.createdBy = 'synthetic-operator';
      candidate.publicOrigin = setupOrigin;
      candidate.secrets = {
        zitadelClientSecret: encryptInstanceSecret('CLIENT_SECRET_SENTINEL', { instanceId: fixture.instanceId, purpose: 'zitadelClientSecret', credentialVersion: randomUUID() }, keyring, now),
        githubPrivateKey: encryptInstanceSecret(setupAppKey, { instanceId: fixture.instanceId, purpose: 'githubPrivateKey', credentialVersion: randomUUID() }, keyring, now),
        githubWebhookSecret: encryptInstanceSecret('WEBHOOK_SECRET_SENTINEL', { instanceId: fixture.instanceId, purpose: 'githubWebhookSecret', credentialVersion: randomUUID() }, keyring, now),
        previousWebhook: null,
      };
      candidate.ownerProof = { instanceId: fixture.instanceId, candidateVersion: candidate.version, issuer: candidate.zitadel.issuer,
        subject: 'synthetic-owner', projectId: candidate.zitadel.projectId, securityEpoch: control.securityEpoch, nonce: randomUUID(),
        expiresAt: new Date(now.getTime() + 10 * 60_000) };
      candidate.checks = [
        { type: 'database', candidateVersion: candidate.version, at: now, status: 'passed', code: 'database_ok' },
        { type: 'zitadel_discovery', candidateVersion: candidate.version, at: now, status: 'passed', code: 'provider_ok' },
        { type: 'zitadel_owner_login', candidateVersion: candidate.version, at: now, status: 'passed', code: 'provider_ok' },
        { type: 'github_structure', candidateVersion: candidate.version, at: now, status: 'passed', code: 'provider_ok' },
        { type: 'github_authentication', candidateVersion: candidate.version, at: now, status: 'passed', code: 'provider_ok' },
        { type: 'github_permissions', candidateVersion: candidate.version, at: now, status: 'passed', code: 'provider_ok' },
        { type: 'github_installation', candidateVersion: candidate.version, at: now, status: 'warning', code: 'installation_missing' },
        { type: 'github_webhook', candidateVersion: candidate.version, at: now, status: 'warning', code: 'delivery_unverified' },
      ];
      candidate.impact = { categories: ['preferences'], securityEpochIncrement: false, revalidateSources: false, confirmationNonce: randomUUID() };
      await updateInstance(fixture.storage.db, fixture.instanceId, 0, current => ({ ...current, lifecycle: 'awaiting_owner', candidate, nextBundleVersion: candidate.version + 1 }), new Date(now.getTime() + 1));
      const owner = { issuer: candidate.zitadel.issuer, subject: 'synthetic-owner', projectId: candidate.zitadel.projectId };
      await fixture.storage.db.collection<{ _id: string; issuer: string; subject: string; projectId: string; roles: string[]; verifiedAt: Date; leaseFence: number; lease: null }>('identity_authorizations').insertOne({
        _id: createHash('sha256').update(`${owner.issuer}\0${owner.subject}\0${owner.projectId}`).digest('hex'),
        ...owner, roles: ['librarian-instance-admin'], verifiedAt: now, leaseFence: 0, lease: null });
    }

    await writeFile(fixture.env.INSTANCE_STATE_FILE!, JSON.stringify({ instanceId: fixture.instanceId, phase: 'sealed', recoveryEpoch: 1 }));
    const server = await fixture.start();
    const status = await fetch(`${server.origin}/api/instance/status`);
    if (status.status !== 200) throw new Error('Setup API status fixture failed');
    const preSessionCookie = status.headers.get('set-cookie')?.split(';', 1)[0];
    if (!preSessionCookie) throw new Error('Setup API CSRF fixture cookie missing');
    const preSessionCsrf = preSessionCookie.split('=', 2)[1];
    const authorized = await fetch(`${server.origin}/api/instance/setup/authorize`, { method: 'POST', headers: {
      'content-type': 'application/json', origin: setupOrigin, cookie: preSessionCookie, 'x-csrf-token': preSessionCsrf,
    }, body: JSON.stringify({ credential: operator.credential }) });
    if (authorized.status !== 200) {
      const failure = await authorized.json().catch(() => null) as { error?: { code?: string } } | null;
      throw new Error(`Setup API session fixture failed: ${failure?.error?.code ?? authorized.status}`);
    }
    const sessionCookie = authorized.headers.get('set-cookie')?.match(/(?:^|,\s*)(__Host-librarian_setup=[^;,]+)/)?.[1];
    if (!sessionCookie) throw new Error('Setup API session cookie missing');
    const session = await authorized.json() as { csrfToken: string };
    return {
      fixture, server, setupCookie: sessionCookie, csrf: session.csrfToken,
      headers: (extra: Record<string, string> = {}) => ({ origin: setupOrigin, cookie: sessionCookie, 'x-csrf-token': session.csrfToken, ...extra }),
      async close() { await fixture.close(); },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

it('atomically caps durable setup sessions at eight and rejects them at exact expiry', async () => {
  const storage = await createStorageHarness();
  try {
    const control = instanceControl();
    const now = control.createdAt;
    const credential = issueBootstrapCredential(control.instanceId, control.bootstrap.epoch, now);
    control.bootstrap.verifierHash = credential.verifierHash;
    control.bootstrap.expiresAt = credential.expiresAt;
    await initializeInstance(storage.db, control);

    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => authorizeInstanceSetup(storage.db, control.instanceId, credential.credential, now)));
    const accepted = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof authorizeInstanceSetup>>> => result.status === 'fulfilled');
    const rejected = attempts.filter(result => result.status === 'rejected');
    expect(accepted).toHaveLength(8);
    expect(rejected).toHaveLength(2);
    expect(rejected.every(result => result.reason instanceof Error && result.reason.message === 'instance_rate_limited')).toBe(true);

    const sessions = storage.db.collection<InstanceSetupSession>('instance_setup_sessions');
    expect(await sessions.countDocuments({ instanceId: control.instanceId })).toBe(8);
    const first = accepted[0].value;
    const session = await readInstanceSetupSession(storage.db, control.instanceId, first.token, first.csrfToken, now);
    expect(session).toMatchObject({ instanceId: control.instanceId, setupEpoch: control.bootstrap.epoch, recoveryEpoch: control.recoveryEpoch,
      expiresAt: new Date(now.getTime() + 30 * 60_000), purgeAt: new Date(now.getTime() + 90 * 60_000) });
    expect(JSON.stringify(await sessions.findOne({ _id: createHash('sha256').update(first.token).digest('hex') }))).not.toContain(first.token);
    await expect(readInstanceSetupSession(storage.db, control.instanceId, first.token, first.csrfToken, session.expiresAt)).rejects.toThrow('instance_setup_unauthorized');
    expect(await sessions.listIndexes().toArray()).toContainEqual(expect.objectContaining({ key: { instanceId: 1, expiresAt: 1 } }));
    expect(await sessions.listIndexes().toArray()).toContainEqual(expect.objectContaining({ key: { purgeAt: 1 }, expireAfterSeconds: 0 }));
  } finally { await storage.close(); }
});

it('applies the durable failed-bootstrap quota across guesses without creating sessions', async () => {
  const storage = await createStorageHarness();
  try {
    const control = instanceControl();
    const now = control.createdAt;
    const credential = issueBootstrapCredential(control.instanceId, control.bootstrap.epoch, now);
    control.bootstrap.verifierHash = credential.verifierHash;
    control.bootstrap.expiresAt = credential.expiresAt;
    await initializeInstance(storage.db, control);
    for (let attempt = 0; attempt < 5; attempt++) await expect(authorizeInstanceSetup(storage.db, control.instanceId, 'wrong-credential', now)).rejects.toThrow('instance_setup_unauthorized');
    await expect(authorizeInstanceSetup(storage.db, control.instanceId, 'wrong-credential', now)).rejects.toThrow('instance_rate_limited');
    expect(await storage.db.collection('instance_setup_sessions').countDocuments()).toBe(0);
  } finally { await storage.close(); }
});

it('rejects missing, expired, malformed and closed setup authorities with fixed errors', async () => {
  const storage = await createStorageHarness();
  try {
    const instanceId = instanceControl().instanceId;
    await expect(authorizeInstanceSetup(storage.db, instanceId, 'untrusted')).rejects.toThrow('instance_setup_unauthorized');
    await expect(readInstanceSetupSession(storage.db, instanceId, 'malformed')).rejects.toThrow('instance_setup_unauthorized');

    const control = instanceControl();
    const now = control.createdAt;
    const credential = issueBootstrapCredential(control.instanceId, control.bootstrap.epoch, now);
    control.bootstrap.verifierHash = credential.verifierHash;
    control.bootstrap.expiresAt = new Date(now.getTime() + 10 * 60_000);
    await initializeInstance(storage.db, control);
    const authorized = await authorizeInstanceSetup(storage.db, control.instanceId, credential.credential, now);
    expect(authorized.expiresAt).toEqual(control.bootstrap.expiresAt);
    await expect(readInstanceSetupSession(storage.db, control.instanceId, authorized.token, 'wrong-csrf', now)).rejects.toThrow('instance_csrf');
    await expect(readInstanceSetupSession(storage.db, control.instanceId, authorized.token, authorized.csrfToken, authorized.expiresAt)).rejects.toThrow('instance_setup_unauthorized');
  } finally { await storage.close(); }

  const ready = await createStorageHarness();
  try {
    const control = readyInstance();
    await insertInstanceControl(ready.db, control);
    await expect(authorizeInstanceSetup(ready.db, control.instanceId, 'untrusted')).rejects.toThrow('instance_setup_closed');
  } finally { await ready.close(); }
});

it('reports only generic fresh-instance status without requiring a provider or exposing host authority', async () => {
  const fixture = await createInstanceHarness({ port: 3195 });
  try {
    fixture.env.INSTANCE_SETUP_ORIGIN = 'https://setup.example.test';
    fixture.env.INSTANCE_OUTBOUND_POLICY_FILE = '';
    expect(await readInstanceSetupStatus({ ...fixture.env, NODE_ENV: 'production' })).toMatchObject({
      state: 'setup_required', prerequisitesAvailable: true, namespaceAvailable: true,
    });
    const server = await fixture.start();
    expect(await fixture.storage.db.listCollections({ name: 'quotas' }).toArray()).toHaveLength(0);
    const response = await fetch(`${server.origin}/api/instance/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ version: expect.any(String), state: 'setup_required', prerequisitesAvailable: true });
    expect(JSON.stringify(body)).not.toContain(fixture.instanceId);
    expect(JSON.stringify(body)).not.toContain('credential');
    expect(Object.keys(body).sort()).toEqual(['prerequisitesAvailable', 'state', 'version']);
    expect(await fixture.storage.db.listCollections({ name: 'quotas' }).toArray()).toHaveLength(0);

    const setupPage = await fetch(`${server.origin}/instance/setup`);
    expect(setupPage.status).toBe(200);
    expect(await setupPage.text()).toContain('Bootstrap credential');

    await writeFile(fixture.env.MONGODB_URI_FILE!, 'invalid-mongo-uri');
    const unavailable = await fetch(`${server.origin}/api/instance/status`);
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toEqual({ version: '2', state: 'maintenance', prerequisitesAvailable: false });
    const unavailablePage = await fetch(`${server.origin}/instance/setup`);
    expect(unavailablePage.status).toBe(200);
    const unavailableHtml = await unavailablePage.text();
    expect(unavailableHtml).toContain('Setup is unavailable');
    expect(unavailableHtml).not.toContain('Bootstrap credential');
  } finally { await fixture.close(); }
});

it('blocks setup namespace readiness when a legacy catalog already owns the instance slug', async () => {
  const fixture = await createInstanceHarness({ port: 3197 });
  try {
    fixture.env.INSTANCE_SETUP_ORIGIN = 'https://setup.example.test';
    await fixture.storage.db.collection<{ _id: string; slug: string; readerRole: string }>('catalogs')
      .insertOne({ ...catalogs[0], slug: 'instance', readerRole: 'docs:instance:reader' });
    expect(await readInstanceSetupStatus(fixture.env)).toMatchObject({ state: 'maintenance', prerequisitesAvailable: true });
    const server = await fixture.start();
    const response = await fetch(`${server.origin}/api/instance/status`);
    expect(await response.json()).toEqual({ version: '2', state: 'maintenance', prerequisitesAvailable: true });
  } finally { await fixture.close(); }
});

it('requires trusted-origin pre-session CSRF and returns only a hashed setup session authority', async () => {
  const fixture = await createInstanceHarness({ port: 3196 });
  try {
    const setupOrigin = 'https://setup.example.test';
    fixture.env.INSTANCE_SETUP_ORIGIN = setupOrigin;
    fixture.env.INSTANCE_OUTBOUND_POLICY_FILE = '';
    const operator = JSON.parse(await readFile(fixture.env.INSTANCE_OPERATOR_AUTH_FILE!, 'utf8')) as { credential: string; expiresAt: string };
    const control = instanceControl(fixture.instanceId);
    control.bootstrap.verifierHash = createHash('sha256').update(operator.credential).digest('hex');
    control.bootstrap.expiresAt = new Date(operator.expiresAt);
    await initializeInstance(fixture.storage.db, control);
    await writeFile(fixture.env.INSTANCE_STATE_FILE!, JSON.stringify({ instanceId: fixture.instanceId, phase: 'sealed', recoveryEpoch: 1 }));

    const server = await fixture.start();
    const status = await fetch(`${server.origin}/api/instance/status`);
    const cookie = status.headers.get('set-cookie')!.split(';', 1)[0];
    const csrf = cookie.split('=', 2)[1];
    const body = JSON.stringify({ credential: operator.credential });
    const forbidden = await fetch(`${server.origin}/api/instance/setup/authorize`, { method: 'POST', headers: {
      'content-type': 'application/json', origin: 'https://attacker.example.test', cookie, 'x-csrf-token': csrf,
    }, body });
    expect(forbidden.status).toBe(403);
    expect(await fixture.storage.db.collection('instance_setup_sessions').countDocuments()).toBe(0);

    const response = await fetch(`${server.origin}/api/instance/setup/authorize`, { method: 'POST', headers: {
      'content-type': 'application/json', origin: setupOrigin, cookie, 'x-csrf-token': csrf,
    }, body });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ expiresAt: expect.any(String), csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(JSON.stringify(result)).not.toContain(operator.credential);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(await fixture.storage.db.collection('instance_setup_sessions').countDocuments({ instanceId: fixture.instanceId })).toBe(1);
  } finally { await fixture.close(); }
});

it('shares the bootstrap guessing quota across separate Next processes', async () => {
  const fixture = await createInstanceHarness({ port: 3198 });
  let second: Awaited<ReturnType<typeof startNextHarness>> | undefined;
  try {
    fixture.env.INSTANCE_SETUP_ORIGIN = 'https://setup.example.test';
    fixture.env.INSTANCE_OUTBOUND_POLICY_FILE = '';
    const operator = JSON.parse(await readFile(fixture.env.INSTANCE_OPERATOR_AUTH_FILE!, 'utf8')) as { credential: string; expiresAt: string };
    const control = instanceControl(fixture.instanceId);
    control.bootstrap.verifierHash = createHash('sha256').update(operator.credential).digest('hex');
    control.bootstrap.expiresAt = new Date(operator.expiresAt);
    await initializeInstance(fixture.storage.db, control);
    await writeFile(fixture.env.INSTANCE_STATE_FILE!, JSON.stringify({ instanceId: fixture.instanceId, phase: 'sealed', recoveryEpoch: 1 }));

    const first = await fixture.start();
    second = await startNextHarness({ appRoot: process.cwd(), port: 3199, env: fixture.env });
    const csrf = async (origin: string) => {
      const response = await fetch(`${origin}/api/instance/status`);
      const cookie = response.headers.get('set-cookie')!.split(';', 1)[0];
      return { cookie, token: cookie.split('=', 2)[1] };
    };
    const firstCsrf = await csrf(first.origin);
    const secondCsrf = await csrf(second.origin);
    const attempt = (origin: string, authority: { cookie: string; token: string }) => fetch(`${origin}/api/instance/setup/authorize`, {
      method: 'POST', headers: {
        'content-type': 'application/json', origin: 'https://setup.example.test', cookie: authority.cookie, 'x-csrf-token': authority.token,
      }, body: JSON.stringify({ credential: 'x'.repeat(43) }),
    });
    for (let index = 0; index < 3; index++) expect((await attempt(first.origin, firstCsrf)).status).toBe(401);
    for (let index = 0; index < 2; index++) expect((await attempt(second.origin, secondCsrf)).status).toBe(401);
    expect((await attempt(first.origin, firstCsrf)).status).toBe(429);
    expect(await fixture.storage.db.collection('instance_setup_sessions').countDocuments()).toBe(0);
  } finally {
    await second?.close();
    await fixture.close();
  }
});

it('seals protected host authority before initializing one empty loopback instance', async () => {
  const storage = await createStorageHarness();
  try {
    const hostRoot = join(storage.root, 'instance');
    const prereqRoot = join(storage.root, 'prerequisites');
    await Promise.all([mkdir(hostRoot, { mode: 0o700 }), mkdir(prereqRoot, { mode: 0o700 })]);
    const absoluteHostRoot = await realpath(hostRoot);
    const files = {
      mongo: join(prereqRoot, 'mongo.uri'),
      auth: join(prereqRoot, 'auth.key'),
      oauth: join(prereqRoot, 'oauth.key'),
      marker: join(absoluteHostRoot, 'instance-state.json'),
      keyring: join(absoluteHostRoot, 'instance-keyring.json'),
      operator: join(absoluteHostRoot, 'instance-operator-auth.json'),
    };
    const authSecret = randomBytes(32).toString('base64url');
    const oauthSecret = randomBytes(32).toString('base64');
    await Promise.all([
      writeFile(files.mongo, 'mongodb://127.0.0.1:27018/', { mode: 0o600 }),
      writeFile(files.auth, authSecret, { mode: 0o600 }),
      writeFile(files.oauth, oauthSecret, { mode: 0o600 }),
    ]);
    const env = {
      ...process.env, NODE_ENV: 'test' as const, AUTH_TRUST_HOST: 'true',
      CONTENT_ROOT: storage.contentRoot, MONGODB_DATABASE: storage.db.databaseName,
      MONGODB_URI_FILE: files.mongo, AUTH_SECRET_FILE: files.auth, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: files.oauth,
    };
    const coverage = process.env.LIBRARIAN_COVERAGE_PROCESS_DIR
      ? [`--import=${pathToFileURL(resolve('tests/integration/native-coverage-register.mjs')).href}`] : [];
    const result = execFileSync(process.execPath, [...coverage, resolve('scripts/instance-operator.mjs'), 'prepare', '--root', absoluteHostRoot, '--origin', 'http://127.0.0.1:3197'], {
      cwd: process.cwd(), env, encoding: 'utf8', windowsHide: true,
    });
    expect(JSON.parse(result)).toEqual({ actionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });

    const marker = JSON.parse(await readFile(files.marker, 'utf8')) as { instanceId: string; phase: string; recoveryEpoch: number };
    const operator = JSON.parse(await readFile(files.operator, 'utf8')) as { instanceId: string; purpose: string; epoch: number; credential: string; expiresAt: string };
    const runtimeEnv = await readFile(join(absoluteHostRoot, 'instance.env'), 'utf8');
    const record = StoredInstanceControlSchema.parse(await storage.db.collection<StoredInstanceControl>('instance_configuration').findOne({ _id: 'instance' }));
    expect(marker).toMatchObject({ instanceId: record.instanceId, phase: 'sealed', recoveryEpoch: record.recoveryEpoch });
    expect(operator).toMatchObject({ instanceId: record.instanceId, purpose: 'bootstrap', epoch: record.bootstrap.epoch, expiresAt: record.bootstrap.expiresAt.toISOString() });
    expect(record).toMatchObject({ lifecycle: 'configuring', revision: 0, editRevision: 0, initializedAt: null,
      bootstrap: { verifierHash: createHash('sha256').update(operator.credential).digest('hex'), consumedAt: null },
      active: null, candidate: null, previous: null, administrators: [] });
    expect(record.bootstrap.expiresAt.getTime() - record.createdAt.getTime()).toBe(24 * 60 * 60_000);
    expect(runtimeEnv).toContain(`INSTANCE_ID=${JSON.stringify(marker.instanceId)}`);
    expect(runtimeEnv).toContain('INSTANCE_SETUP_ORIGIN="http://127.0.0.1:3197"');
    expect(runtimeEnv).toContain(`INSTANCE_STATE_FILE=${JSON.stringify(files.marker)}`);
    expect(runtimeEnv).toContain(`INSTANCE_KEYRING_FILE=${JSON.stringify(files.keyring)}`);
    expect(runtimeEnv).toContain(`INSTANCE_OPERATOR_AUTH_FILE=${JSON.stringify(files.operator)}`);
    expect(runtimeEnv).not.toContain(operator.credential);
    expect(runtimeEnv).not.toContain(authSecret);
    expect(runtimeEnv).not.toContain(oauthSecret);
    const keys = Object.values((JSON.parse(await readFile(files.keyring, 'utf8')) as { keys: Record<string, string> }).keys);
    expect(keys).not.toContain(authSecret);
    expect(keys).not.toContain(oauthSecret);
    expect(result).not.toContain(operator.credential);

    const host = await readInstanceHost({ ...env, INSTANCE_ID: marker.instanceId, INSTANCE_SETUP_ORIGIN: 'http://127.0.0.1:3197',
      INSTANCE_STATE_FILE: files.marker, INSTANCE_KEYRING_FILE: files.keyring, INSTANCE_OPERATOR_AUTH_FILE: files.operator });
    expect(host.instanceId).toBe(marker.instanceId);
  } finally { await storage.close(); }
});

it('keeps an interrupted sealed creation in maintenance and refuses fresh authorization', async () => {
  const fixture = await createInstanceHarness({ port: 3200 });
  try {
    fixture.env.INSTANCE_SETUP_ORIGIN = setupOrigin;
    fixture.env.INSTANCE_OUTBOUND_POLICY_FILE = '';
    const operator = JSON.parse(await readFile(fixture.env.INSTANCE_OPERATOR_AUTH_FILE!, 'utf8')) as { credential: string };
    await writeFile(fixture.env.INSTANCE_STATE_FILE!, JSON.stringify({ instanceId: fixture.instanceId, phase: 'sealed', recoveryEpoch: 1 }));
    const server = await fixture.start();
    const status = await fetch(`${server.origin}/api/instance/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ version: '2', state: 'maintenance', prerequisitesAvailable: true });
    const preSessionCookie = status.headers.get('set-cookie')!.split(';', 1)[0];
    const denied = await fetch(`${server.origin}/api/instance/setup/authorize`, { method: 'POST', headers: {
      'content-type': 'application/json', origin: setupOrigin, cookie: preSessionCookie,
      'x-csrf-token': preSessionCookie.split('=', 2)[1],
    }, body: JSON.stringify({ credential: operator.credential }) });
    expect(denied.status).toBe(401);
    expect(await fixture.storage.db.collection('instance_configuration').countDocuments()).toBe(0);
    expect(await fixture.storage.db.collection('instance_setup_sessions').countDocuments()).toBe(0);
  } finally { await fixture.close(); }
});

it('protects setup reads, rejects stale If-Match, and clears proof and passed checks after an edit', async () => {
  const api = await createSetupApiFixture(3201, true);
  try {
    const anonymous = await fetch(`${api.server.origin}/api/instance/setup`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: { code: 'setup_unauthorized' } });

    const read = await fetch(`${api.server.origin}/api/instance/setup`, { headers: { cookie: api.setupCookie } });
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toContain('no-store');
    expect(read.headers.get('etag')).toBeTruthy();
    const snapshot = await read.json();
    expect(snapshot).toMatchObject({ editRevision: 1, candidateVersion: 1, expiresAt: expect.any(String), checks: expect.any(Array) });
    expect(JSON.stringify(snapshot)).not.toContain('CLIENT_SECRET_SENTINEL');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_KEY_SENTINEL');
    expect(JSON.stringify(snapshot)).not.toContain('WEBHOOK_SECRET_SENTINEL');

    const patch = (ifMatch: string, displayName: string) => fetch(`${api.server.origin}/api/instance/setup`, { method: 'PATCH', headers: api.headers({
      'content-type': 'application/json', 'if-match': ifMatch,
    }), body: JSON.stringify({ candidateVersion: 1, changes: { displayName } }) });
    const stale = await patch('"stale"', 'Must not be applied');
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'revision_conflict' } });
    const unchanged = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    expect(unchanged?.candidate).toMatchObject({ version: 1, preferences: { displayName: 'Synthetic' }, ownerProof: { subject: 'synthetic-owner' } });
    expect(unchanged?.candidate?.checks.some(check => check.status === 'passed')).toBe(true);

    const accepted = await patch(read.headers.get('etag')!, 'Revised docs');
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toContain('no-store');
    const edited = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    expect(edited?.candidate).toMatchObject({ version: 2, preferences: { displayName: 'Revised docs' }, ownerProof: null });
    expect(edited?.candidate?.checks.some(check => check.status === 'passed')).toBe(false);
    expect(JSON.stringify(await accepted.json())).not.toContain('SECRET_SENTINEL');
  } finally { await api.close(); }
});

it('saves a partial first-run candidate durably before provider credentials are entered', async () => {
  const api = await createSetupApiFixture(3205);
  try {
    const initial = await fetch(`${api.server.origin}/api/instance/setup`, { headers: { cookie: api.setupCookie } });
    expect(initial.status).toBe(200);
    const draft = await initial.json();
    expect(draft).toMatchObject({ editRevision: 0, candidateVersion: 0, candidate: { secrets: {
      zitadelClientSecret: { configured: false, updatedAt: null }, githubPrivateKey: { configured: false, updatedAt: null }, githubWebhookSecret: { configured: false, updatedAt: null },
    } } });

    const saved = await fetch(`${api.server.origin}/api/instance/setup`, { method: 'PATCH', headers: api.headers({
      'content-type': 'application/json', 'if-match': initial.headers.get('etag')!,
    }), body: JSON.stringify({ candidateVersion: 0, changes: { displayName: 'Durable partial setup' } }) });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const result = await saved.json();
    expect(result).toMatchObject({ editRevision: 1, candidateVersion: 1, candidate: { preferences: { displayName: 'Durable partial setup' }, secrets: {
      zitadelClientSecret: { configured: false }, githubPrivateKey: { configured: false }, githubWebhookSecret: { configured: false },
    } } });
    const persisted = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    expect(persisted?.candidate?.secrets).toMatchObject({ zitadelClientSecret: null, githubPrivateKey: null, githubWebhookSecret: null });
  } finally { await api.close(); }
});

it('validates setup edits, encrypts every replacement and returns only safe candidate metadata', async () => {
  const api = await createSetupApiFixture(3209);
  try {
    const initial = await fetch(`${api.server.origin}/api/instance/setup`, { headers: { cookie: api.setupCookie } });
    const headers = api.headers({ 'content-type': 'application/json', 'if-match': initial.headers.get('etag')! });
    const wrongOrigin = await fetch(`${api.server.origin}/api/instance/setup`, { method: 'PATCH',
      headers: { ...headers, origin: 'https://attacker.example.test' }, body: JSON.stringify({ candidateVersion: 0, changes: { displayName: 'Denied' } }) });
    expect(wrongOrigin.status).toBe(403);
    for (const bodyText of ['{"marker":"SYNTHETIC_INVALID_INPUT_SENTINEL"', JSON.stringify({ candidateVersion: 0, changes: {} }),
      JSON.stringify({ candidateVersion: 0, changes: { defaultDocsFolder: '../outside' } }),
      JSON.stringify({ candidateVersion: 0, changes: { displayName: 'SYNTHETIC_INVALID_INPUT_SENTINEL', unexpected: true } })]) {
      const invalid = await fetch(`${api.server.origin}/api/instance/setup`, { method: 'PATCH', headers, body: bodyText });
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(await invalid.json())).not.toContain('SYNTHETIC_INVALID_INPUT_SENTINEL');
    }

    const values = { zitadelClientSecret: 'SYNTHETIC_CLIENT_SECRET', githubPrivateKey: setupAppKey, githubWebhookSecret: 'SYNTHETIC_WEBHOOK_SECRET' };
    const saved = await fetch(`${api.server.origin}/api/instance/setup`, { method: 'PATCH', headers,
      body: JSON.stringify({ candidateVersion: 0, changes: {
        displayName: 'Configured instance', description: 'Synthetic configuration', defaultDocsFolder: 'docs/guides',
        publicOrigin: setupOrigin,
        zitadel: { issuer: 'https://identity.example.test', clientId: 'synthetic-client', projectId: 'synthetic-project', apiAudience: 'synthetic-api' },
        github: { appId: '12345' },
      }, secretReplacements: Object.fromEntries(Object.entries(values).map(([purpose, value]) => [purpose, { action: 'replace', value }])) }) });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const snapshot = await saved.json();
    expect(snapshot).toMatchObject({ editRevision: 1, candidateVersion: 1, candidate: {
      preferences: { displayName: 'Configured instance', description: 'Synthetic configuration', docsFolder: 'docs/guides' },
      publicOrigin: setupOrigin, zitadel: { clientId: 'synthetic-client', projectId: 'synthetic-project', audience: 'synthetic-api' },
      github: { appId: '12345' }, secrets: {
        zitadelClientSecret: { configured: true }, githubPrivateKey: { configured: true }, githubWebhookSecret: { configured: true },
      },
    } });
    const persisted = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    expect(persisted?.candidate?.secrets.zitadelClientSecret?.ciphertext).not.toBe(values.zitadelClientSecret);
    expect(persisted?.candidate?.secrets.githubPrivateKey?.ciphertext).not.toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify(snapshot)).not.toContain(values.zitadelClientSecret);
    expect(JSON.stringify(snapshot)).not.toContain(values.githubWebhookSecret);
    expect(JSON.stringify(snapshot)).not.toContain('BEGIN PRIVATE KEY');
  } finally { await api.close(); }
});

it('returns a typed database check', async () => {
  const api = await createSetupApiFixture(3202, true);
  try {
    const snapshot = await fetch(`${api.server.origin}/api/instance/setup`, { headers: { cookie: api.setupCookie } });
    expect(snapshot.status).toBe(200);
    const stale = await fetch(`${api.server.origin}/api/instance/setup/check`, { method: 'POST', headers: api.headers({
      'content-type': 'application/json', 'if-match': '"0"',
    }), body: JSON.stringify({ candidateVersion: 1, type: 'database' }) });
    expect(stale.status).toBe(409);
    const invalid = await fetch(`${api.server.origin}/api/instance/setup/check`, { method: 'POST', headers: api.headers({
      'content-type': 'application/json', 'if-match': snapshot.headers.get('etag')!,
    }), body: JSON.stringify({ candidateVersion: 1, type: 'made_up' }) });
    expect(invalid.status).toBe(400);
    const check = await fetch(`${api.server.origin}/api/instance/setup/check`, { method: 'POST', headers: api.headers({
      'content-type': 'application/json', 'if-match': snapshot.headers.get('etag')!,
    }), body: JSON.stringify({ candidateVersion: 1, type: 'database' }) });
    expect(check.status).toBe(200);
    expect(check.headers.get('cache-control')).toContain('no-store');
    expect(check.headers.get('etag')).toBe(snapshot.headers.get('etag'));
    expect(await check.json()).toMatchObject({ type: 'database', candidateVersion: 1, status: 'passed', code: 'database_ok' });
    expect((await readInstance(api.fixture.storage.db, api.fixture.instanceId))?.candidate?.checks).toContainEqual(
      expect.objectContaining({ type: 'database', candidateVersion: 1, status: 'passed', code: 'database_ok' }));
  } finally { await api.close(); }
});

it('reuses only current owner proof and records safe webhook and structural-check results', async () => {
  const api = await createSetupApiFixture(3214, true);
  try {
    const snapshot = await fetch(`${api.server.origin}/api/instance/setup`, { headers: { cookie: api.setupCookie } });
    const initial = await snapshot.json();
    const check = (type: string, etag: string) => fetch(`${api.server.origin}/api/instance/setup/check`, { method: 'POST', headers: api.headers({
      'content-type': 'application/json', 'if-match': etag,
    }), body: JSON.stringify({ candidateVersion: initial.candidateVersion, type }) });

    const verifiedOwner = await check('zitadel_owner_login', snapshot.headers.get('etag')!);
    expect(verifiedOwner.status).toBe(200);
    expect(await verifiedOwner.json()).toMatchObject({ type: 'zitadel_owner_login', status: 'passed', code: 'provider_ok' });

    const control = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    await updateInstance(api.fixture.storage.db, api.fixture.instanceId, control!.revision, current => ({
      ...current, candidate: { ...current.candidate!, ownerProof: { ...current.candidate!.ownerProof!, expiresAt: new Date(current.candidate!.createdAt.getTime() + 1) } },
    }), new Date(control!.updatedAt.getTime() + 1));
    const refreshed = await fetch(`${api.server.origin}/api/instance/setup`, { headers: { cookie: api.setupCookie } });
    const currentEtag = refreshed.headers.get('etag')!;
    const missingOwnerProof = await check('zitadel_owner_login', currentEtag);
    expect(missingOwnerProof.status).toBe(200);
    expect(await missingOwnerProof.json()).toMatchObject({ type: 'zitadel_owner_login', status: 'not_run', code: 'not_run' });

    const webhook = await check('github_webhook', currentEtag);
    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toMatchObject({ type: 'github_webhook', status: 'warning', code: 'delivery_unverified' });

    const unavailableProvider = await check('github_structure', currentEtag);
    expect(unavailableProvider.status).toBe(200);
    expect(await unavailableProvider.json()).toMatchObject({ type: 'github_structure', status: 'passed', code: 'provider_ok' });

    const stored = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    expect(stored?.candidate?.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'zitadel_owner_login', status: 'not_run', code: 'not_run' }),
      expect.objectContaining({ type: 'github_webhook', status: 'warning', code: 'delivery_unverified' }),
      expect.objectContaining({ type: 'github_structure', status: 'passed', code: 'provider_ok' }),
    ]));
  } finally { await api.close(); }
});

it('rejects unauthenticated or forged candidate auth without replacing the owner proof', async () => {
  const api = await createSetupApiFixture(3206, true);
  try {
    const anonymousLogin = await fetch(`${api.server.origin}/api/instance/auth/signin/zitadel`, { redirect: 'manual' });
    expect(anonymousLogin.status).toBe(401);
    expect(await anonymousLogin.json()).toMatchObject({ error: { code: 'setup_unauthorized' } });
    const forged = await fetch(`${api.server.origin}/api/instance/auth/callback/zitadel`, { method: 'POST', headers: api.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ issuer: 'https://identity.example.test', subject: 'attacker-chosen-owner' }) });
    expect(forged.status).not.toBe(200);
    expect((await readInstance(api.fixture.storage.db, api.fixture.instanceId))?.candidate?.ownerProof?.subject).toBe('synthetic-owner');
  } finally { await api.close(); }
});

it('keeps ordinary authentication, catalog, search and health routes closed before local adoption', async () => {
  const api = await createSetupApiFixture(3210, true);
  try {
    for (const path of ['/api/auth/session', '/api/admin/repos', '/api/search/private-docs']) {
      const response = await fetch(`${api.server.origin}${path}`);
      expect(response.status).not.toBe(200);
      const body = await response.text();
      expect(body).not.toContain('CLIENT_SECRET_SENTINEL');
      expect(body).not.toContain('PRIVATE_KEY_SENTINEL');
      expect(body).not.toContain('WEBHOOK_SECRET_SENTINEL');
    }
    const health = await fetch(`${api.server.origin}/api/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: 'not_ready' });
  } finally { await api.close(); }
});

it('records a bounded signed setup ping as proof without admitting operational work', async () => {
  const api = await createSetupApiFixture(3207, true);
  try {
    const deliveryId = randomUUID();
    const raw = Buffer.from(JSON.stringify({ zen: 'Synthetic setup ping', hook_id: 7, hook: { id: 7 } }));
    const signature = `sha256=${createHmac('sha256', 'WEBHOOK_SECRET_SENTINEL').update(raw).digest('hex')}`;
    const deliver = (id = deliveryId) => fetch(`${api.server.origin}/api/webhooks/github`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-hub-signature-256': signature, 'x-github-delivery': id, 'x-github-event': 'ping',
    }, body: raw.toString('utf8') });

    const invalidSignature = await fetch(`${api.server.origin}/api/webhooks/github`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}`, 'x-github-delivery': randomUUID(), 'x-github-event': 'ping',
    }, body: raw.toString('utf8') });
    expect(invalidSignature.status).toBe(403);
    expect(await api.fixture.storage.db.collection('instance_setup_webhook_receipts').countDocuments()).toBe(0);

    const accepted = await deliver();
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ status: 'accepted', candidateVersion: 1 });
    const repeated = await deliver();
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ status: 'duplicate' });
    const control = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    expect(control?.candidate?.checks).toContainEqual(expect.objectContaining({ type: 'github_webhook', candidateVersion: 1, status: 'passed', code: 'provider_ok' }));
    expect(await api.fixture.storage.db.collection('syncJobs').countDocuments()).toBe(0);
    expect(JSON.stringify(await api.fixture.storage.db.collection('instance_setup_webhook_receipts').find().toArray())).not.toContain('Synthetic setup ping');

    const signed = (body: string, headers: Record<string, string> = {}) => fetch(`${api.server.origin}/api/webhooks/github`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'WEBHOOK_SECRET_SENTINEL').update(body).digest('hex')}`,
      'x-github-delivery': randomUUID(), 'x-github-event': 'ping', ...headers,
    }, body });
    for (const headers of [{ 'x-github-delivery': 'invalid' }, { 'x-github-event': '' }, { 'x-github-event': 'invalid event' }] as Record<string, string>[]) {
      expect((await signed(raw.toString(), headers)).status).toBe(400);
    }
    for (const body of ['{', JSON.stringify({ hook_id: 7, hook: { id: 8 } }), '{}']) expect((await signed(body)).status).toBe(400);
    expect((await signed(JSON.stringify({ hook_id: 8, hook: { id: 8 } }), { 'x-github-delivery': deliveryId })).status).toBe(409);
    const concurrentId = randomUUID();
    const concurrent = await Promise.all([deliver(concurrentId), deliver(concurrentId)]);
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 202]);

    const operational = Buffer.from(JSON.stringify({ synthetic: 'must be ignored before setup' }));
    const operationalSignature = `sha256=${createHmac('sha256', 'WEBHOOK_SECRET_SENTINEL').update(operational).digest('hex')}`;
    const ignored = await fetch(`${api.server.origin}/api/webhooks/github`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-hub-signature-256': operationalSignature, 'x-github-delivery': randomUUID(), 'x-github-event': 'push',
    }, body: operational.toString('utf8') });
    expect(ignored.status).toBe(202);
    expect(await ignored.json()).toMatchObject({ status: 'ignored' });
    expect(await api.fixture.storage.db.collection('syncJobs').countDocuments()).toBe(0);
    let limited = false;
    for (let attempt = 0; attempt < 14 && !limited; attempt++) limited = (await deliver(randomUUID())).status === 429;
    expect(limited).toBe(true); expect((await deliver()).status).toBe(200);
    const controls = api.fixture.storage.db.collection<StoredInstanceControl>('instance_configuration');
    const saved = (await controls.findOne({ _id: 'instance' }))!;
    const ciphertext = Buffer.from(saved.candidate!.configuration.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    await controls.updateOne({ _id: 'instance' }, { $set: { 'candidate.configuration.ciphertext': ciphertext.toString('base64') } });
    expect((await deliver()).status).toBe(503);
    await controls.replaceOne({ _id: 'instance' }, saved);
    let logical = (await readInstance(api.fixture.storage.db, api.fixture.instanceId))!;
    let at = new Date(logical.updatedAt.getTime() + 1);
    logical = await updateInstance(api.fixture.storage.db, api.fixture.instanceId, logical.revision, value => ({ ...value,
      candidate: { ...value.candidate!, secrets: { ...value.candidate!.secrets, githubWebhookSecret: null } } }), at);
    expect((await deliver()).status).toBe(403);
    at = new Date(logical.updatedAt.getTime() + 1);
    await updateInstance(api.fixture.storage.db, api.fixture.instanceId, logical.revision, value => ({ ...value, candidate: null, lifecycle: 'configuring' }), at);
    expect((await deliver()).status).toBe(403);
    await controls.replaceOne({ _id: 'instance' }, { ...saved, lifecycle: 'maintenance' });
    expect((await deliver()).status).toBe(503);
    await controls.deleteOne({ _id: 'instance' });
    expect((await deliver()).status).toBe(503);
  } finally { await api.close(); }
});

it('reconciles a repeated accepted finalize attempt once and rejects a different attempt', async () => {
  const api = await createSetupApiFixture(3203, true);
  try {
    const control = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    const snapshot = await fetch(`${api.server.origin}/api/instance/setup`, { headers: { cookie: api.setupCookie } });
    expect(snapshot.status).toBe(200);
    const payload = { candidateVersion: 1, confirmationNonce: control!.candidate!.impact!.confirmationNonce, confirm: true };
    const finalize = (body: typeof payload) => fetch(`${api.server.origin}/api/instance/setup/finalize`, { method: 'POST', headers: api.headers({
      'content-type': 'application/json', 'if-match': snapshot.headers.get('etag')!,
    }), body: JSON.stringify(body) });
    const first = await finalize(payload);
    expect([200, 202]).toContain(first.status);
    const firstBody = await first.json();
    const repeated = await finalize(payload);
    expect(repeated.status).toBe(first.status);
    const repeatedBody = await repeated.json();
    const outcome = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId'));
    expect(outcome(repeatedBody)).toEqual(outcome(firstBody));
    const committed = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    expect(committed).toMatchObject({ lifecycle: 'ready', bootstrap: { consumedAt: expect.any(Date), sessionSlots: [] }, active: { version: 1 },
      candidate: null, gate: { state: 'open', activationId: null, deadline: null }, activation: null,
      auditOutbox: [expect.objectContaining({ operation: 'setup_finalized', resultCode: 'accepted' })] });
    expect(JSON.parse(await readFile(api.fixture.env.INSTANCE_STATE_FILE!, 'utf8'))).toMatchObject({ phase: 'initialized', instanceId: api.fixture.instanceId });
    await expect(readInstanceHost(api.fixture.env, process.cwd(), new Date(Date.now() + 48 * 60 * 60_000))).resolves.toMatchObject({ marker: { phase: 'initialized' } });

    const different = await finalize({ ...payload, confirmationNonce: randomUUID() });
    expect(different.status).toBe(409);
    expect(await fixtureOwnerCount(api.fixture.storage.db, api.fixture.instanceId)).toBe(1);
  } finally { await api.close(); }
});

it('resumes a committed initial setup during Node startup and only then reports runtime readiness', async () => {
  const api = await createSetupApiFixture(3211, true);
  try {
    let current = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    const candidate = current!.candidate!;
    const committed = await commitInitialInstance(api.fixture.storage.db, api.fixture.instanceId, current!.revision,
      candidate.version, candidate.impact!.confirmationNonce, new Date(current!.updatedAt.getTime() + 1));
    expect(committed.lifecycle).toBe('maintenance');
    expect(JSON.parse(await readFile(api.fixture.env.INSTANCE_STATE_FILE!, 'utf8')).phase).toBe('sealed');
    const restarted = await api.fixture.restart();
    const status = await fetch(`${restarted.origin}/api/instance/status`);
    expect(await status.json()).toMatchObject({ state: 'ready', prerequisitesAvailable: true });
    current = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    expect(current).toMatchObject({ lifecycle: 'ready', gate: { state: 'open' }, activation: null, active: { version: candidate.version } });
    expect(JSON.parse(await readFile(api.fixture.env.INSTANCE_STATE_FILE!, 'utf8')).phase).toBe('initialized');
  } finally { await api.close(); }
});

it('does not commit setup when the verified owner role is stale', async () => {
  const api = await createSetupApiFixture(3209, true);
  try {
    const control = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    const proof = control!.candidate!.ownerProof!;
    const roleId = createHash('sha256').update(`${proof.issuer}\0${proof.subject}\0${proof.projectId}`).digest('hex');
    await api.fixture.storage.db.collection<{ _id: string; verifiedAt: Date }>('identity_authorizations').updateOne({ _id: roleId }, { $set: { verifiedAt: new Date(0) } });
    const snapshot = await fetch(`${api.server.origin}/api/instance/setup`, { headers: { cookie: api.setupCookie } });
    const response = await fetch(`${api.server.origin}/api/instance/setup/finalize`, { method: 'POST', headers: api.headers({
      'content-type': 'application/json', 'if-match': snapshot.headers.get('etag')!,
    }), body: JSON.stringify({ candidateVersion: 1, confirmationNonce: control!.candidate!.impact!.confirmationNonce, confirm: true }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'owner_continuity_required' } });
    expect(await fixtureOwnerCount(api.fixture.storage.db, api.fixture.instanceId)).toBe(0);
    expect((await readInstance(api.fixture.storage.db, api.fixture.instanceId))?.bootstrap.consumedAt).toBeNull();
  } finally { await api.close(); }
});

it('does not reopen a committed-but-unadopted instance or add another owner', async () => {
  const api = await createSetupApiFixture(3204, true);
  try {
    const current = await readInstance(api.fixture.storage.db, api.fixture.instanceId);
    const committed = readyInstance(api.fixture.instanceId, current!.createdAt);
    committed.lifecycle = 'maintenance';
    committed.revision = current!.revision + 1;
    committed.editRevision = current!.editRevision + 1;
    committed.updatedAt = new Date(current!.updatedAt.getTime() + 1);
    committed.gate.state = 'maintenance';
    const keyData = JSON.parse(await readFile(api.fixture.env.INSTANCE_KEYRING_FILE!, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    const keyring = { activeKeyId: keyData.activeKeyId, keys: Object.fromEntries(Object.entries(keyData.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])) };
    const secretValues = { zitadelClientSecret: 'SYNTHETIC_CLIENT_SECRET', githubPrivateKey: setupAppKey, githubWebhookSecret: 'SYNTHETIC_WEBHOOK_SECRET' };
    for (const purpose of Object.keys(secretValues) as (keyof typeof secretValues)[]) committed.active!.secrets[purpose] = encryptInstanceSecret(secretValues[purpose], {
      instanceId: api.fixture.instanceId, purpose, credentialVersion: randomUUID(),
    }, keyring, committed.updatedAt);
    const stored = await serializeInstanceControl(InstanceControlSchema.parse(committed), api.fixture.instanceId, keyring);
    await api.fixture.storage.db.collection<StoredInstanceControl>('instance_configuration').replaceOne({ _id: 'instance', instanceId: api.fixture.instanceId }, stored);

    const response = await fetch(`${api.server.origin}/api/instance/setup/finalize`, { method: 'POST', headers: api.headers({
      'content-type': 'application/json', 'if-match': '"1"',
    }), body: JSON.stringify({ candidateVersion: 1, confirmationNonce: current!.candidate!.impact!.confirmationNonce, confirm: true }) });
    expect(response.status).toBe(409);
    expect(await fixtureOwnerCount(api.fixture.storage.db, api.fixture.instanceId)).toBe(1);
    expect((await readInstance(api.fixture.storage.db, api.fixture.instanceId))?.lifecycle).toBe('maintenance');
  } finally { await api.close(); }
});

async function fixtureOwnerCount(db: Awaited<ReturnType<typeof createStorageHarness>>['db'], instanceId: string) {
  const control = await readInstance(db, instanceId);
  return control?.administrators.filter(binding => binding.status === 'active' && binding.kind === 'owner').length ?? 0;
}
