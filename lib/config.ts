import { readFile, realpath, stat } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { MongoClient } from 'mongodb';
import { LIMITS } from './limits';

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
  AUTH_SECRET_FILE: z.string().min(1),
  AUTH_ZITADEL_SECRET_FILE: z.string().min(1),
  MONGODB_URI_FILE: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY_FILE: z.string().min(1),
  GITHUB_WEBHOOK_SECRET_FILE: z.string().min(1),
  OAUTH_TOKEN_ENCRYPTION_KEY_FILE: z.string().min(1),
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

/** Load only at server runtime; imports and production builds need no credentials. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) fail(parsed.error.issues.map(issue => issue.path.join('.')).join(', '));
  const settings = parsed.data;
  const authUrl = safeUrl(settings.AUTH_URL, 'AUTH_URL', env.NODE_ENV !== 'production');
  if (authUrl.pathname !== '/') fail('AUTH_URL');
  const issuer = safeUrl(settings.AUTH_ZITADEL_ISSUER, 'AUTH_ZITADEL_ISSUER');
  if (issuer.pathname !== '/') fail('AUTH_ZITADEL_ISSUER');

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

  async function secret(setting: 'AUTH_SECRET_FILE' | 'AUTH_ZITADEL_SECRET_FILE' | 'MONGODB_URI_FILE' |
    'GITHUB_APP_PRIVATE_KEY_FILE' | 'GITHUB_WEBHOOK_SECRET_FILE' | 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE') {
    try {
      const path = resolve(cwd, settings[setting]);
      const info = await stat(path);
      if (!info.isFile() || info.size > 64 * 1024) fail(setting);
      const value = (await readFile(path, 'utf8')).trim();
      if (!value || Buffer.byteLength(value) > 64 * 1024) fail(setting);
      return value;
    } catch { fail(setting); }
  }

  const authSecret = await secret('AUTH_SECRET_FILE');
  if (Buffer.byteLength(authSecret) < 32) fail('AUTH_SECRET_FILE');
  const zitadelSecret = await secret('AUTH_ZITADEL_SECRET_FILE');
  const mongodbUri = await secret('MONGODB_URI_FILE');
  try {
    const client = new MongoClient(mongodbUri);
    const path = mongodbUri.replace(/^mongodb(?:\+srv)?:\/\/[^/]+/, '').split('?')[0];
    if (mongodbUri.includes('#') || (path && path !== '/' && client.options.dbName !== settings.MONGODB_DATABASE)) fail('MONGODB_URI_FILE');
  } catch { fail('MONGODB_URI_FILE'); }
  const githubPrivateKey = await secret('GITHUB_APP_PRIVATE_KEY_FILE');
  try {
    if (createPrivateKey(githubPrivateKey).asymmetricKeyType !== 'rsa') fail('GITHUB_APP_PRIVATE_KEY_FILE');
  } catch { fail('GITHUB_APP_PRIVATE_KEY_FILE'); }
  const githubWebhookSecret = await secret('GITHUB_WEBHOOK_SECRET_FILE');
  if (Buffer.byteLength(githubWebhookSecret) < 32) fail('GITHUB_WEBHOOK_SECRET_FILE');
  const encryptionSecret = await secret('OAUTH_TOKEN_ENCRYPTION_KEY_FILE');
  const oauthTokenEncryptionKey = Buffer.from(encryptionSecret, 'base64');
  if (oauthTokenEncryptionKey.length !== 32 || oauthTokenEncryptionKey.toString('base64') !== encryptionSecret) {
    fail('OAUTH_TOKEN_ENCRYPTION_KEY_FILE');
  }
  return {
    authUrl: authUrl.origin, trustHost: settings.AUTH_TRUST_HOST === 'true', authSecret,
    zitadelClientId: settings.AUTH_ZITADEL_ID, zitadelSecret, zitadelIssuer: issuer.origin,
    zitadelProjectId: settings.ZITADEL_PROJECT_ID, zitadelApiAudience: settings.ZITADEL_API_AUDIENCE,
    mongodbUri, mongodbDatabase: settings.MONGODB_DATABASE,
    githubAppId: settings.GITHUB_APP_ID, githubPrivateKey, githubWebhookSecret,
    oauthTokenEncryptionKey, contentRoot, publicCatalogApprovalsFile,
  };
}
