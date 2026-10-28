import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ host: null as unknown, control: null as unknown, session: null as unknown,
  readHost: vi.fn(), connect: vi.fn(), close: vi.fn(), readSession: vi.fn(), consumeRate: vi.fn(), readJson: vi.fn(),
  initial: vi.fn(), build: vi.fn(), read: vi.fn(), update: vi.fn(), runtime: vi.fn() }));
vi.mock('@/lib/config', () => ({ instanceRuntimeInputs: state.runtime }));
vi.mock('@/lib/mongo', () => ({ connectMongo: state.connect }));
vi.mock('@/lib/instance/bootstrap', () => ({ readInstanceHost: state.readHost }));
vi.mock('@/lib/instance/access', () => ({
  consumeInstanceRate: state.consumeRate,
  instanceErrorResponse: (error: unknown) => Response.json({ code: error instanceof Error ? error.message : 'unknown' }, { status: 400 }),
  readInstanceJson: state.readJson,
  readInstanceSetupSession: state.readSession,
}));
vi.mock('@/lib/instance/store', () => ({
  InstanceDraftPatchSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
  buildInstanceDraft: state.build,
  initialInstanceCandidate: state.initial,
  readInstance: state.read,
  updateInstance: state.update,
}));
vi.mock('@/lib/limits', () => ({ LIMITS: { maxInstanceAuditOutbox: 128 } }));

function makeCandidate(runtime: unknown = null) {
  return { version: 1, preferences: { displayName: 'Synthetic setup', description: '', docsFolder: 'docs' },
    publicOrigin: 'https://setup.example.test', zitadel: { issuer: 'https://identity.example.test', clientId: 'client', projectId: 'project', audience: 'audience' },
    github: { appId: '123', webhookUrl: undefined as string | undefined }, checks: [], runtime, impact: null,
    secrets: { zitadelClientSecret: null, githubPrivateKey: null, githubWebhookSecret: null }, ownerProof: null as null | {
      instanceId: string; candidateVersion: number; issuer: string; subject: string; projectId: string; securityEpoch: number; nonce: string; expiresAt: Date;
    } };
}
function makeControl() {
  return { instanceId: 'synthetic-instance', lifecycle: 'configuring', revision: 3, editRevision: 2, securityEpoch: 1,
    bootstrap: { consumedAt: null as Date | null }, auditOutbox: [] as unknown[], candidate: null as null | ReturnType<typeof makeCandidate>, active: null as null | ReturnType<typeof makeCandidate> };
}

let control: ReturnType<typeof makeControl>;
let candidate: ReturnType<typeof makeCandidate>;
let purpose: 'bootstrap' | 'recovery';
let payload: unknown;
const host = { instanceId: 'synthetic-instance', setupOrigin: 'https://setup.example.test', config: {}, keyring: {} };

beforeEach(() => {
  vi.resetAllMocks(); control = makeControl(); candidate = makeCandidate(); purpose = 'bootstrap';
  control.candidate = candidate; payload = { candidateVersion: 1, changes: { displayName: 'Updated synthetic setup' } };
  state.readHost.mockResolvedValue(host); state.connect.mockResolvedValue({ db: {}, client: { close: state.close } }); state.close.mockResolvedValue(undefined);
  state.session = { expiresAt: new Date(Date.now() + 60_000), purpose };
  state.readSession.mockImplementation(async () => ({ expiresAt: new Date(Date.now() + 60_000), purpose }));
  state.consumeRate.mockResolvedValue(undefined); state.readJson.mockImplementation(async () => payload);
  state.initial.mockImplementation(() => makeCandidate()); state.build.mockImplementation(async () => candidate);
  state.read.mockImplementation(async () => control); state.update.mockImplementation(async (_db, _id, _revision, mutate) => {
    control = mutate(control) as ReturnType<typeof makeControl>; return control;
  });
  state.runtime.mockReturnValue({ mongodbUri: 'mongodb://127.0.0.1:27018/librarian', mongodbDatabase: 'librarian', trustHost: true, workerEnabled: false });
});

it('returns recovery authority metadata only for a recovery session with a current proof', async () => {
  const { GET } = await import('../../app/api/instance/setup/route');
  control.lifecycle = 'maintenance';
  candidate.ownerProof = { instanceId: control.instanceId, candidateVersion: 1, issuer: candidate.zitadel.issuer, subject: 'synthetic-owner',
    projectId: candidate.zitadel.projectId, securityEpoch: control.securityEpoch, nonce: 'synthetic-recovery-proof', expiresAt: new Date(Date.now() + 60_000) };
  purpose = 'recovery'; state.readSession.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000), purpose });
  const response = await GET(new Request('https://setup.example.test/api/instance/setup', { headers: { cookie: '__Host-librarian_setup=synthetic-token' } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ recovery: true, recoveryControlRevision: 3, recoveryProofId: 'synthetic-recovery-proof' });
});

it('fails when setup control is absent and omits an unavailable recovery proof', async () => {
  const { GET } = await import('../../app/api/instance/setup/route');
  state.read.mockResolvedValueOnce(null);
  const missing = await GET(new Request('https://setup.example.test/api/instance/setup', { headers: { cookie: '__Host-librarian_setup=synthetic-token' } }));
  expect(await missing.json()).toMatchObject({ code: 'instance_unavailable' });

  control.lifecycle = 'maintenance';
  purpose = 'recovery'; state.readSession.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000), purpose });
  const recovery = await GET(new Request('https://setup.example.test/api/instance/setup', { headers: { cookie: '__Host-librarian_setup=synthetic-token' } }));
  expect(await recovery.json()).toMatchObject({ recovery: true, recoveryProofId: null });
});

it('creates an initial candidate for bootstrap and restores missing host runtime on save', async () => {
  const routes = await import('../../app/api/instance/setup/route');
  control.candidate = null;
  const initial = await routes.GET(new Request('https://setup.example.test/api/instance/setup', { headers: { cookie: '__Host-librarian_setup=synthetic-token' } }));
  expect(initial.status).toBe(200);
  expect(state.initial).toHaveBeenCalledOnce();

  control.candidate = makeCandidate(); candidate = makeCandidate();
  const saved = await routes.PATCH(new Request('https://setup.example.test/api/instance/setup', { method: 'PATCH', headers: {
    origin: host.setupOrigin, cookie: '__Host-librarian_setup=synthetic-token', 'x-csrf-token': 'synthetic-csrf', 'if-match': '"2"',
  }, body: '{}' }));
  expect(saved.status).toBe(200);
  expect(control.candidate!.runtime).toMatchObject({ mongodbDatabase: 'librarian', trustHost: true, workerEnabled: false });
  expect(state.runtime).toHaveBeenCalledOnce();
});
