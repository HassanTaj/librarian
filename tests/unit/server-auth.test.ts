import { afterEach, expect, it, vi } from 'vitest';
import type { NextAuthConfig } from 'next-auth';
import { createServerAuth } from '../../auth';

const state = vi.hoisted(() => ({ nextAuth: vi.fn(), adapter: vi.fn(), persist: vi.fn(), fetch: vi.fn() }));
vi.mock('next-auth', async original => ({ ...await original<typeof import('next-auth')>(), default: state.nextAuth }));
vi.mock('../../lib/auth/adapter', () => ({ createLibrarianAdapter: state.adapter, persistOAuthSignInTokens: state.persist }));
vi.mock('../../lib/instance/validation', () => ({ runtimeProviderFetch: state.fetch }));
afterEach(() => { vi.restoreAllMocks(); });

it('accepts only an issuer-bound Zitadel sign-in and exposes only the database user identity', async () => {
  const config = { authUrl: 'https://portal.example.test', authSecret: 'synthetic-auth-secret', trustHost: true,
    zitadelIssuer: 'https://identity.example.test', zitadelClientId: 'client', zitadelSecret: 'synthetic-client-secret',
    zitadelApiAudience: 'project', oauthTokenEncryptionKey: Buffer.alloc(32, 1) } as Parameters<typeof createServerAuth>[0];
  const db = {} as Parameters<typeof createServerAuth>[2]; const client = {} as Parameters<typeof createServerAuth>[1];
  state.adapter.mockResolvedValue({}); state.fetch.mockResolvedValue(fetch); state.nextAuth.mockReturnValue({});
  await createServerAuth(config, client, db);
  const options = state.nextAuth.mock.calls.at(-1)![0] as NextAuthConfig;
  const provider = (options.providers[0] as { options: Record<string, unknown> }).options;
  const profile = provider.profile as (value: unknown) => unknown;
  expect(profile({ sub: 'synthetic-owner', name: 'ignored', email: 'ignored@example.test' })).toEqual({ id: 'synthetic-owner', name: null, email: null });
  expect(profile({ sub: 42 })).toEqual({ id: '', name: null, email: null });
  const account = { provider: 'zitadel', type: 'oidc', providerAccountId: 'synthetic-owner' };
  const claims = { iss: config.zitadelIssuer, sub: account.providerAccountId };
  const signIn = (account: unknown, profile: unknown) => options.callbacks!.signIn!({ account, profile } as Parameters<NonNullable<NonNullable<NextAuthConfig['callbacks']>['signIn']>>[0]);
  for (const [value, profile] of [[null, claims], [{ ...account, provider: 'untrusted' }, claims],
    [{ ...account, providerAccountId: 42 }, claims], [account, undefined], [account, { ...claims, iss: 'https://attacker.example.test' }],
    [account, { ...claims, sub: 'different-subject' }]]) expect(await signIn(value, profile)).toBe(false);
  expect(state.persist).not.toHaveBeenCalled(); expect(await signIn(account, claims)).toBe(true);
  expect(state.persist).toHaveBeenCalledWith(db, config.zitadelIssuer, account, config.oauthTokenEncryptionKey, expect.any(Function));
  const expires = new Date().toISOString();
  const session = await options.callbacks!.session!({ session: { user: { name: 'Private name', email: 'private@example.test' }, expires,
    sessionToken: 'SYNTHETIC_SESSION_TOKEN', userId: 'SYNTHETIC_USER_ID', securityEpoch: 1 },
    user: { id: 'database-user' } } as unknown as Parameters<NonNullable<NonNullable<NextAuthConfig['callbacks']>['session']>>[0]);
  expect(session).toEqual({ expires, user: { id: 'database-user' } });
  for (const value of ['https://attacker.example.test', '//attacker.example.test', '\\attacker.example.test', '/path\nheader', 'https://[', 'https://user:password@portal.example.test']) {
    expect(await options.callbacks!.redirect!({ url: value, baseUrl: config.authUrl })).toBe(config.authUrl);
  }
  expect(await options.callbacks!.redirect!({ url: '/docs', baseUrl: config.authUrl })).toBe(`${config.authUrl}/docs`);
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  options.logger!.error!(new Error('SYNTHETIC_PRIVATE_BODY') as never); options.logger!.warn!('synthetic-warning' as never); options.logger!.debug!('synthetic-debug');
  expect(JSON.stringify(log.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_BODY');
});
