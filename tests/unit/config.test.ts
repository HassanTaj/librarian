import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadHostConfig } from '../../lib/config';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let cwd: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'librarian-config-test-'));
  await mkdir(join(cwd, 'content'));
  await mkdir(join(cwd, 'public'));
  env = {
    NODE_ENV: 'test',
    AUTH_URL: 'http://localhost:3000', AUTH_TRUST_HOST: 'true',
    AUTH_ZITADEL_ID: 'synthetic-client', AUTH_ZITADEL_ISSUER: 'https://identity.example.test',
    ZITADEL_PROJECT_ID: '123', ZITADEL_API_AUDIENCE: 'synthetic-audience',
    MONGODB_DATABASE: 'librarian', GITHUB_APP_ID: '456', CONTENT_ROOT: 'content',
    AUTH_SECRET_FILE: 'auth', AUTH_ZITADEL_SECRET_FILE: 'zitadel',
    MONGODB_URI_FILE: 'mongo', GITHUB_APP_PRIVATE_KEY_FILE: 'github',
    GITHUB_WEBHOOK_SECRET_FILE: 'webhook', OAUTH_TOKEN_ENCRYPTION_KEY_FILE: 'encryption',
  };
  for (const [name, value] of Object.entries({
    auth: 'synthetic-auth-secret-with-32-bytes', zitadel: 'synthetic-client-secret',
    mongo: 'mongodb://127.0.0.1:27018/librarian', github: rsa,
    webhook: 'synthetic-webhook-secret-32-bytes-long', encryption: Buffer.alloc(32, 7).toString('base64'),
  })) await writeFile(join(cwd, name), value + '\n');
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe('runtime server configuration', () => {
  it('loads host prerequisites without requiring optional provider configuration', async () => {
    const hostEnv = { ...env };
    for (const name of ['AUTH_URL', 'AUTH_ZITADEL_ID', 'AUTH_ZITADEL_ISSUER', 'AUTH_ZITADEL_SECRET_FILE', 'ZITADEL_PROJECT_ID', 'ZITADEL_API_AUDIENCE', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET_FILE']) delete hostEnv[name];
    const host = await loadHostConfig(hostEnv, cwd);
    expect(host.mongodbDatabase).toBe('librarian');
    expect(host.oauthTokenEncryptionKey).toEqual(Buffer.alloc(32, 7));
    expect(host).not.toHaveProperty('zitadelSecret');
    await expect(loadConfig(hostEnv, cwd)).rejects.toThrow('Invalid server configuration');
  });
  it('accepts the Zitadel client ID format with an application suffix', async () => {
    env.AUTH_ZITADEL_ID = '12345678@librarian';
    expect((await loadConfig(env, cwd)).zitadelClientId).toBe('12345678@librarian');
  });

  it('loads exact environment names and file secrets without client fields', async () => {
    const config = await loadConfig(env, cwd);
    expect(config).toMatchObject({ authUrl: 'http://localhost:3000', trustHost: true, zitadelIssuer: 'https://identity.example.test', mongodbDatabase: 'librarian', githubAppId: '456', contentRoot: await realpath(join(cwd, 'content')) });
    expect(config.authSecret).toBe('synthetic-auth-secret-with-32-bytes');
    expect(config.githubPrivateKey).toBe(rsa.trim());
    expect(config.oauthTokenEncryptionKey).toEqual(Buffer.alloc(32, 7));
    expect(Object.keys(config).some(key => key.startsWith('NEXT_PUBLIC_'))).toBe(false);
  });

  it('supports HTTPS production origin and explicit untrusted host', async () => {
    const config = await loadConfig({ ...env, NODE_ENV: 'production', AUTH_URL: 'https://portal.example.test', AUTH_TRUST_HOST: 'false', CONTENT_ROOT: join(cwd, 'content') }, cwd);
    expect(config.trustHost).toBe(false);
    expect(config.authUrl).toBe('https://portal.example.test');
  });

  it('supports a runtime image without a public directory', async () => {
    await rm(join(cwd, 'public'), { recursive: true });
    expect((await loadConfig(env, cwd)).contentRoot).toBe(await realpath(join(cwd, 'content')));
  });

  it('accepts an external optional public approval manifest', async () => {
    const path = join(cwd, 'approvals.json');
    await writeFile(path, '{}');
    env.PUBLIC_CATALOG_APPROVALS_FILE = 'approvals.json';
    expect((await loadConfig(env, cwd)).publicCatalogApprovalsFile).toBe(await realpath(path));
  });

  it.each(['public', 'content'])('rejects an approval manifest under %s', async directory => {
    const path = join(cwd, directory, 'approvals.json');
    await writeFile(path, '{}');
    env.PUBLIC_CATALOG_APPROVALS_FILE = `${directory}/approvals.json`;
    await expect(loadConfig(env, cwd)).rejects.toThrow('PUBLIC_CATALOG_APPROVALS_FILE');
  });

  it('rejects a missing or oversized configured approval manifest', async () => {
    env.PUBLIC_CATALOG_APPROVALS_FILE = 'missing-approvals.json';
    await expect(loadConfig(env, cwd)).rejects.toThrow('PUBLIC_CATALOG_APPROVALS_FILE');
    await writeFile(join(cwd, 'approvals.json'), 'x'.repeat(65 * 1024));
    env.PUBLIC_CATALOG_APPROVALS_FILE = 'approvals.json';
    await expect(loadConfig(env, cwd)).rejects.toThrow('PUBLIC_CATALOG_APPROVALS_FILE');
  });

  it.each(['mongodb://host-one:27017,host-two:27017/librarian?replicaSet=synthetic', 'mongodb+srv://cluster.example.test/librarian', 'mongodb://localhost:27018/?authSource=librarian'])('accepts official Mongo URI syntax %s', async uri => {
    await writeFile(join(cwd, 'mongo'), uri);
    expect((await loadConfig(env, cwd)).mongodbUri).toBe(uri);
  });

  it('uses default arguments lazily rather than loading credentials on import', async () => {
    await expect(loadConfig()).rejects.toThrow('Invalid server configuration:');
  });

  it.each([
    'AUTH_URL', 'AUTH_TRUST_HOST', 'AUTH_ZITADEL_ID', 'AUTH_ZITADEL_ISSUER', 'ZITADEL_PROJECT_ID', 'ZITADEL_API_AUDIENCE',
    'MONGODB_DATABASE', 'GITHUB_APP_ID', 'CONTENT_ROOT', 'AUTH_SECRET_FILE', 'AUTH_ZITADEL_SECRET_FILE', 'MONGODB_URI_FILE',
    'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET_FILE', 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE',
  ])('rejects missing %s', async key => {
    delete env[key];
    await expect(loadConfig(env, cwd)).rejects.toThrow(key);
  });

  it.each([
    ['AUTH_URL', 'https://user:synthetic-token@portal.example.test'],
    ['AUTH_URL', 'https://portal.example.test/?token=synthetic-token'],
    ['AUTH_URL', 'https://portal.example.test/#fragment'],
    ['AUTH_URL', 'https://portal.example.test/subpath'],
    ['AUTH_URL', 'http://remote.example.test'],
    ['AUTH_URL', 'ftp://portal.example.test'],
    ['AUTH_ZITADEL_ISSUER', 'http://identity.example.test'],
    ['AUTH_ZITADEL_ISSUER', 'https://identity.example.test/path'],
    ['AUTH_TRUST_HOST', 'yes'], ['MONGODB_DATABASE', 'admin/system'], ['GITHUB_APP_ID', '0'],
    ['AUTH_ZITADEL_ID', 'client with spaces'],
  ])('rejects invalid %s without printing its value', async (key, value) => {
    env[key] = value;
    await expect(loadConfig(env, cwd)).rejects.toThrow(`Invalid server configuration: ${key}`);
    await expect(loadConfig(env, cwd)).rejects.not.toThrow(value);
  });

  it('rejects HTTP production origin', async () => {
    await expect(loadConfig({ ...env, NODE_ENV: 'production' }, cwd)).rejects.toThrow('AUTH_URL');
  });

  it.each(['public', 'public/nested', 'missing', 'auth'])('rejects unsafe/unavailable content root %s', async path => {
    await mkdir(join(cwd, 'public', 'nested'), { recursive: true });
    env.CONTENT_ROOT = path;
    await expect(loadConfig(env, cwd)).rejects.toThrow('CONTENT_ROOT');
  });

  it.each([
    ['auth', 'short', 'AUTH_SECRET_FILE'], ['webhook', 'short', 'GITHUB_WEBHOOK_SECRET_FILE'],
    ['encryption', Buffer.alloc(31).toString('base64'), 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE'],
    ['encryption', Buffer.alloc(32).toString('base64') + '!', 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE'],
    ['github', 'synthetic-invalid-pem', 'GITHUB_APP_PRIVATE_KEY_FILE'],
    ['mongo', 'https://synthetic-token.example.test', 'MONGODB_URI_FILE'],
    ['mongo', 'mongodb://localhost/other-database', 'MONGODB_URI_FILE'],
    ['mongo', 'mongodb://localhost/librarian#fragment', 'MONGODB_URI_FILE'],
    ['zitadel', '', 'AUTH_ZITADEL_SECRET_FILE'], ['zitadel', 'x'.repeat(65537), 'AUTH_ZITADEL_SECRET_FILE'],
  ])('rejects invalid %s file without exposing contents', async (file, value, setting) => {
    await writeFile(join(cwd, file), value);
    await expect(loadConfig(env, cwd)).rejects.toThrow(`Invalid server configuration: ${setting}`);
  });

  it('rejects a non-RSA GitHub private key', async () => {
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(join(cwd, 'github'), key);
    await expect(loadConfig(env, cwd)).rejects.toThrow('GITHUB_APP_PRIVATE_KEY_FILE');
  });

  it('accepts a secret exactly at the file-size limit', async () => {
    await writeFile(join(cwd, 'zitadel'), 'x'.repeat(65536));
    expect((await loadConfig(env, cwd)).zitadelSecret).toHaveLength(65536);
  });

  it.each(['missing-file', 'content'])('sanitizes inaccessible/non-file secret %s', async path => {
    env.AUTH_SECRET_FILE = path;
    await expect(loadConfig(env, cwd)).rejects.toThrow('Invalid server configuration: AUTH_SECRET_FILE');
    await expect(loadConfig(env, cwd)).rejects.not.toThrow(cwd);
  });
});

// Regression: direct .env values used to be ignored in favor of required secret files.
it('loads all direct credentials, including multiline PEM, without any secret files', async () => {
  for (const name of ['AUTH_SECRET_FILE', 'AUTH_ZITADEL_SECRET_FILE', 'MONGODB_URI_FILE', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET_FILE', 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE']) delete env[name];
  Object.assign(env, { AUTH_SECRET: 'direct-auth-secret-with-at-least-32-bytes', AUTH_ZITADEL_SECRET: 'direct-zitadel-secret',
    MONGODB_URI: 'mongodb://127.0.0.1:27018/librarian', GITHUB_APP_PRIVATE_KEY: rsa,
    GITHUB_WEBHOOK_SECRET: 'direct-webhook-secret-with-at-least-32-bytes', OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') });
  await rm(join(cwd, 'auth')); await rm(join(cwd, 'zitadel')); await rm(join(cwd, 'mongo'));
  await rm(join(cwd, 'github')); await rm(join(cwd, 'webhook')); await rm(join(cwd, 'encryption'));
  const config = await loadConfig(env, cwd);
  expect(config).toMatchObject({ authSecret: env.AUTH_SECRET, zitadelSecret: env.AUTH_ZITADEL_SECRET,
    mongodbUri: env.MONGODB_URI, githubPrivateKey: rsa.trim(), githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET });
  expect(config.oauthTokenEncryptionKey).toEqual(Buffer.alloc(32, 8));
});

it('prefers direct credentials and rejects invalid direct values without falling back to a valid file', async () => {
  env.AUTH_SECRET = 'direct-auth-secret-with-at-least-32-bytes';
  env.AUTH_SECRET_FILE = 'missing';
  expect((await loadConfig(env, cwd)).authSecret).toBe(env.AUTH_SECRET);
  env.AUTH_SECRET_FILE = 'auth';
  for (const value of ['', 'too-short', 'x'.repeat(65537)]) {
    env.AUTH_SECRET = value;
    await expect(loadConfig(env, cwd)).rejects.toThrow('Invalid server configuration');
  }
});
