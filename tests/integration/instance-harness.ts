import { loadHostConfig, instanceRuntimeInputs } from '../../lib/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createStorageHarness, insertInstanceControl, startNextHarness } from './http-harness';
import { createProviderFixtures } from '../fixtures/providers';
import { readyInstance } from '../fixtures/instance';
import { encryptInstanceSecret } from '../../lib/instance/secrets';
import { instanceCsrfToken } from '../../lib/instance/access';
import { LIMITS } from '../../lib/limits';
import { attachInstanceKeyring } from '../../lib/instance/store';

/** Synthetic host authority only; every resource belongs to one disposable database. */
export async function createInstanceHarness(options: { port: number; mongoUri?: string }) {
  const storage = await createStorageHarness(options.mongoUri);
  let providers: Awaited<ReturnType<typeof createProviderFixtures>> | undefined;
  let server: Awaited<ReturnType<typeof startNextHarness>> | undefined;
  try {
    const protectedRoot = join(storage.root, 'protected');
    await mkdir(protectedRoot, { mode: 0o700 });
    if (process.platform === 'win32') {
      const run = promisify(execFile);
      const { stdout } = await run('whoami');
      await run('icacls', [protectedRoot, '/inheritance:r', '/grant:r', `${stdout.trim()}:(OI)(CI)F`], { windowsHide: true });
    }
    providers = await createProviderFixtures();
    const instanceId = randomUUID();
    const now = Date.now();
    const files = {
      marker: JSON.stringify({ instanceId, phase: 'prepared', recoveryEpoch: 1 }),
      keyring: JSON.stringify({ activeKeyId: 'synthetic-root', keys: { 'synthetic-root': randomBytes(32).toString('base64') } }),
      bootstrap: JSON.stringify({ instanceId, purpose: 'bootstrap', epoch: 1, credential: randomBytes(32).toString('base64url'), expiresAt: new Date(now + 86_400_000).toISOString() }),
      auth: randomBytes(32).toString('base64url'),
      oauth: randomBytes(32).toString('base64'),
      mongo: `mongodb://127.0.0.1:27018/${storage.db.databaseName}`,
      policy: JSON.stringify({ origins: [{ origin: providers.origin, addresses: ['127.0.0.1'] }] }),
      approvals: '[]',
    };
    const storedKeyring = JSON.parse(files.keyring) as { activeKeyId: string; keys: Record<string, string> };
    attachInstanceKeyring(storage.db, { activeKeyId: storedKeyring.activeKeyId,
      keys: Object.fromEntries(Object.entries(storedKeyring.keys).map(([key, value]) => [key, Buffer.from(value, 'base64')])) });
    // Keep the caller's validated loopback port when using another disposable server.
    files.mongo = `${(options.mongoUri ?? 'mongodb://127.0.0.1:27018').replace(/\/$/, '')}/${storage.db.databaseName}`;
    const paths = Object.fromEntries(Object.keys(files).map(key => [key, join(protectedRoot, `${key}.json`)])) as Record<keyof typeof files, string>;
    await Promise.all(Object.entries(files).map(([key, body]) => writeFile(paths[key as keyof typeof files], body, { mode: 0o600, flag: 'wx' })));
    const env = {
      NODE_ENV: 'test' as const,
      INSTANCE_DATABASE_FILE: '',
      INSTANCE_ID: instanceId, INSTANCE_SETUP_ORIGIN: `http://127.0.0.1:${options.port}`,
      INSTANCE_STATE_FILE: paths.marker, INSTANCE_KEYRING_FILE: paths.keyring,
      INSTANCE_OPERATOR_AUTH_FILE: paths.bootstrap, INSTANCE_OUTBOUND_POLICY_FILE: paths.policy,
      AUTH_SECRET_FILE: paths.auth, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: paths.oauth,
      MONGODB_URI_FILE: paths.mongo, MONGODB_DATABASE: storage.db.databaseName,
      CONTENT_ROOT: storage.contentRoot, AUTH_TRUST_HOST: 'true', LIBRARIAN_WORKER_ENABLED: '0',
      PUBLIC_CATALOG_APPROVALS_FILE: paths.approvals,
    };
    let closed = false;
    async function start() {
      if (closed) throw new Error('Instance harness is closed');
      if (server) throw new Error('Instance harness is already running');
      server = await startNextHarness({ appRoot: process.cwd(), port: options.port, env });
      return server;
    }
    async function stop() {
      if (server) { await server.close(); server = undefined; }
    }
    return {
      instanceId, port: options.port, storage, providers, env, start, stop,
      async restart() { await stop(); return start(); },
      async close() {
        if (closed) return;
        closed = true;
        try { await stop(); }
        finally { try { await providers!.close(); } finally { await storage.close(); } }
      },
    };
  } catch (error) {
    try { await providers?.close(); } finally { await storage.close(); }
    throw error;
  }
}

