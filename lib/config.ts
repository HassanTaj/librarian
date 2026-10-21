import { readFile, realpath, stat } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { MongoClient } from 'mongodb';
import { LIMITS } from './limits';
import { readInstanceDatabase } from './instance/database';

const identifier = z.string().min(1).max(200).regex(/^[\w.:-]+$/);
const schema = z.object({
  AUTH_URL: z.url(),
  AUTH_TRUST_HOST: z.enum(['true', 'false']),
  AUTH_ZITADEL_ID: z.string().min(1).max(200).regex(/^[\w.:@-]+$/),
  AUTH_ZITADEL_ISSUER: z.url(),
  ZITADEL_PROJECT_ID: identifier,
  // OAuth audience-request scope; the issued token's aud claim is a different value.
  ZITADEL_API_AUDIENCE: identifier,
  MONGODB_DATABASE: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/),
  GITHUB_APP_ID: z.string().regex(/^[1-9]\d*$/),
  CONTENT_ROOT: z.string().min(1),
  AUTH_SECRET: z.string().min(1).optional(),
  AUTH_SECRET_FILE: z.string().min(1).optional(),
  AUTH_ZITADEL_SECRET: z.string().min(1).optional(),
  AUTH_ZITADEL_SECRET_FILE: z.string().min(1).optional(),
  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_URI_FILE: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET_FILE: z.string().min(1).optional(),
  OAUTH_TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  OAUTH_TOKEN_ENCRYPTION_KEY_FILE: z.string().min(1).optional(),
  PUBLIC_CATALOG_APPROVALS_FILE: z.string().min(1).optional(),
});

function fail(setting: string): never {
  // Error messages identify settings, never submitted values or filesystem paths.
  throw new Error(`Invalid server configuration: ${setting}`);
}

function safeUrl(value: string, setting: string, localHttp = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(localHttp && url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail(setting);
  return url;
}

const hostSchema = schema.pick({ AUTH_TRUST_HOST: true, MONGODB_DATABASE: true, CONTENT_ROOT: true, AUTH_SECRET: true, AUTH_SECRET_FILE: true, MONGODB_URI: true, MONGODB_URI_FILE: true, OAUTH_TOKEN_ENCRYPTION_KEY: true, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: true, PUBLIC_CATALOG_APPROVALS_FILE: true }).extend({ AUTH_TRUST_HOST: z.enum(['true', 'false']).default('false') });

async function secret(setting: string, env: NodeJS.ProcessEnv, cwd: string) {
  try {
    const direct = setting.replace(/_FILE$/, '');
    if (Object.hasOwn(env, direct)) {
      const value = env[direct]?.trim();
      if (!value || Buffer.byteLength(value) > 64 * 1024) fail(direct);
      return value;
    }
    if (!env[setting]) fail(setting);
    const path = resolve(cwd, env[setting]!);
    const info = await stat(path);
    if (!info.isFile() || info.size > 64 * 1024) fail(setting);
    const value = (await readFile(path, 'utf8')).trim();
    if (!value || Buffer.byteLength(value) > 64 * 1024) fail(setting);
    return value;
  } catch { fail(setting); }
}

export async function loadBootstrapConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const locator = env.INSTANCE_DATABASE_FILE ? await readInstanceDatabase(env, cwd) : null;
  const parsed = hostSchema.safeParse(locator ? { ...env, MONGODB_DATABASE: locator.mongodbDatabase } : env);
  if (!parsed.success) fail(parsed.error.issues.map(issue => issue.path.join('.')).join(', '));
  const settings = parsed.data;
  let contentRoot: string;
  let publicRoot: string;
  try {
    contentRoot = await realpath(resolve(cwd, settings.CONTENT_ROOT));
    if (!(await stat(contentRoot)).isDirectory()) fail('CONTENT_ROOT');
    publicRoot = await realpath(resolve(cwd, 'public')).catch(() => resolve(cwd, 'public'));
    const fromPublic = relative(publicRoot, contentRoot);
    if (!fromPublic || (!isAbsolute(fromPublic) && fromPublic !== '..' && !fromPublic.startsWith(`..${sep}`))) {
      fail('CONTENT_ROOT');
    }
  } catch { fail('CONTENT_ROOT'); }

  let publicCatalogApprovalsFile: string | undefined;
  const approvalSetting = settings.PUBLIC_CATALOG_APPROVALS_FILE;
  if (approvalSetting) {
    try {
      publicCatalogApprovalsFile = await realpath(resolve(cwd, approvalSetting));
      const info = await stat(publicCatalogApprovalsFile);
      const fromPublic = relative(publicRoot, publicCatalogApprovalsFile);
      const fromContent = relative(contentRoot, publicCatalogApprovalsFile);
      const inside = (path: string) => !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
      if (!info.isFile() || info.size > LIMITS.maxPublicApprovalBytes || inside(fromPublic) || inside(fromContent)) {
        fail('PUBLIC_CATALOG_APPROVALS_FILE');
      }
    } catch { fail('PUBLIC_CATALOG_APPROVALS_FILE'); }
  }

  const mongodbUri = locator?.mongodbUri ?? await secret('MONGODB_URI_FILE', env, cwd);
  if (locator) settings.MONGODB_DATABASE = locator.mongodbDatabase;
  try {
    const client = new MongoClient(mongodbUri);
    const path = mongodbUri.replace(/^mongodb(?:\+srv)?:\/\/[^/]+/, '').split('?')[0];
    if (mongodbUri.includes('#') || (path && path !== '/' && client.options.dbName !== settings.MONGODB_DATABASE)) fail('MONGODB_URI_FILE');
  } catch { fail('MONGODB_URI_FILE'); }
  return { trustHost: settings.AUTH_TRUST_HOST === 'true', mongodbUri, mongodbDatabase: settings.MONGODB_DATABASE, contentRoot, publicCatalogApprovalsFile };
}

