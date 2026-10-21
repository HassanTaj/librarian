import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { GET, POST } from '../../app/api/instance/auth/[...nextauth]/route';
import { verifySetupCandidateFlow } from '../../lib/instance/access';
import type { InstanceControl } from '../../lib/instance/store';
import { instanceControl, readyInstance } from '../fixtures/instance';

const state = vi.hoisted(() => ({ host: vi.fn(), connect: vi.fn(), read: vi.fn(), admin: vi.fn(), session: vi.fn(), auth: vi.fn(), get: vi.fn(), post: vi.fn(), close: vi.fn() }));
vi.mock('../../lib/instance/bootstrap', () => ({ readInstanceHost: state.host }));
vi.mock('../../lib/mongo', () => ({ connectMongo: state.connect }));
vi.mock('../../auth', () => ({ createCandidateAuth: state.auth }));
vi.mock('../../lib/instance/store', async original => ({ ...await original<typeof import('../../lib/instance/store')>(), readInstance: state.read }));
vi.mock('../../lib/instance/access', async original => ({ ...await original<typeof import('../../lib/instance/access')>(), requireInstanceAdmin: state.admin, readInstanceSetupSession: state.session }));
let control: InstanceControl; let host: { instanceId: string; setupOrigin: string; config: { authSecret: string }; operator: { purpose: string } };
const token = Buffer.alloc(32, 8).toString('base64url');
const request = (path = 'signin/zitadel', cookie = `__Host-librarian_setup=${token}`, origin = host.setupOrigin) => new NextRequest(`${origin}/api/instance/auth/${path}`, { headers: { cookie } });
beforeEach(() => {
  vi.resetAllMocks(); control = instanceControl(); control.candidate = readyInstance(control.instanceId, control.createdAt).active; control.nextBundleVersion = 2;
  host = { instanceId: control.instanceId, setupOrigin: control.candidate!.publicOrigin, config: { authSecret: 'synthetic-authority-secret'.repeat(2) }, operator: { purpose: 'bootstrap' } };
  state.host.mockResolvedValue(host); state.connect.mockResolvedValue({ db: {}, client: { close: state.close } });
  state.read.mockImplementation(async () => control); state.admin.mockResolvedValue({ binding: { kind: 'owner', bindingId: 'unused' } });
  state.session.mockResolvedValue({ purpose: 'bootstrap', expiresAt: new Date(Date.now() + 60_000) });
  state.get.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://identity.example.test/authorize' } }));
  state.post.mockImplementation(async () => new Response(null, { status: 302, headers: { location: `${host.setupOrigin}/instance/setup` } }));
  state.auth.mockResolvedValue({ handlers: { GET: state.get, POST: state.post } });
});

it('issues bounded callback-only flow cookies and clears both cookies on the GET and POST callback', async () => {
  const response = await GET(request()); expect(response.status).toBe(302);
  const cookies = response.headers.get('set-cookie')!;
  expect(cookies).toContain('Path=/api/instance/auth/callback/zitadel'); expect(cookies).toContain('HttpOnly; Secure; SameSite=Lax');
  const flow = cookies.match(/__Secure-librarian_candidate_flow=([^;]+)/)![1];
  expect(verifySetupCandidateFlow(host.config.authSecret, flow, control, token)).toMatchObject({ candidateVersion: 1 });
  const callbackCookie = `__Secure-librarian_candidate_setup=${token}; __Secure-librarian_candidate_flow=${flow}`;
  for (const handler of [GET, POST]) {
    const callback = await handler(request('callback/zitadel', callbackCookie));
    expect(callback.headers.get('set-cookie')).toContain('__Secure-librarian_candidate_setup=;');
    expect(callback.headers.get('set-cookie')).toContain('__Secure-librarian_candidate_flow=;');
    expect(callback.headers.get('set-cookie')).toContain('Max-Age=0');
  }
  expect(state.auth.mock.calls.at(-1)![3]).toMatchObject({ candidateVersion: 1 }); expect(state.close).toHaveBeenCalledTimes(3);
});

it.each(['no redirect', 'expired session'])('does not mint a flow cookie for %s', async condition => {
  if (condition === 'no redirect') state.get.mockResolvedValue(Response.json({ status: 'not_signed_in' }));
  else state.session.mockResolvedValue({ purpose: 'bootstrap', expiresAt: new Date(Date.now() - 1000) });
  expect((await GET(request())).headers.get('set-cookie')).toBeNull(); expect(state.close).toHaveBeenCalledOnce();
});

it.each(['secure', 'local'] as const)('binds owner continuity to the hash of the %s runtime session', async mode => {
  const ready = readyInstance(control.instanceId, control.createdAt); ready.candidate = control.candidate; control = ready;
  control.candidate!.version = control.nextBundleVersion++;
  state.admin.mockResolvedValue({ binding: control.administrators[0] });
  const response = await GET(request('signin/zitadel', `${mode === 'secure' ? '__Secure-' : ''}authjs.session-token=synthetic-runtime-token`));
  const signed = response.headers.get('set-cookie')!.match(/__Secure-librarian_candidate_flow=([^;]+)/)![1];
  const derived = createHash('sha256').update('synthetic-runtime-token').digest('base64url');
  expect(verifySetupCandidateFlow(host.config.authSecret, signed, control, derived)?.ownerBindingId).toBe(control.administrators[0].bindingId);
  expect(state.session).not.toHaveBeenCalled();
});

it('requires host recovery authority before issuing a recovery candidate flow', async () => {
  const ready = readyInstance(control.instanceId, control.createdAt); ready.candidate = control.candidate; control = ready;
  control.candidate!.version = control.nextBundleVersion++; control.lifecycle = 'maintenance'; control.gate.state = 'maintenance';
  state.session.mockResolvedValue({ purpose: 'recovery', expiresAt: new Date(Date.now() + 60_000) });
  expect((await GET(request())).status).toBe(403);
  host.operator.purpose = 'recover'; const response = await GET(request());
  const signed = response.headers.get('set-cookie')!.match(/__Secure-librarian_candidate_flow=([^;]+)/)![1];
  expect(verifySetupCandidateFlow(host.config.authSecret, signed, control, token)?.recovery).toBe(true);
});

it.each(['missing candidate', 'administrator', 'wrong origin', 'changed origin', 'handler failure'] as const)('denies %s and closes storage', async condition => {
  let input = request(); let status = 503;
  if (condition === 'missing candidate') { control.candidate = null; status = 401; }
  if (condition === 'administrator') { control.lifecycle = 'ready'; state.admin.mockResolvedValue({ binding: { kind: 'administrator' } }); status = 403; }
  if (condition === 'wrong origin') { input = request('signin/zitadel', '', 'https://attacker.example.test'); status = 403; }
  if (condition === 'changed origin') { control.candidate!.publicOrigin = 'https://replacement.example.test'; status = 409; }
  if (condition === 'handler failure') state.get.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_BODY'));
  const response = await GET(input); expect(response.status).toBe(status); expect(await response.text()).not.toContain('SYNTHETIC_PRIVATE_BODY');
  expect(state.close).toHaveBeenCalledOnce();
});
