import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createInstanceHarness } from './instance-harness';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { initializeInstance, readInstance, updateInstance } from '../../lib/instance/store';
import { createProviderCheckRunner } from '../../lib/instance/validation';
import { encryptInstanceSecret } from '../../lib/instance/secrets';

const setupOrigin = 'https://setup.example.test';
const issuer = 'https://identity.example.test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signingKey = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-kid', use: 'sig', alg: 'RS256' };

function json(value: unknown) { return Buffer.from(JSON.stringify(value)); }

function providerRunner(options: {
  response?: (url: URL) => { statusCode: number; headers: Record<string, string>; body: Uint8Array };
  ownerLogin?: () => Promise<void>;
} = {}) {
  const lookup = async (hostname: string, lookupOptions: { timeoutMs: number }) => {
    void hostname;
    void lookupOptions;
    return ['8.8.8.8'];
  };
  const request = async (url: URL, requestOptions: Record<string, unknown>) => {
    void requestOptions;
    return options.response?.(url) ?? (url.pathname.endsWith('/jwks')
    ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: json({ keys: [signingKey] }) }
    : url.pathname === '/app/installations'
      ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: json([]) }
      : url.pathname === '/app'
        ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: json({ permissions: { contents: 'read', metadata: 'read' } }) }
        : { statusCode: 200, headers: { 'content-type': 'application/json' }, body: json({
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'profile', 'email'],
        }) });
  };
  const ownerLogin = options.ownerLogin ?? (async () => { throw new Error('synthetic_login_rejected'); });
  return createProviderCheckRunner({ policy: { origins: [] }, lookup, request, ownerLogin });
}

function validationCandidate() {
  const value = readyInstance().active;
  if (!value) throw new Error('Synthetic provider candidate unavailable');
  value.zitadel.issuer = issuer;
  return value;
}

const providerCredentials = {
  zitadelClientSecret: 'synthetic-client-secret',
  githubPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  githubWebhookSecret: 'synthetic-webhook-secret',
};

it('keeps discovery success separate from a failed candidate login', async () => {
  const ownerLogin = async () => { throw new Error('synthetic_login_rejected'); };
  const runner = providerRunner({ ownerLogin });
  const candidate = validationCandidate();
  const discovery = await runner.run('zitadel_discovery', candidate, providerCredentials);
  const login = await runner.run('zitadel_owner_login', candidate, providerCredentials);

  expect(discovery).toMatchObject({ type: 'zitadel_discovery', candidateVersion: candidate.version, status: 'passed' });
  expect(login).toMatchObject({ type: 'zitadel_owner_login', candidateVersion: candidate.version, status: 'failed', code: 'authentication_failed' });
  expect(JSON.stringify(login)).not.toContain('synthetic_login_rejected');
});

it('reports invalid RSA, insufficient App permissions, missing installation and unverified delivery distinctly', async () => {
  const candidate = validationCandidate();
  const invalidKeyRunner = providerRunner();
  const invalidKey = await invalidKeyRunner.run('github_structure', candidate, { ...providerCredentials, githubPrivateKey: 'not an RSA private key' });
  expect(invalidKey).toMatchObject({ type: 'github_structure', status: 'failed', code: 'invalid_configuration' });

  const deniedRunner = providerRunner({ response: url => url.pathname === '/app'
    ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: json({ permissions: { contents: 'write', metadata: 'read' } }) }
    : { statusCode: 200, headers: { 'content-type': 'application/json' }, body: json([]) },
  });
  const permissions = await deniedRunner.run('github_permissions', candidate, providerCredentials);
  expect(permissions).toMatchObject({ type: 'github_permissions', status: 'failed', code: 'permission_denied' });

  const missingInstall = await providerRunner().run('github_installation', candidate, providerCredentials);
  expect(missingInstall).toMatchObject({ type: 'github_installation', status: 'warning', code: 'installation_missing' });
  const delivery = await providerRunner().run('github_webhook', candidate, providerCredentials);
  expect(delivery).toMatchObject({ type: 'github_webhook', status: 'warning', code: 'delivery_unverified' });
});