export async function loadHostConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const bootstrap = await loadBootstrapConfig(env, cwd);
  const authSecret = await secret('AUTH_SECRET_FILE', env, cwd);
  if (Buffer.byteLength(authSecret) < 32) fail('AUTH_SECRET_FILE');
  const encryptionSecret = await secret('OAUTH_TOKEN_ENCRYPTION_KEY_FILE', env, cwd);
  const oauthTokenEncryptionKey = Buffer.from(encryptionSecret, 'base64');
  if (oauthTokenEncryptionKey.length !== 32 || oauthTokenEncryptionKey.toString('base64') !== encryptionSecret) {
    fail('OAUTH_TOKEN_ENCRYPTION_KEY_FILE');
  }
  return { ...bootstrap, authSecret, oauthTokenEncryptionKey };
}

/** Validated environment-backed runtime retained for legacy installations. */
async function loadLegacyConfig(env: NodeJS.ProcessEnv, cwd: string) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) fail(parsed.error.issues.map(issue => issue.path.join('.')).join(', '));
  const settings = parsed.data;
  const authUrl = safeUrl(settings.AUTH_URL, 'AUTH_URL', env.NODE_ENV !== 'production');
  if (authUrl.pathname !== '/') fail('AUTH_URL');
  const issuer = safeUrl(settings.AUTH_ZITADEL_ISSUER, 'AUTH_ZITADEL_ISSUER');
  if (issuer.pathname !== '/') fail('AUTH_ZITADEL_ISSUER');

  const host = await loadHostConfig(env, cwd);
  const zitadelSecret = await secret('AUTH_ZITADEL_SECRET_FILE', env, cwd);
  const githubPrivateKey = await secret('GITHUB_APP_PRIVATE_KEY_FILE', env, cwd);
  try {
    if (createPrivateKey(githubPrivateKey).asymmetricKeyType !== 'rsa') fail('GITHUB_APP_PRIVATE_KEY_FILE');
  } catch { fail('GITHUB_APP_PRIVATE_KEY_FILE'); }
  const githubWebhookSecret = await secret('GITHUB_WEBHOOK_SECRET_FILE', env, cwd);
  if (Buffer.byteLength(githubWebhookSecret) < 32) fail('GITHUB_WEBHOOK_SECRET_FILE');
  return {
    ...host, workerEnabled: (env.NODE_ENV === 'production' ? env.LIBRARIAN_WORKER_ENABLED !== '0' : env.LIBRARIAN_WORKER_ENABLED === '1'), authUrl: authUrl.origin,
    zitadelClientId: settings.AUTH_ZITADEL_ID, zitadelSecret, zitadelIssuer: issuer.origin,
    zitadelProjectId: settings.ZITADEL_PROJECT_ID, zitadelApiAudience: settings.ZITADEL_API_AUDIENCE,
    githubAppId: settings.GITHUB_APP_ID, githubPrivateKey, githubWebhookSecret,
  };
}

