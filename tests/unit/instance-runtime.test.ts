import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const doubles = vi.hoisted(() => ({ host: undefined as unknown, control: undefined as unknown }));
vi.mock('../../lib/instance/bootstrap', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/instance/bootstrap')>();
  return { ...original, readInstanceHost: vi.fn(async () => doubles.host) };
});
vi.mock('../../lib/instance/store', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/instance/store')>();
  return { ...original, readInstance: vi.fn(async () => doubles.control) };
});
vi.mock('../../lib/mongo', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/mongo')>();
  return { ...original, connectMongo: vi.fn(async () => ({ db: {}, client: { close: vi.fn() } })) };
});

import { loadConfig, loadHostConfig } from '../../lib/config';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { encryptInstanceSecret } from '../../lib/instance/secrets';

let cwd: string;
let env: NodeJS.ProcessEnv;
const instanceId = randomUUID();
const keyring = { activeKeyId: 'runtime-test-key', keys: { 'runtime-test-key': Buffer.alloc(32, 3) } };
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

beforeEach(async () => {
  vi.clearAllMocks();
  cwd = await mkdtemp(join(tmpdir(), 'librarian-runtime-test-'));
  await mkdir(join(cwd, 'content'));
  await mkdir(join(cwd, 'public'));
  env = {
    NODE_ENV: 'test', AUTH_URL: 'http://localhost:3000', AUTH_TRUST_HOST: 'true',
    AUTH_ZITADEL_ID: 'legacy-client', AUTH_ZITADEL_ISSUER: 'https://legacy-identity.example.test',
    ZITADEL_PROJECT_ID: 'legacy-project', ZITADEL_API_AUDIENCE: 'legacy-audience', MONGODB_DATABASE: 'librarian',
    GITHUB_APP_ID: '456', CONTENT_ROOT: 'content', AUTH_SECRET_FILE: 'auth', AUTH_ZITADEL_SECRET_FILE: 'zitadel',
    MONGODB_URI_FILE: 'mongo', GITHUB_APP_PRIVATE_KEY_FILE: 'github', GITHUB_WEBHOOK_SECRET_FILE: 'webhook', OAUTH_TOKEN_ENCRYPTION_KEY_FILE: 'encryption',
    INSTANCE_ID: instanceId, INSTANCE_STATE_FILE: 'marker',
  };
  for (const [name, value] of Object.entries({ auth: 'synthetic-auth-secret-with-32-bytes', zitadel: 'legacy-client-secret',
    mongo: 'mongodb://127.0.0.1:27018/librarian', github: privateKey, webhook: 'legacy-webhook-secret-32-bytes-long',
    encryption: Buffer.alloc(32, 7).toString('base64') })) await writeFile(join(cwd, name), value + '\n');
  doubles.host = { instanceId, config: await loadHostConfig(env, cwd), setupOrigin: 'https://setup.example.test',
    marker: { instanceId, phase: 'initialized', recoveryEpoch: 1 }, keyring, operator: {}, policy: { origins: [] } };
});

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); });

it('validates host prerequisites when the runtime reads its default environment and working directory', async () => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  expect((await loadHostConfig()).mongodbDatabase).toBe('librarian');
  await expect(loadHostConfig({ ...env, MONGODB_DATABASE: 'invalid/name' }, cwd)).rejects.toThrow();
});

it('rejects weak and non-RSA active App keys without falling back to legacy credentials', async () => {
  for (const key of [generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey]) {
    const control = readyInstance(instanceId);
    control.active!.secrets.githubPrivateKey = encryptInstanceSecret(key.export({ format: 'pem', type: 'pkcs8' }).toString(),
      { instanceId, purpose: 'githubPrivateKey', credentialVersion: randomUUID() }, keyring);
    doubles.control = control;
    await expect(loadConfig(env, cwd)).rejects.toThrow('Instance setup is not ready.');
  }
}, 15_000);

it('preserves legacy runtime only while a valid uninitialized migration remains open', async () => {
  const control = instanceControl(instanceId);
  control.migration = { sourceDigest: 'b'.repeat(64), mode: 'import', at: control.createdAt, verificationSummary: ['legacy_drained'] };
  doubles.host = { ...(doubles.host as object), marker: { instanceId, phase: 'sealed', recoveryEpoch: 1 } };
  doubles.control = control;
  await expect(loadConfig(env, cwd)).resolves.toMatchObject({ githubAppId: '456', instanceKeyring: keyring });
  control.gate.state = 'maintenance'; await expect(loadConfig(env, cwd)).rejects.toThrow('Instance setup is not ready.');
  doubles.control = { ...readyInstance(instanceId), lifecycle: 'maintenance', migration: control.migration };
  await expect(loadConfig(env, cwd)).rejects.toThrow('Instance setup is not ready.');
});

