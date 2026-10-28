import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  readHost: vi.fn(), verifyOrigin: vi.fn(), readJson: vi.fn(), connect: vi.fn(), authorize: vi.fn(), close: vi.fn(),
  host: { instanceId: 'synthetic-instance', setupOrigin: 'https://setup.example.test', config: {}, operator: { purpose: 'bootstrap', expiresAt: '2099-01-01T00:00:00.000Z' } },
  payload: null as unknown, session: { token: 'synthetic-token', csrfToken: 'synthetic-csrf', expiresAt: new Date(Date.now() + 60_000) },
}));
vi.mock('@/lib/instance/bootstrap', () => ({ readInstanceHost: state.readHost }));
vi.mock('@/lib/mongo', () => ({ connectMongo: state.connect }));
vi.mock('@/lib/instance/access', () => ({
  authorizeInstanceSetup: state.authorize,
  verifyInstancePreSessionMutation: state.verifyOrigin,
  readInstanceJson: state.readJson,
  instanceErrorResponse: (error: unknown) => Response.json({ code: error instanceof Error ? error.message : 'unknown' }, { status: 400 }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  state.host.operator = { purpose: 'bootstrap', expiresAt: '2099-01-01T00:00:00.000Z' };
  state.payload = { credential: 'x'.repeat(43) };
  state.session = { token: 'synthetic-token', csrfToken: 'synthetic-csrf', expiresAt: new Date(Date.now() + 60_000) };
  state.readHost.mockImplementation(async () => state.host);
  state.verifyOrigin.mockReturnValue(undefined);
  state.readJson.mockImplementation(async () => state.payload);
  state.connect.mockResolvedValue({ db: {}, client: { close: state.close } }); state.close.mockResolvedValue(undefined);
  state.authorize.mockImplementation(async (_db, _instanceId, _credential, _now, purpose) => ({ ...state.session, purpose }));
});

it('issues bootstrap and recovery cookies with the matching session purpose', async () => {
  const { POST } = await import('../../app/api/instance/setup/authorize/route');
  const request = () => new Request('https://setup.example.test/api/instance/setup/authorize', { method: 'POST' });
  const bootstrap = await POST(request());
  expect(bootstrap.status).toBe(200);
  expect(await bootstrap.json()).toMatchObject({ purpose: 'bootstrap', csrfToken: 'synthetic-csrf' });
  state.host.operator = { purpose: 'recover', expiresAt: '2099-01-01T00:00:00.000Z' };
  const recovery = await POST(request());
  expect(await recovery.json()).toMatchObject({ purpose: 'recovery', csrfToken: 'synthetic-csrf' });
  expect(state.authorize).toHaveBeenLastCalledWith({}, state.host.instanceId, (state.payload as { credential: string }).credential, expect.any(Date), 'recovery');
  expect(state.close).toHaveBeenCalledTimes(2);
});

it('rejects a closed or expired operator grant, malformed input, and an expired returned session', async () => {
  const { POST } = await import('../../app/api/instance/setup/authorize/route');
  const request = () => new Request('https://setup.example.test/api/instance/setup/authorize', { method: 'POST' });
  state.host.operator = { purpose: 'enroll', expiresAt: '2099-01-01T00:00:00.000Z' };
  expect(await (await POST(request())).json()).toMatchObject({ code: 'instance_setup_unauthorized' });
  state.host.operator = { purpose: 'recover', expiresAt: '2000-01-01T00:00:00.000Z' };
  expect(await (await POST(request())).json()).toMatchObject({ code: 'instance_setup_unauthorized' });
  state.host.operator.expiresAt = '2099-01-01T00:00:00.000Z'; state.payload = {};
  expect(await (await POST(request())).json()).toMatchObject({ code: 'instance_invalid' });
  state.payload = { credential: 'x'.repeat(43) }; state.session.expiresAt = new Date(Date.now() - 1);
  expect(await (await POST(request())).json()).toMatchObject({ code: 'instance_setup_unauthorized' });
});