async function createSetupSession(port: number, issuer: string) {
  const fixture = await createInstanceHarness({ port });
  try {
    fixture.env.INSTANCE_SETUP_ORIGIN = setupOrigin;
    const policyPath = fixture.env.INSTANCE_OUTBOUND_POLICY_FILE!;
    const operator = JSON.parse(await readFile(fixture.env.INSTANCE_OPERATOR_AUTH_FILE!, 'utf8')) as { credential: string; expiresAt: string };
    const now = new Date();
    const control = instanceControl(fixture.instanceId, now);
    control.bootstrap.verifierHash = createHash('sha256').update(operator.credential).digest('hex');
    control.bootstrap.expiresAt = new Date(operator.expiresAt);
    control.nextBundleVersion = 2;
    const candidate = structuredClone(readyInstance(fixture.instanceId, now).active);
    if (!candidate) throw new Error('Synthetic candidate unavailable');
    candidate.createdBy = 'synthetic-operator';
    candidate.publicOrigin = setupOrigin;
    candidate.zitadel.issuer = issuer;
    candidate.ownerProof = null;
    candidate.checks = [];
    candidate.impact = null;
    control.candidate = candidate;
    control.updatedAt = now;
    await writeFile(fixture.env.INSTANCE_KEYRING_FILE!, JSON.stringify({ activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1).toString('base64') } }));
    await writeFile(policyPath, JSON.stringify({ origins: [] }));
    await initializeInstance(fixture.storage.db, control);
    await writeFile(fixture.env.INSTANCE_STATE_FILE!, JSON.stringify({ instanceId: fixture.instanceId, phase: 'sealed', recoveryEpoch: 1 }));

    const server = await fixture.start();
    const status = await fetch(`${server.origin}/api/instance/status`);
    const preSessionCookie = status.headers.get('set-cookie')?.split(';', 1)[0];
    if (!preSessionCookie) throw new Error('Synthetic pre-session cookie unavailable');
    const authorized = await fetch(`${server.origin}/api/instance/setup/authorize`, { method: 'POST', headers: {
      'content-type': 'application/json', origin: setupOrigin, cookie: preSessionCookie, 'x-csrf-token': preSessionCookie.split('=', 2)[1],
    }, body: JSON.stringify({ credential: operator.credential }) });
    if (authorized.status !== 200) throw new Error('Synthetic setup authorization failed');
    const setupCookie = authorized.headers.get('set-cookie')?.match(/(?:^|,\s*)(__Host-librarian_setup=[^;,]+)/)?.[1];
    if (!setupCookie) throw new Error('Synthetic setup session cookie unavailable');
    const session = await authorized.json() as { csrfToken: string };
    const draft = await fetch(`${server.origin}/api/instance/setup`, { headers: {
      origin: setupOrigin, cookie: setupCookie, 'x-csrf-token': session.csrfToken,
    } });
    const etag = draft.headers.get('etag');
    if (!etag) throw new Error('Synthetic candidate revision unavailable');
    return {
      fixture, server, setupCookie, csrf: session.csrfToken,
      etag,
      headers(extra: Record<string, string> = {}) {
        return { origin: setupOrigin, cookie: setupCookie, 'x-csrf-token': session.csrfToken, ...extra };
      },
      async close() { await fixture.close(); },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

it('returns a typed safe failure for a loopback issuer without opening a connection', async () => {
  let connections = 0;
  const trap = createServer(socket => { connections++; socket.destroy(); });
  trap.listen(0, '127.0.0.1');
  await once(trap, 'listening');
  const address = trap.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic network trap unavailable');
  const setup = await createSetupSession(3201, `https://127.0.0.1:${address.port}`);
  try {
    const response = await fetch(`${setup.server.origin}/api/instance/setup/check`, { method: 'POST', headers: setup.headers({ 'content-type': 'application/json', 'if-match': setup.etag }),
      body: JSON.stringify({ candidateVersion: 1, type: 'zitadel_discovery' }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ candidateVersion: 1, type: 'zitadel_discovery', status: 'failed' });
    expect(['invalid_configuration', 'provider_unavailable', 'response_invalid']).toContain(result.code);
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    expect(connections).toBe(0);
  } finally {
    await setup.close();
    await new Promise<void>(resolve => trap.close(() => resolve()));
  }
});

it('reports owner login and webhook checks as unperformed until their proof flows complete', async () => {
  const setup = await createSetupSession(3208, issuer);
  try {
    const check = (type: 'zitadel_owner_login' | 'github_webhook') => fetch(`${setup.server.origin}/api/instance/setup/check`, { method: 'POST', headers: setup.headers({
      'content-type': 'application/json', 'if-match': setup.etag,
    }), body: JSON.stringify({ candidateVersion: 1, type }) });
    const owner = await check('zitadel_owner_login');
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ type: 'zitadel_owner_login', candidateVersion: 1, status: 'not_run', code: 'not_run' });
    const webhook = await check('github_webhook');
    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toMatchObject({ type: 'github_webhook', candidateVersion: 1, status: 'warning', code: 'delivery_unverified' });
  } finally { await setup.close(); }
});

it('decrypts only configured encrypted provider keys for checks and handles missing or damaged envelopes safely', async () => {
  const setup = await createSetupSession(3212, issuer);
  try {
    const keyring = { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } };
    const privateKey = createPrivateKeyForFixture();
    const makeEnvelope = (keys: typeof keyring) => encryptInstanceSecret(privateKey,
      { instanceId: setup.fixture.instanceId, purpose: 'githubPrivateKey', credentialVersion: randomUUID() }, keys);
    const saveKey = async (envelope: ReturnType<typeof makeEnvelope> | null) => {
      const current = await readInstance(setup.fixture.storage.db, setup.fixture.instanceId);
      if (!current?.candidate) throw new Error('Synthetic candidate unavailable');
      await updateInstance(setup.fixture.storage.db, setup.fixture.instanceId, current.revision, control => ({ ...control,
        candidate: { ...control.candidate!, secrets: { ...control.candidate!.secrets, githubPrivateKey: envelope } },
      }), new Date(current.updatedAt.getTime() + 1));
    };
    const check = async () => {
      const snapshot = await fetch(`${setup.server.origin}/api/instance/setup`, { headers: { cookie: setup.setupCookie } });
      return fetch(`${setup.server.origin}/api/instance/setup/check`, { method: 'POST', headers: setup.headers({
        'content-type': 'application/json', 'if-match': snapshot.headers.get('etag')!,
      }), body: JSON.stringify({ candidateVersion: 1, type: 'github_structure' }) });
    };

    await saveKey(makeEnvelope(keyring));
    expect(await (await check()).json()).toMatchObject({ type: 'github_structure', status: 'passed', code: 'provider_ok' });
    await saveKey(null);
    expect(await (await check()).json()).toMatchObject({ type: 'github_structure', status: 'failed', code: 'invalid_configuration' });
    await saveKey(makeEnvelope({ activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 2) } }));
    expect(await (await check()).json()).toMatchObject({ type: 'github_structure', status: 'failed', code: 'invalid_configuration' });
  } finally { await setup.close(); }
});

function createPrivateKeyForFixture() {
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}
