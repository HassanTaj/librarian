import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { InstanceBundleSchema, INSTANCE_CHECK_CODES } from '../../lib/instance/store';
import { readyInstance } from '../fixtures/instance';
import { createPinnedFetch, createProviderCheckRunner, runtimeProviderFetch } from '../../lib/instance/validation';

type OutboundPolicy = { origins: Array<{ origin: string; addresses: string[] }> };
const policy: OutboundPolicy = { origins: [] };
const issuer = 'https://identity.example.test';
const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  token_endpoint_auth_methods_supported: ['client_secret_basic'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['openid', 'profile', 'email'],
};
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-kid', use: 'sig', alg: 'RS256' };
const credentials = {
  zitadelClientSecret: 'synthetic-client-secret',
  githubPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  githubWebhookSecret: 'synthetic-webhook-secret',
};

function body(value: unknown) { return Buffer.from(JSON.stringify(value)); }
function candidate(origin = issuer) {
  const value = readyInstance().active;
  if (!value) throw new Error('Synthetic instance candidate unavailable');
  value.zitadel.issuer = origin;
  return value;
}
function makeRunner(options: {
  addresses?: string[];
  policy?: OutboundPolicy;
  githubApiOrigin?: string;
  response?: (url: URL) => { statusCode: number; headers: Record<string, string>; body: Uint8Array };
  ownerLogin?: () => Promise<void>;
} = {}) {
  const lookup = vi.fn(async (hostname: string, lookupOptions: { timeoutMs: number }) => {
    void hostname;
    void lookupOptions;
    return options.addresses ?? ['8.8.8.8'];
  });
  const request = vi.fn(async (url: URL, requestOptions: {
    address: string; servername: string; rejectUnauthorized: true; redirect: 'manual';
    connectTimeoutMs: number; timeoutMs: number; maxBytes: number;
    method: string; headers: Record<string, string>;
  }) => {
    void requestOptions;
    return options.response?.(url) ?? (url.pathname.endsWith('/jwks')
      ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: body({ keys: [key] }) }
      : { statusCode: 200, headers: { 'content-type': 'application/json' }, body: body(discovery) });
  });
  const ownerLogin = vi.fn(options.ownerLogin ?? (async () => { throw new Error('synthetic_candidate_login_failed'); }));
  const runner = createProviderCheckRunner({ policy: options.policy ?? policy, githubApiOrigin: options.githubApiOrigin, lookup, request, ownerLogin });
  return { runner, lookup, request, ownerLogin };
}

it('keeps provider types and plain-text branding within the finite bundle schema', () => {
  const valid = candidate();
  expect(InstanceBundleSchema.parse(valid).github).toEqual({ provider: 'github', appId: '123' });
  expect(INSTANCE_CHECK_CODES).toContain('installation_missing');
  expect(INSTANCE_CHECK_CODES).toContain('delivery_unverified');

  for (const [path, value] of [
    ['github.provider', 'other'],
    ['github.appId', '0'],
    ['preferences.displayName', '<script>alert(1)</script>'],
    ['preferences.displayName', 'x'.repeat(121)],
    ['preferences.description', 'x'.repeat(501)],
    ['preferences.docsFolder', '../private'],
    ['preferences.docsFolder', 'docs\\private'],
  ] as const) {
    const invalid = structuredClone(valid);
    const [group, field] = path.split('.') as ['github' | 'preferences', string];
    (invalid[group] as Record<string, unknown>)[field] = value;
    expect(InstanceBundleSchema.safeParse(invalid).success, path).toBe(false);
  }

  for (const key of ['logoUrl', 'html', 'renderer', 'providerUrl']) {
    const invalid = structuredClone(valid) as unknown as Record<string, unknown>;
    invalid[key] = 'https://untrusted.example.test/asset';
    expect(InstanceBundleSchema.safeParse(invalid).success, key).toBe(false);
  }
});

it('rejects private, metadata, multicast, reserved and IPv4-mapped DNS answers before connecting', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.0.2.1', '224.0.0.1', '::1', 'fe80::1', '2001:1::4', '2001:db8::1', '5f00::1', '::ffff:127.0.0.1']) {
    const fixture = makeRunner({ addresses: [address] });
    const result = await fixture.runner.run('zitadel_discovery', candidate(), credentials);
    expect(result).toMatchObject({ type: 'zitadel_discovery', status: 'failed' });
    expect(fixture.request, address).not.toHaveBeenCalled();
  }
});

