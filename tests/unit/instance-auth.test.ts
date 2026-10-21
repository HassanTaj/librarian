import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NextAuthConfig } from 'next-auth';
import { customFetch } from 'next-auth';
import type { Db } from 'mongodb';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCandidateAuth } from '../../auth';
import { instanceControl, readyInstance } from '../fixtures/instance';
import type { InstanceControl } from '../../lib/instance/store';
import type { SetupCandidateFlow } from '../../lib/instance/access';

const state = vi.hoisted(() => ({ nextAuth: vi.fn(), roles: vi.fn(), read: vi.fn(), update: vi.fn(), pinned: vi.fn(), fetch: vi.fn() }));
vi.mock('next-auth', async original => ({ ...await original<typeof import('next-auth')>(), default: state.nextAuth }));
vi.mock('../../lib/auth/roles', async original => ({ ...await original<typeof import('../../lib/auth/roles')>(), getVerifiedRoles: state.roles }));
vi.mock('../../lib/instance/store', async original => ({ ...await original<typeof import('../../lib/instance/store')>(), readInstance: state.read, updateInstance: state.update }));
vi.mock('../../lib/instance/validation', () => ({ createPinnedFetch: state.pinned }));

let control: InstanceControl;
let candidate: NonNullable<InstanceControl['candidate']>;
let host: Parameters<typeof createCandidateAuth>[0];
let flow: SetupCandidateFlow;
let clock: number;
const db = {} as Db;
const account = { provider: 'zitadel', type: 'oidc' as const, providerAccountId: 'synthetic-owner', access_token: 'synthetic-access' };

