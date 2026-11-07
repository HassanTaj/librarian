import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { createServerAuth } from '../../auth';

const state = vi.hoisted(() => ({ config: vi.fn(), mongo: vi.fn(), providerFetch: vi.fn() }));
vi.mock('../../lib/config', () => ({ loadConfig: state.config }));
vi.mock('../../lib/mongo', () => ({ getMongo: state.mongo }));
vi.mock('../../lib/auth/adapter', () => ({ createLibrarianAdapter: async () => ({
  createUser: vi.fn(), getUser: vi.fn(), getUserByEmail: vi.fn(), getUserByAccount: vi.fn(), updateUser: vi.fn(), linkAccount: vi.fn(),
  createSession: vi.fn(), getSessionAndUser: vi.fn(), updateSession: vi.fn(), deleteSession: vi.fn(),
}), persistOAuthSignInTokens: vi.fn() }));
vi.mock('../../lib/instance/validation', () => ({ runtimeProviderFetch: async () => state.providerFetch }));

const origin = 'https://portal.example.test';
const issuer = 'https://identity.example.test';
let config: Parameters<typeof createServerAuth>[0];

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('INSTANCE_ID', ''); vi.stubEnv('INSTANCE_STATE_FILE', '');
  config = { authUrl: origin, trustHost: true, authSecret: 'synthetic-auth-secret-at-least-32-characters',
    zitadelIssuer: issuer, zitadelClientId: 'synthetic-client', zitadelSecret: 'synthetic-client-secret',
    zitadelApiAudience: 'synthetic-project', oauthTokenEncryptionKey: Buffer.alloc(32, 1) } as typeof config;
  state.config.mockImplementation(async () => config);
  state.mongo.mockResolvedValue({ db: {}, client: {} });
  state.providerFetch.mockImplementation(async () => Response.json({ issuer,
    authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }));
  await import('../../auth');
}, 20_000);
afterEach(() => { vi.unstubAllEnvs(); });

function request(path: string, init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {}, directOrigin = 'http://0.0.0.0:3000') {
  const headers = new Headers({ host: new URL(origin).host, 'x-forwarded-host': new URL(origin).host, 'x-forwarded-proto': 'https' });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return new NextRequest(`${directOrigin}/api/auth/${path}`, { ...init, headers });
}

it('advertises public provider endpoints when Next.js receives the container URL', async () => {
  const { handlers } = await import('../../auth');
  const response = await handlers.GET(request('providers'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ zitadel: {
    signinUrl: `${origin}/api/auth/signin/zitadel`, callbackUrl: `${origin}/api/auth/callback/zitadel` } });
});

it('starts real Auth.js sign-in with the public callback and preserves POST cookies and body', async () => {
  const { handlers } = await import('../../auth');
  const csrf = await handlers.GET(request('csrf'));
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  const cookie = csrf.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const response = await handlers.POST(request('signin/zitadel?source=portal', { method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrfToken, callbackUrl: `${origin}/after-login` }) }));
  expect(response.status).toBe(302);
  const redirect = new URL(response.headers.get('location')!);
  expect(redirect.origin).toBe(issuer);
  expect(redirect.searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/callback/zitadel`);
  expect(redirect.searchParams.get('state')).toBeTruthy();
  expect(redirect.searchParams.get('code_challenge')).toBeTruthy();
  expect(response.headers.getSetCookie().join(';')).toContain(encodeURIComponent(`${origin}/after-login`));
});

it.each(['untrusted proxy', 'wrong host', 'wrong protocol', 'host chain', 'missing protocol', 'missing host', 'wrong direct origin'])(
  'rejects runtime authentication with %s', async condition => {
    const { handlers } = await import('../../auth');
    const input = request('providers');
    if (condition === 'untrusted proxy') config.trustHost = false;
    if (condition === 'wrong host') input.headers.set('x-forwarded-host', 'attacker.example.test');
    if (condition === 'wrong protocol') input.headers.set('x-forwarded-proto', 'http');
    if (condition === 'host chain') input.headers.set('x-forwarded-host', `${new URL(origin).host}, attacker.example.test`);
    if (condition === 'missing protocol') input.headers.delete('x-forwarded-proto');
    if (condition === 'missing host') { input.headers.delete('x-forwarded-host'); input.headers.delete('host'); }
    if (condition === 'wrong direct origin') { input.headers.delete('x-forwarded-host'); input.headers.delete('x-forwarded-proto'); }
    expect((await handlers.GET(input)).status).toBe(403);
    expect(state.providerFetch).not.toHaveBeenCalled();
  });

it('accepts the configured direct origin without proxy headers', async () => {
  config.trustHost = true;
  const { handlers } = await import('../../auth');
  const input = new NextRequest(`${origin}/api/auth/providers`);
  expect((await handlers.GET(input)).status).toBe(200);
});

it('accepts the exact configured Host when the trusted proxy omits x-forwarded-host', async () => {
  const { handlers } = await import('../../auth');
  const input = request('providers'); input.headers.delete('x-forwarded-host');
  const response = await handlers.GET(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ zitadel: { callbackUrl: `${origin}/api/auth/callback/zitadel` } });
});

it('preserves direct loopback development when Next.js normalizes its IP to localhost', async () => {
  config.authUrl = 'http://127.0.0.1:3000';
  const { handlers } = await import('../../auth');
  expect((await handlers.GET(new NextRequest(`${config.authUrl}/api/auth/providers`))).status).toBe(200);
});

it.each(['forwarded host', 'Host fallback'])('accepts browser CSRF and sign-out on a loopback proxy with %s', async mode => {
  config.authUrl = 'http://127.0.0.1:3100';
  const { handlers } = await import('../../auth');
  const headers = new Headers({ host: '127.0.0.1:3100', 'x-forwarded-proto': 'http' });
  if (mode === 'forwarded host') headers.set('x-forwarded-host', '127.0.0.1:3100');
  const csrf = await handlers.GET(new NextRequest(`${config.authUrl}/api/auth/csrf`, { headers }));
  expect(csrf.status).toBe(200);
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  headers.set('cookie', csrf.headers.getSetCookie().map(value => value.split(';')[0]).join('; '));
  headers.set('content-type', 'application/x-www-form-urlencoded');
  headers.set('X-Auth-Return-Redirect', '1');
  const response = await handlers.POST(new NextRequest(`${config.authUrl}/api/auth/signout`, {
    method: 'POST', headers, body: new URLSearchParams({ csrfToken, callbackUrl: '/' }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: 'http://localhost:3100/' });
});

it('keeps runtime configuration failures private and unavailable', async () => {
  state.config.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_CONFIGURATION'));
  const { handlers } = await import('../../auth');
  const response = await handlers.GET(request('providers'));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('SYNTHETIC_PRIVATE_CONFIGURATION');
});