it('rejects a mixed public and private DNS answer instead of allowing rebinding', async () => {
  const fixture = makeRunner({ addresses: ['8.8.8.8', '127.0.0.1'] });
  const result = await fixture.runner.run('zitadel_discovery', candidate(), credentials);
  expect(result).toMatchObject({ type: 'zitadel_discovery', status: 'failed' });
  expect(fixture.request).not.toHaveBeenCalled();
});

it('uses a protected exact private exception and pins the connection while verifying the issuer hostname', async () => {
  const privateIssuer = 'https://identity.private.test';
  const fixture = makeRunner({ addresses: ['10.20.30.40'], policy: { origins: [{ origin: privateIssuer, addresses: ['10.20.30.40'] }] },
    response: url => url.pathname.endsWith('/jwks')
      ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: body({ keys: [key] }) }
      : { statusCode: 200, headers: { 'content-type': 'application/json' }, body: body({ ...discovery, issuer: privateIssuer,
        authorization_endpoint: `${privateIssuer}/authorize`, token_endpoint: `${privateIssuer}/token`, jwks_uri: `${privateIssuer}/jwks` }) },
  });

  const result = await fixture.runner.run('zitadel_discovery', candidate(privateIssuer), credentials);
  expect(result).toMatchObject({ type: 'zitadel_discovery', status: 'passed' });
  expect(fixture.request).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ address: '10.20.30.40',
    servername: 'identity.private.test', rejectUnauthorized: true, redirect: 'manual' }));
});

