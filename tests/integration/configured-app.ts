import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startNextHarness } from './http-harness';

export async function startConfiguredApp(storage: { root: string; contentRoot: string; db: { databaseName: string } }, port: number) {
  const secrets = join(storage.root, 'synthetic-secrets');
  await mkdir(secrets, { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const files = {
    auth: randomBytes(32).toString('base64url'), oidc: randomBytes(32).toString('base64url'),
    mongo: `mongodb://127.0.0.1:27018/${storage.db.databaseName}`,
    github: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), webhook: randomBytes(32).toString('hex'),
    encryption: randomBytes(32).toString('base64'),
  };
  const paths: Record<keyof typeof files, string> = Object.fromEntries(Object.keys(files).map(key => [key, join(secrets, `${key}.secret`)])) as Record<keyof typeof files, string>;
  await Promise.all(Object.entries(files).map(([key, value]) => writeFile(paths[key as keyof typeof files], value, { mode: 0o600 })));
  const settings = {
    AUTH_URL: 'https://portal.synthetic.invalid', AUTH_TRUST_HOST: 'true', AUTH_ZITADEL_ID: 'synthetic-client',
    AUTH_ZITADEL_ISSUER: 'https://identity.synthetic.invalid', ZITADEL_PROJECT_ID: 'synthetic-project', ZITADEL_API_AUDIENCE: 'synthetic-api',
    MONGODB_DATABASE: storage.db.databaseName, GITHUB_APP_ID: '12345', CONTENT_ROOT: storage.contentRoot,
    AUTH_SECRET_FILE: paths.auth, AUTH_ZITADEL_SECRET_FILE: paths.oidc, MONGODB_URI_FILE: paths.mongo,
    GITHUB_APP_PRIVATE_KEY_FILE: paths.github, GITHUB_WEBHOOK_SECRET_FILE: paths.webhook, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: paths.encryption,
  };
  return startNextHarness({ appRoot: process.cwd(), port, env: settings });
}