it('loads the ready active bundle instead of stale provider environment values', async () => {
  const control = readyInstance(instanceId);
  const active = control.active!;
  active.runtime!.authSecret = 'active-auth-secret-with-at-least-32-bytes';
  active.runtime!.oauthTokenEncryptionKey = Buffer.alloc(32, 9).toString('base64');
  active.runtime!.mongodbUri = 'mongodb://stored-copy.example.test/librarian';
  active.publicOrigin = 'https://active.example.test';
  active.zitadel.clientId = 'active-client';
  active.github.appId = '789';
  active.secrets.zitadelClientSecret = encryptInstanceSecret('active-client-secret', { instanceId, purpose: 'zitadelClientSecret', credentialVersion: randomUUID() }, keyring);
  active.secrets.githubPrivateKey = encryptInstanceSecret(privateKey, { instanceId, purpose: 'githubPrivateKey', credentialVersion: randomUUID() }, keyring);
  active.secrets.githubWebhookSecret = encryptInstanceSecret('active-webhook-secret', { instanceId, purpose: 'githubWebhookSecret', credentialVersion: randomUUID() }, keyring);
  doubles.control = control;
  const withoutProviderEnv = { ...env };
  for (const key of ['AUTH_URL', 'AUTH_ZITADEL_ID', 'AUTH_ZITADEL_ISSUER', 'ZITADEL_PROJECT_ID', 'ZITADEL_API_AUDIENCE', 'GITHUB_APP_ID',
    'AUTH_ZITADEL_SECRET_FILE', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET_FILE', 'AUTH_SECRET_FILE', 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE']) delete withoutProviderEnv[key];

  await expect(loadConfig(withoutProviderEnv, cwd)).resolves.toMatchObject({ authUrl: active.publicOrigin, zitadelClientId: 'active-client',
    zitadelIssuer: active.zitadel.issuer, zitadelProjectId: active.zitadel.projectId, zitadelApiAudience: active.zitadel.audience,
    mongodbUri: 'mongodb://127.0.0.1:27018/librarian', authSecret: active.runtime!.authSecret, oauthTokenEncryptionKey: Buffer.from(active.runtime!.oauthTokenEncryptionKey, 'base64'),
    zitadelSecret: 'active-client-secret', githubAppId: '789', githubPrivateKey: privateKey, githubWebhookSecret: 'active-webhook-secret',
    contentRoot: (doubles.host as { config: { contentRoot: string } }).config.contentRoot });
}, 15_000);

it('fails closed before setup instead of using otherwise valid legacy provider inputs', async () => {
  doubles.control = { ...readyInstance(instanceId), lifecycle: 'configuring', active: null, initializedAt: null, administrators: [] };
  await expect(loadConfig(env, cwd)).rejects.toThrow('Instance setup is not ready.');
});

it('keeps a validated legacy runtime when an explicit migration marker has no instance record', async () => {
  doubles.control = null;
  doubles.host = { ...(doubles.host as object), marker: { instanceId, phase: 'prepared', recoveryEpoch: 1 } };
  await expect(loadConfig(env, cwd)).resolves.toMatchObject({ authUrl: 'http://localhost:3000', zitadelClientId: 'legacy-client', githubAppId: '456' });
});

it('fails closed for a maintenance record even when legacy provider values remain', async () => {
  const control = readyInstance(instanceId);
  control.lifecycle = 'maintenance';
  control.gate = { state: 'maintenance', activationId: null, deadline: null };
  doubles.control = control;
  await expect(loadConfig(env, cwd)).rejects.toThrow('Instance setup is not ready.');
});

it('fails closed if an activated bundle lacks runtime secrets instead of using legacy files', async () => {
  const control = readyInstance(instanceId);
  delete (control.active as { runtime?: unknown }).runtime;
  control.active!.secrets.githubPrivateKey = encryptInstanceSecret(privateKey,
    { instanceId, purpose: 'githubPrivateKey', credentialVersion: randomUUID() }, keyring);
  doubles.control = control;
  await expect(loadConfig(env, cwd)).rejects.toThrow('Instance setup is not ready.');
});