it('uses the same pinned policy for Auth.js fetches and leaves redirects for the caller to reject', async () => {
  const privateIssuer = 'https://identity.private.test';
  const lookup = vi.fn(async (hostname: string) => hostname === 'identity.private.test' ? ['10.20.30.40'] : ['8.8.8.8']);
  const ca = { origin: privateIssuer, certificate: Buffer.from('synthetic-provider-ca') };
  const request = vi.fn(async () => ({ statusCode: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' }, body: Buffer.alloc(0) }));
  const fetcher = createPinnedFetch({ policy: { origins: [{ origin: privateIssuer, addresses: ['10.20.30.40'] }] }, lookup, request, ca });
  const response = await fetcher(`${privateIssuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: 'synthetic' }), redirect: 'manual' });

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('https://169.254.169.254/latest/meta-data/');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ address: '10.20.30.40', servername: 'identity.private.test',
    rejectUnauthorized: true, method: 'POST', maxBytes: 512 * 1024, ca: ca.certificate }));

  await fetcher('https://public.example.test/token', { redirect: 'manual' });
  expect(request).toHaveBeenLastCalledWith(expect.any(URL), expect.objectContaining({ address: '8.8.8.8', rejectUnauthorized: true, ca: undefined }));

  const deniedRequest = vi.fn();
  const denied = createPinnedFetch({ policy: { origins: [] }, lookup: async () => ['127.0.0.1'], request: deniedRequest });
  await expect(denied('https://identity.private.test/token', { method: 'POST' })).rejects.toThrow('provider_unavailable');
  expect(deniedRequest).not.toHaveBeenCalled();
});

it('leaves the host fetch untouched before instance mode and validates pinned-fetch budgets and DNS policy', async () => {
  const instanceId = process.env.INSTANCE_ID; const stateFile = process.env.INSTANCE_STATE_FILE;
  delete process.env.INSTANCE_ID; delete process.env.INSTANCE_STATE_FILE;
  try { expect(await runtimeProviderFetch(issuer)).toBe(fetch); }
  finally {
    if (instanceId === undefined) delete process.env.INSTANCE_ID; else process.env.INSTANCE_ID = instanceId;
    if (stateFile === undefined) delete process.env.INSTANCE_STATE_FILE; else process.env.INSTANCE_STATE_FILE = stateFile;
  }
  for (const maxBytes of [0, -1, 7_000_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => createPinnedFetch({ policy, maxBytes })).toThrow('invalid_configuration');
  }
  const mismatchedPolicy = createPinnedFetch({ policy: { origins: [{ origin: issuer, addresses: ['1.1.1.1'] }] },
    lookup: async () => ['8.8.8.8'], request: vi.fn() });
  await expect(mismatchedPolicy(`${issuer}/token`)).rejects.toThrow('provider_unavailable');
  const noAddresses = createPinnedFetch({ policy, lookup: async () => [], request: vi.fn() });
  await expect(noAddresses(`${issuer}/token`)).rejects.toThrow('provider_unavailable');
});

it('returns an empty body for 304 and propagates timeout versus unavailable provider errors', async () => {
  const request = vi.fn(async () => ({ statusCode: 304, headers: { etag: 'synthetic-tag' }, body: Buffer.alloc(0) }));
  const fetcher = createPinnedFetch({ policy, lookup: async () => ['8.8.8.8'], request });
  const response = await fetcher(`${issuer}/token`);
  expect(response.status).toBe(304); expect(await response.text()).toBe('');
  expect(request).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ body: undefined, method: 'GET' }));
  const timeout = makeRunner({});
  const deadlineFailure = createProviderCheckRunner({ policy, lookup: async () => { throw new Error('request_timeout'); } });
  expect(await deadlineFailure.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'request_timeout' });
  expect(await timeout.runner.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'passed', code: 'provider_ok' });
  const unavailable = createProviderCheckRunner({ policy, lookup: async () => { throw new Error('synthetic_dns_failure'); } });
  expect(await unavailable.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'provider_unavailable' });
});

it('uses a localhost-only GitHub API origin for controlled development fixtures', async () => {
  const githubApiOrigin = 'https://localhost:8443';
  const fixture = makeRunner({ addresses: ['127.0.0.1'], githubApiOrigin,
    policy: { origins: [{ origin: githubApiOrigin, addresses: ['127.0.0.1'] }] },
    response: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: body({ id: 12345, permissions: { contents: 'read', metadata: 'read' } }) }),
  });
  const result = await fixture.runner.run('github_permissions', candidate(), credentials);
  expect(result).toMatchObject({ type: 'github_permissions', status: 'passed', code: 'provider_ok' });
  expect(fixture.request).toHaveBeenCalledWith(new URL(`${githubApiOrigin}/app`), expect.objectContaining({
    address: '127.0.0.1', servername: 'localhost', rejectUnauthorized: true, redirect: 'manual',
  }));
  expect(() => createProviderCheckRunner({ policy, githubApiOrigin: 'https://github.example.test' })).toThrow('invalid_configuration');
});

it('bounds DNS, connection, response and JWKS reads and rejects redirects without following them', async () => {
  const tooLarge = makeRunner({ response: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.alloc(512 * 1024 + 1) }) });
  const oversizedResult = await tooLarge.runner.run('zitadel_discovery', candidate(), credentials);
  expect(oversizedResult).toMatchObject({ type: 'zitadel_discovery', status: 'failed' });
  expect(tooLarge.lookup).toHaveBeenCalledWith('identity.example.test', expect.objectContaining({ timeoutMs: 5_000 }));
  expect(tooLarge.request).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ timeoutMs: 10_000, maxBytes: 512 * 1024,
    connectTimeoutMs: 5_000, rejectUnauthorized: true, redirect: 'manual' }));

  const manyJwksKeys = body({ keys: Array.from({ length: 1_025 }, () => key) });
  expect(manyJwksKeys.byteLength).toBeLessThan(512 * 1024);
  const hugeJwks = makeRunner({ response: url => url.pathname.endsWith('/jwks')
    ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: manyJwksKeys }
    : { statusCode: 200, headers: { 'content-type': 'application/json' }, body: body(discovery) },
  });
  expect(await hugeJwks.runner.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed' });
  expect(hugeJwks.request).toHaveBeenCalledTimes(2);

  const redirected = makeRunner({ response: () => ({ statusCode: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' }, body: Buffer.alloc(0) }) });
  expect(await redirected.runner.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed' });
  expect(redirected.request).toHaveBeenCalledTimes(1);
});

it('blocks every configured private and reserved address range, including mapped IPv4 in IPv6', async () => {
  for (const address of [
    '0.0.0.1', '100.64.0.1', '172.16.0.1', '192.0.0.1', '192.88.99.1', '192.168.0.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '240.0.0.1', '2001::1', '2002::1', '3fff::1',
  ]) {
    const fixture = makeRunner({ addresses: [address] });
    expect(await fixture.runner.run('zitadel_discovery', candidate(), credentials), address).toMatchObject({ status: 'failed' });
    expect(fixture.request, address).not.toHaveBeenCalled();
  }
  const empty = makeRunner({ addresses: [] });
  expect(await empty.runner.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'provider_unavailable' });
  expect(empty.request).not.toHaveBeenCalled();
});

it('handles Request, URL and binary fetch bodies while rejecting redirects and oversized or unsupported bodies', async () => {
  const sent: Array<{ method: string; headers: Record<string, string>; body?: Uint8Array }> = [];
  const fetcher = createPinnedFetch({ policy, lookup: async () => ['8.8.8.8'], request: async (_url, options) => {
    sent.push({ method: options.method, headers: options.headers, body: options.body });
    return { statusCode: 204, statusText: 'No Content', headers: { 'x-provider': 'synthetic' }, body: new Uint8Array() };
  } });
  const source = new Request('https://identity.example.test/token', { method: 'POST', headers: { 'x-source': 'request' }, body: 'source-body' });
  const fromRequest = await fetcher(source);
  expect(fromRequest.status).toBe(204);
  expect(await fromRequest.text()).toBe('');
  expect(sent[0]).toMatchObject({ method: 'POST', headers: { 'x-source': 'request' }, body: Buffer.from('source-body') });

  await fetcher(new URL('https://identity.example.test/token'), { method: 'PUT', body: new Uint8Array([1, 2]) });
  await fetcher('https://identity.example.test/token', { method: 'POST', body: new ArrayBuffer(2) });
  await fetcher('https://identity.example.test/token', { method: 'POST', body: new DataView(new Uint8Array([1, 2]).buffer) });
  expect(sent.slice(1).map(item => item.body?.byteLength)).toEqual([2, 2, 2]);
  await expect(fetcher('https://identity.example.test/token', { redirect: 'follow' })).rejects.toThrow('invalid_configuration');
  await expect(fetcher('https://identity.example.test/token', { method: 'POST', body: new Uint8Array(64 * 1024 + 1) })).rejects.toThrow('response_invalid');
  await expect(fetcher('https://identity.example.test/token', { method: 'POST', body: {} as BodyInit })).rejects.toThrow('provider_unavailable');
  expect(sent).toHaveLength(4);
});

it('rejects invalid discovery responses, unsupported endpoints and unusable JWKS keys with typed results', async () => {
  const discoveryFailures: Array<{ value: unknown; code: string }> = [
    { value: { ...discovery, issuer: 'https://other.example.test' }, code: 'response_invalid' },
    { value: { ...discovery, response_types_supported: ['token'] }, code: 'response_invalid' },
    { value: { ...discovery, subject_types_supported: ['pairwise'] }, code: 'response_invalid' },
    { value: { ...discovery, id_token_signing_alg_values_supported: ['ES256'] }, code: 'response_invalid' },
    { value: { ...discovery, token_endpoint_auth_methods_supported: ['none'] }, code: 'response_invalid' },
    { value: { ...discovery, code_challenge_methods_supported: ['plain'] }, code: 'response_invalid' },
    { value: { ...discovery, authorization_endpoint: 'http://identity.example.test/authorize' }, code: 'response_invalid' },
    { value: { ...discovery, jwks_uri: 'https://user:pass@identity.example.test/jwks' }, code: 'response_invalid' },
  ];
  for (const item of discoveryFailures) {
    const fixture = makeRunner({ response: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: body(item.value) }) });
    expect(await fixture.runner.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed', code: item.code });
  }

  const badResponses = [
    { statusCode: 429, headers: { 'content-type': 'application/json' }, body: body({}) },
    { statusCode: 503, headers: { 'content-type': 'application/json' }, body: body({}) },
    { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: body(discovery) },
    { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from([0xff]) },
    { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"issuer":"one","issuer":"two"}') },
  ];
  const badCodes = ['rate_limited', 'provider_unavailable', 'response_invalid', 'response_invalid', 'response_invalid'];
  for (const [index, response] of badResponses.entries()) {
    const fixture = makeRunner({ response: () => response });
    expect(await fixture.runner.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed', code: badCodes[index] });
  }

  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
  const unusableKeys = [null, {}, { ...key, use: 'enc' }, { ...key, alg: 'HS256' }, { ...key, kid: '' }, { kty: 'RSA', kid: 'bad', n: 'x', e: 'x' }, weak];
  for (const unusable of unusableKeys) {
    const fixture = makeRunner({ response: url => url.pathname.endsWith('/jwks')
      ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: body({ keys: [unusable] }) }
      : { statusCode: 200, headers: { 'content-type': 'application/json' }, body: body(discovery) },
    });
    expect(await fixture.runner.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'response_invalid' });
  }
});

it('checks the read-only GitHub App paths and rejects incomplete provider credentials', async () => {
  const app = makeRunner({ response: url => url.pathname === '/app/installations'
    ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: body([{ id: 10 }]) }
    : { statusCode: 200, headers: { 'content-type': 'application/json' }, body: body({ permissions: { contents: 'read', metadata: 'read', issues: 'none' } }) },
  });
  for (const type of ['github_structure', 'github_authentication', 'github_permissions', 'github_installation'] as const) {
    expect(await app.runner.run(type, candidate(), credentials)).toMatchObject({ type, status: 'passed', code: 'provider_ok' });
  }

  const broadPermissions = makeRunner({ response: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' },
    body: body({ permissions: { contents: 'read', metadata: 'read', issues: 'write' } }) }) });
  expect(await broadPermissions.runner.run('github_permissions', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'permission_denied' });

  const invalidApp = candidate();
  invalidApp.github.appId = '0';
  expect(await makeRunner().runner.run('github_authentication', invalidApp, credentials)).toMatchObject({ status: 'failed', code: 'invalid_configuration' });
  expect(await makeRunner().runner.run('github_structure', candidate(), { githubPrivateKey: '' })).toMatchObject({ status: 'failed', code: 'invalid_configuration' });

  const emptyInstallations = makeRunner({ response: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: body([]) }) });
  expect(await emptyInstallations.runner.run('github_installation', candidate(), credentials)).toMatchObject({ status: 'warning', code: 'installation_missing' });
  const webhook = makeRunner();
  expect(await webhook.runner.run('github_webhook', candidate(), credentials)).toMatchObject({ status: 'warning', code: 'delivery_unverified' });
  expect(webhook.lookup).not.toHaveBeenCalled(); expect(webhook.request).not.toHaveBeenCalled();
  const missingPermissions = makeRunner({ response: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: body({ permissions: { contents: 'read' } }) }) });
  expect(await missingPermissions.runner.run('github_permissions', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'permission_denied' });
  const unsafeApp = candidate(); unsafeApp.github.appId = '9007199254740992';
  expect(await makeRunner().runner.run('github_authentication', unsafeApp, credentials)).toMatchObject({ status: 'failed', code: 'invalid_configuration' });

  const missingOwnerFlow = createProviderCheckRunner({ policy, lookup: async () => ['8.8.8.8'] });
  expect(await missingOwnerFlow.run('zitadel_owner_login', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'invalid_configuration' });
  const successfulOwner = makeRunner({ ownerLogin: async () => undefined });
  expect(await successfulOwner.runner.run('zitadel_owner_login', candidate(), credentials)).toMatchObject({ status: 'passed', code: 'provider_ok' });
  expect(() => createProviderCheckRunner({ policy, githubApiOrigin: 'http://localhost:8443' })).toThrow('invalid_configuration');
});

it('allows only one provider check in progress for a candidate', async () => {
  let finishLogin!: () => void;
  const ownerLogin = vi.fn(() => new Promise<void>(resolve => { finishLogin = resolve; }));
  const fixture = makeRunner({ ownerLogin });
  const draft = candidate();
  const first = fixture.runner.run('zitadel_owner_login', draft, credentials);
  const concurrent = await fixture.runner.run('zitadel_discovery', draft, credentials);

  expect(concurrent).toMatchObject({ type: 'zitadel_discovery', candidateVersion: draft.version, status: 'failed', code: 'rate_limited' });
  finishLogin();
  expect(await first).toMatchObject({ type: 'zitadel_owner_login', status: 'passed' });
});

it('fails closed on malformed discovery shapes, endpoints, signing keys and provider permission documents', async () => {
  const invalidMetadata: unknown[] = [null, [], 42, { ...discovery, authorization_endpoint: 42 },
    { ...discovery, token_endpoint: 'not a URL' }, { ...discovery, jwks_uri: `${issuer}/jwks#fragment` }];
  for (const field of ['response_types_supported', 'subject_types_supported', 'id_token_signing_alg_values_supported',
    'token_endpoint_auth_methods_supported', 'code_challenge_methods_supported']) invalidMetadata.push({ ...discovery, [field]: null });
  for (const value of invalidMetadata) {
    expect(await makeRunner({ response: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: body(value) }) })
      .runner.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'response_invalid' });
  }
  for (const value of [null, [], {}, { keys: {} }, { keys: [] }, { keys: [{ kty: 'RSA', kid: 'malformed', e: {} }] }]) {
    const fixture = makeRunner({ response: url => ({ statusCode: 200, headers: { 'content-type': 'application/json' },
      body: body(url.pathname.endsWith('/jwks') ? value : discovery) }) });
    expect(await fixture.runner.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'response_invalid' });
  }
  for (const value of [null, [], { permissions: null }, { permissions: [] }]) {
    const fixture = makeRunner({ response: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: body(value) }) });
    expect(await fixture.runner.run('github_permissions', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'response_invalid' });
    if (!Array.isArray(value)) expect(await fixture.runner.run('github_installation', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'response_invalid' });
  }
  for (const privateKey of [generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey]) {
    expect(await makeRunner().runner.run('github_structure', candidate(), { githubPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }))
      .toMatchObject({ status: 'failed', code: 'invalid_configuration' });
  }
  for (const issuer of ['', 'invalid', 'http://identity.example.test', 'https://identity.example.test/path']) {
    expect(await makeRunner().runner.run('zitadel_discovery', candidate(issuer), credentials)).toMatchObject({ status: 'failed', code: 'invalid_configuration' });
  }
  const mismatched = makeRunner({ policy: { origins: [{ origin: issuer, addresses: ['8.8.4.4'] }] } });
  expect(await mismatched.runner.run('zitadel_discovery', candidate(), credentials)).toMatchObject({ status: 'failed', code: 'provider_unavailable' });
  expect(mismatched.request).not.toHaveBeenCalled();
});