beforeEach(() => {
  vi.clearAllMocks();
  clock = Date.now(); control = instanceControl(undefined, new Date(clock));
  candidate = readyInstance(control.instanceId, new Date(clock)).active!; control.candidate = candidate;
  host = { instanceId: control.instanceId, setupOrigin: candidate.publicOrigin,
    config: { authSecret: 'synthetic-root-auth-secret' },
    keyring: { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } },
    policy: { origins: [] } } as unknown as typeof host;
  flow = { instanceId: control.instanceId, candidateVersion: candidate.version, setupEpoch: control.bootstrap.epoch,
    securityEpoch: control.securityEpoch, recoveryEpoch: control.recoveryEpoch,
    setupSessionHash: 'a'.repeat(64), expiresAt: new Date(clock + 600_000) };
  state.nextAuth.mockReturnValue({}); state.pinned.mockReturnValue(state.fetch);
  state.roles.mockResolvedValue(['librarian-instance-admin']); state.read.mockImplementation(async () => control);
  state.update.mockImplementation(async (_db, _id, _revision, mutate) => { control = mutate(control); return control; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function create(currentFlow: SetupCandidateFlow | null = flow) {
  await createCandidateAuth(host, db, candidate, currentFlow, () => clock);
  return state.nextAuth.mock.calls.at(-1)![0] as NextAuthConfig;
}
async function signIn(options: NextAuthConfig, changes: { account?: unknown; profile?: unknown } = {}) {
  return options.callbacks!.signIn!({ user: { id: 'synthetic-owner' }, account,
    profile: { iss: candidate.zitadel.issuer, sub: account.providerAccountId }, ...changes } as Parameters<NonNullable<NonNullable<NextAuthConfig['callbacks']>['signIn']>>[0]);
}

it('isolates candidate sessions, fetches and identity claims from ordinary runtime login', async () => {
  const options = await create();
  expect(options.adapter).toBeUndefined(); expect(options.basePath).toBe('/api/instance/auth');
  expect(options.session).toMatchObject({ strategy: 'jwt', maxAge: 600, updateAge: 600 });
  expect(options.secret).not.toBe(host.config.authSecret);
  for (const entry of Object.values(options.cookies!)) expect(entry).toMatchObject({ name: expect.stringMatching(/^__Secure-librarian-candidate-/),
    options: { secure: true, httpOnly: true, sameSite: 'lax', path: '/api/instance/auth' } });
  const provider = (options.providers[0] as { options: Record<string | symbol, unknown> }).options;
  expect(provider.checks).toEqual(['pkce', 'state', 'nonce']); expect(provider[customFetch]).toBe(state.fetch);
  const profile = provider.profile as (input: { sub?: unknown; email?: string }) => unknown;
  expect(profile({ sub: 'synthetic-owner', email: 'ignored@example.invalid' })).toEqual({ id: 'synthetic-owner', name: null, email: null });
  expect(profile({ sub: 42 })).toEqual({ id: '', name: null, email: null });
  expect(state.pinned).toHaveBeenCalledWith({ policy: host.policy });
});

it('binds the single-use owner proof to the current verified identity, epochs and candidate', async () => {
  candidate.checks = [{ type: 'zitadel_owner_login', candidateVersion: 1, at: new Date(clock), status: 'failed', code: 'authentication_failed' },
    { type: 'database', candidateVersion: 1, at: new Date(clock), status: 'passed', code: 'database_ok' }];
  expect(await signIn(await create())).toBe(true);
  expect(control.lifecycle).toBe('awaiting_owner');
  expect(control.candidate?.ownerProof).toMatchObject({ instanceId: control.instanceId, candidateVersion: candidate.version,
    issuer: candidate.zitadel.issuer, subject: 'synthetic-owner', projectId: candidate.zitadel.projectId, securityEpoch: 1,
    expiresAt: new Date(clock + 600_000) });
  expect(control.candidate?.checks.filter(check => check.type === 'zitadel_owner_login')).toEqual([
    { type: 'zitadel_owner_login', candidateVersion: 1, at: new Date(clock), status: 'passed', code: 'provider_ok' },
  ]);
  const accessToken = state.roles.mock.calls[0][2] as () => Promise<string>;
  expect(await accessToken()).toBe(account.access_token); expect(state.roles.mock.calls[0][3]).toBe(state.fetch);
});

it('denies a candidate login without a signed setup flow', async () => {
  expect(await signIn(await create(null))).toBe(false); expect(state.roles).not.toHaveBeenCalled();
});

it.each(['owner', 'recovery'] as const)('preserves the initialized lifecycle after verified %s continuity login', async mode => {
  control = readyInstance(control.instanceId, new Date(clock)); control.candidate = candidate;
  candidate.version = control.nextBundleVersion++; flow.candidateVersion = candidate.version;
  if (mode === 'owner') flow.ownerBindingId = control.administrators[0].bindingId;
  else { flow.recovery = true; control.lifecycle = 'maintenance'; control.gate.state = 'maintenance'; }
  const options = await create(); expect(await signIn(options)).toBe(true);
  expect(control.lifecycle).toBe(mode === 'owner' ? 'ready' : 'maintenance');
  expect(control.candidate!.ownerProof?.subject).toBe(account.providerAccountId);
  const path = mode === 'owner' ? '/instance/settings' : '/instance/setup';
  expect(await options.callbacks!.redirect!({ url: path, baseUrl: host.setupOrigin })).toBe(`${host.setupOrigin}${path}`);
  expect(await options.callbacks!.redirect!({ url: 'http://[', baseUrl: host.setupOrigin })).toBe(`${host.setupOrigin}${path}`);
});

it.each(['owner lifecycle', 'owner retired', 'recovery lifecycle', 'recovery initialization', 'recovery consumed'] as const)
  ('denies stale initialized candidate authority: %s', async condition => {
    control = readyInstance(control.instanceId, new Date(clock)); control.candidate = candidate;
    candidate.version = control.nextBundleVersion++; flow.candidateVersion = candidate.version;
    if (condition.startsWith('owner')) {
      flow.ownerBindingId = control.administrators[0].bindingId;
      if (condition === 'owner lifecycle') control.lifecycle = 'maintenance'; else control.administrators[0].status = 'retired';
    } else {
      flow.recovery = true; control.lifecycle = 'maintenance'; control.gate.state = 'maintenance';
      if (condition === 'recovery lifecycle') control.lifecycle = 'ready';
      if (condition === 'recovery initialization') control.initializedAt = null;
      if (condition === 'recovery consumed') control.bootstrap.consumedAt = null;
    }
    expect(await signIn(await create())).toBe(false); expect(state.update).not.toHaveBeenCalled();
  });

it.each([
  ['missing account', { account: null }], ['wrong provider', { account: { ...account, provider: 'other' } }],
  ['missing stable subject', { account: { ...account, providerAccountId: undefined } }],
  ['missing access token', { account: { ...account, access_token: undefined } }],
  ['missing claims', { profile: undefined }], ['wrong issuer', { profile: { iss: 'https://wrong.example.test', sub: 'synthetic-owner' } }],
  ['subject substitution', { profile: { iss: 'https://identity.example.test', sub: 'attacker' } }],
] as const)('denies %s before role lookup or ownership mutation', async (_name, changes) => {
  expect(await signIn(await create(), changes)).toBe(false); expect(state.roles).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
});

it.each(['missing role', 'role lookup failure'])('fails closed on %s', async mode => {
  if (mode === 'missing role') state.roles.mockResolvedValue(['librarian-admin']); else state.roles.mockRejectedValue(new Error('synthetic upstream failure'));
  expect(await signIn(await create())).toBe(false); expect(state.update).not.toHaveBeenCalled();
});

it.each(['missing instance', 'missing candidate', 'candidate version', 'ready', 'setup epoch', 'recovery epoch', 'security epoch', 'consumed bootstrap', 'exact expiry'])
  ('denies stale authority: %s', async mode => {
    const options = await create();
    if (mode === 'missing instance') state.read.mockResolvedValue(null);
    if (mode === 'missing candidate') control.candidate = null;
    if (mode === 'candidate version') control.candidate!.version++;
    if (mode === 'ready') control.lifecycle = 'ready';
    if (mode === 'setup epoch') control.bootstrap.epoch++;
    if (mode === 'recovery epoch') control.recoveryEpoch++;
    if (mode === 'security epoch') control.securityEpoch++;
    if (mode === 'consumed bootstrap') control.bootstrap.consumedAt = new Date(clock);
    if (mode === 'exact expiry') clock = flow.expiresAt.getTime();
    expect(await signIn(options)).toBe(false); expect(state.update).not.toHaveBeenCalled();
  });

it.each(['candidate missing', 'candidate changed', 'security changed', 'recovery changed', 'bootstrap changed', 'write failure'])
  ('denies a concurrent ownership transition: %s', async mode => {
    state.update.mockImplementation(async (_db, _id, _revision, mutate) => {
      const latest = structuredClone(control);
      if (mode === 'candidate missing') latest.candidate = null;
      if (mode === 'candidate changed') latest.candidate!.version++;
      if (mode === 'security changed') latest.securityEpoch++;
      if (mode === 'recovery changed') latest.recoveryEpoch++;
      if (mode === 'bootstrap changed') latest.bootstrap.epoch++;
      if (mode === 'write failure') throw new Error('synthetic CAS conflict');
      return mutate(latest);
    });
    expect(await signIn(await create())).toBe(false); expect(control.candidate?.ownerProof).toBeNull();
  });

it.each(['other current owner', 'same current owner', 'expired other owner'])('handles %s without replacing another live proof', async mode => {
  candidate.ownerProof = { instanceId: control.instanceId, candidateVersion: 1, issuer: candidate.zitadel.issuer,
    subject: mode === 'same current owner' ? 'synthetic-owner' : 'other-owner', projectId: candidate.zitadel.projectId,
    securityEpoch: 1, nonce: '00000000-0000-4000-8000-000000000099', expiresAt: new Date(clock + (mode === 'expired other owner' ? 0 : 1)) };
  expect(await signIn(await create())).toBe(mode !== 'other current owner');
});

it.each([
  ['/instance/setup?step=owner', '/instance/setup?step=owner'], ['https://external.example.test/instance/setup', '/instance/setup'],
  ['/instance/settings', '/instance/setup'], ['http://[', '/instance/setup'],
  ['https://user:password@portal.example.test/instance/setup', '/instance/setup'],
  ['/\\external.example.test/instance/setup', '/instance/setup'],
])('restricts candidate return URL %s to the setup route', async (url, expected) => {
  const options = await create();
  expect(await options.callbacks!.redirect!({ url, baseUrl: host.setupOrigin })).toBe(`${host.setupOrigin}${expected}`);
});

it('never emits provider secrets in candidate auth logs', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const options = await create();
  for (const error of [new Error('SYNTHETIC_SECRET_MUST_NOT_LEAK'), Object.assign(new Error('provider_unavailable'), { type: 'OAuthCallbackError' }),
    new Error('Cannot parse action at /api/instance/auth/unknown'), Object.assign(new Error('SYNTHETIC_SECRET_MUST_NOT_LEAK'), { name: '<unsafe-name>', type: 'unsafe:secret' }),
    { type: 'SafeType', message: 42 }]) options.logger!.error!(error as Error);
  options.logger!.warn!('synthetic-warning' as never); options.logger!.debug!('synthetic-debug');
  const output = JSON.stringify(log.mock.calls);
  expect(output).not.toContain('SYNTHETIC_SECRET_MUST_NOT_LEAK'); expect(output).not.toContain('unsafe:secret');
  expect(output).toContain('provider_unavailable'); expect(output).toContain('/api/instance/auth/unknown'); expect(output).toContain('unknown');
});

it('restricts a development test CA to the exact localhost origin approved by host policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'librarian-auth-ca-'));
  try {
    const file = join(directory, 'provider.pem'); await writeFile(file, 'synthetic-local-test-ca');
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('LIBRARIAN_TEST_PROVIDER_CA_FILE', file);
    candidate.zitadel.issuer = 'https://localhost:3210'; host.policy.origins = [{ origin: candidate.zitadel.issuer, addresses: ['127.0.0.1'] }];
    await create(); expect(state.pinned).toHaveBeenLastCalledWith({ policy: host.policy, ca: { origin: candidate.zitadel.issuer, certificate: Buffer.from('synthetic-local-test-ca') } });
    vi.stubEnv('NODE_ENV', 'production'); await create(); expect(state.pinned).toHaveBeenLastCalledWith({ policy: host.policy });
    vi.stubEnv('NODE_ENV', 'development'); host.policy.origins = []; await create(); expect(state.pinned).toHaveBeenLastCalledWith({ policy: host.policy });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