/** Load only at server runtime; imports and production builds need no credentials. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  if (!Object.hasOwn(env, 'INSTANCE_STATE_FILE') && !Object.hasOwn(env, 'INSTANCE_ID')) return loadLegacyConfig(env, cwd);
  try {
    const [{ readInstanceHost, classifyInstance }, { readInstance, InstanceBundleSchema }, { connectMongo }, { decryptInstanceSecret }] = await Promise.all([
      import('./instance/bootstrap'), import('./instance/store'), import('./mongo'), import('./instance/secrets'),
    ]);
    const host = await readInstanceHost(env, cwd);
    const storage = await connectMongo(host.config, { initializeLegacy: false });
    try {
      const control = await readInstance(storage.db, host.instanceId);
      if (control?.lifecycle === 'ready' && control.gate.state === 'open' && control.initializedAt && control.bootstrap.consumedAt &&
          host.marker.phase === 'initialized' && control.recoveryEpoch === host.marker.recoveryEpoch && control.active) {
        const active = InstanceBundleSchema.parse(control.active);
        const decrypt = (purpose: 'zitadelClientSecret' | 'githubPrivateKey' | 'githubWebhookSecret') => {
          const envelope = active.secrets[purpose];
          return decryptInstanceSecret(envelope, { instanceId: host.instanceId, purpose, credentialVersion: envelope.credentialVersion }, host.keyring);
        };
        const githubPrivateKey = decrypt('githubPrivateKey');
        try {
          const key = createPrivateKey(githubPrivateKey);
          if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
        } catch { throw new Error(); }
        return {
          ...host.config, ...instanceRuntimeConfig(active.runtime), authUrl: active.publicOrigin,
          zitadelClientId: active.zitadel.clientId, zitadelSecret: decrypt('zitadelClientSecret'),
          zitadelIssuer: active.zitadel.issuer, zitadelProjectId: active.zitadel.projectId, zitadelApiAudience: active.zitadel.audience,
          githubAppId: active.github.appId, githubPrivateKey, githubWebhookSecret: decrypt('githubWebhookSecret'),
        };
      }
      let legacy: Awaited<ReturnType<typeof loadLegacyConfig>> | undefined;
      try { legacy = await loadLegacyConfig(env, cwd); } catch { /* Legacy inputs are eligible only when every required value validates. */ }
      const state = classifyInstance({ marker: host.marker, record: control, legacyValid: !!legacy, empty: !control });
      if (legacy && (state === 'legacy' || state === 'legacy_migrating')) return { ...legacy, instanceKeyring: host.keyring };
      if (legacy && control?.migration && !control.initializedAt && control.gate.state !== 'maintenance' && ['configuring', 'awaiting_owner'].includes(state)) {
        return { ...legacy, instanceKeyring: host.keyring };
      }
      throw new Error('Instance setup is not ready.');
    } finally { await storage.client.close(); }
  } catch { throw new Error('Instance setup is not ready.'); }
}

/** Only the host database locator is authoritative for establishing the connection. */
export function instanceRuntimeConfig(runtime: import('zod').infer<typeof import('./instance/store').InstanceRuntimeSchema> | undefined) {
  if (!runtime) throw new Error('instance_configuration_incomplete');
  return { authSecret: runtime.authSecret, oauthTokenEncryptionKey: Buffer.from(runtime.oauthTokenEncryptionKey, 'base64'), trustHost: runtime.trustHost, workerEnabled: runtime.workerEnabled };
}

export function instanceRuntimeInputs(config: Awaited<ReturnType<typeof loadHostConfig>>, env: NodeJS.ProcessEnv = process.env) {
  return { authSecret: config.authSecret, oauthTokenEncryptionKey: config.oauthTokenEncryptionKey.toString('base64'),
    mongodbUri: config.mongodbUri, mongodbDatabase: config.mongodbDatabase, trustHost: config.trustHost, workerEnabled: (env.NODE_ENV === 'production' ? env.LIBRARIAN_WORKER_ENABLED !== '0' : env.LIBRARIAN_WORKER_ENABLED === '1') };
}