/** Real session/account/binding boundaries, synthetic provider credentials and an isolated DB. */
export async function seedReadyInstance(harness: Awaited<ReturnType<typeof createInstanceHarness>>) {
  const now = new Date();
  const control = readyInstance(harness.instanceId, now);
  control.active!.runtime = instanceRuntimeInputs(await loadHostConfig(harness.env), harness.env);
  const storedKeys = JSON.parse(await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
  const keyring = { activeKeyId: storedKeys.activeKeyId, keys: Object.fromEntries(Object.entries(storedKeys.keys).map(([key, value]) => [key, Buffer.from(value, 'base64')])) };
  const values = { zitadelClientSecret: 'SYNTHETIC_CLIENT_SENTINEL', githubPrivateKey: harness.providers.privateKey, githubWebhookSecret: 'SYNTHETIC_WEBHOOK_SENTINEL'.repeat(2) };
  for (const purpose of ['zitadelClientSecret', 'githubPrivateKey', 'githubWebhookSecret'] as const) control.active!.secrets[purpose] = encryptInstanceSecret(values[purpose], {
    instanceId: harness.instanceId, purpose, credentialVersion: randomUUID(),
  }, keyring, now);
  harness.env.INSTANCE_SETUP_ORIGIN = control.active!.publicOrigin;
  harness.env.INSTANCE_OUTBOUND_POLICY_FILE = '';
  await writeFile(harness.env.INSTANCE_STATE_FILE, JSON.stringify({ instanceId: harness.instanceId, phase: 'initialized', recoveryEpoch: control.recoveryEpoch }));
  await insertInstanceControl(harness.storage.db, control, keyring);
  const userId = new ObjectId(); const sessionToken = randomBytes(32).toString('base64url');
  const identity = { issuer: control.active!.zitadel.issuer, subject: 'synthetic-owner', projectId: control.active!.zitadel.projectId };
  await harness.storage.db.collection('users').insertOne({ _id: userId, name: null, email: null });
  await harness.storage.db.collection('accounts').insertOne({ userId, provider: 'zitadel', type: 'oidc', providerAccountId: identity.subject, issuer: identity.issuer });
  const expires = new Date(now.getTime() + LIMITS.sessionAbsoluteMs);
  await harness.storage.db.collection('sessions').insertOne({ sessionToken, userId, createdAt: now, absoluteExpiresAt: expires, expires,
    instanceId: harness.instanceId, securityEpoch: control.securityEpoch, recoveryEpoch: control.recoveryEpoch });
  await harness.storage.db.collection<{ _id: string } & typeof identity & { roles: string[]; verifiedAt: Date; leaseFence: number; lease: null }>('identity_authorizations').insertOne({
    _id: createHash('sha256').update(`${identity.issuer}\0${identity.subject}\0${identity.projectId}`).digest('hex'), ...identity,
    roles: ['librarian-instance-admin'], verifiedAt: now, leaseFence: 0, lease: null,
  });
  const cookie = `__Secure-authjs.session-token=${sessionToken}`;
  const csrfToken = instanceCsrfToken(await readFile(harness.env.AUTH_SECRET_FILE, 'utf8'), sessionToken);
  return { control, identity, userId, cookie, csrfToken,
    headers: (extra: Record<string, string> = {}) => ({ cookie, origin: control.active!.publicOrigin,
      'x-forwarded-host': new URL(control.active!.publicOrigin).host, 'x-forwarded-proto': 'https', 'x-csrf-token': csrfToken, ...extra }),
  };
}