it('enforces the provider workflow deadline even when DNS or owner login never settles', async () => {
  vi.useFakeTimers();
  try {
    const lookup = () => new Promise<string[]>(() => undefined);
    const runner = createProviderCheckRunner({ policy, lookup });
    const check = runner.run('zitadel_discovery', candidate(), credentials);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await check).toMatchObject({ status: 'failed', code: 'request_timeout' });
    const login = makeRunner({ ownerLogin: () => new Promise<void>(() => undefined) }).runner.run('zitadel_owner_login', candidate(), credentials);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await login).toMatchObject({ status: 'failed', code: 'request_timeout' });
    const pinned = createPinnedFetch({ policy, lookup });
    const request = expect(pinned(`${issuer}/token`)).rejects.toThrow('request_timeout');
    await vi.advanceTimersByTimeAsync(30_000); await request;
  } finally { vi.useRealTimers(); }
});

it('rejects unsafe fetch URLs and an oversized injected response before returning any provider bytes', async () => {
  const request = vi.fn(async () => ({ statusCode: 200, headers: {}, body: Buffer.from('too large') }));
  const pinned = createPinnedFetch({ policy, lookup: async () => ['8.8.8.8'], request, maxBytes: 1 });
  for (const url of ['http://identity.example.test', 'https://user:password@identity.example.test', `${issuer}/token#fragment`]) {
    await expect(pinned(url)).rejects.toThrow('invalid_configuration');
  }
  expect(request).not.toHaveBeenCalled();
  await expect(pinned(`${issuer}/token`)).rejects.toThrow('response_invalid');
});
