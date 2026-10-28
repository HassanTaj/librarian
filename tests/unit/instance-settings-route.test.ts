import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  requireAdmin: vi.fn(), consumeRate: vi.fn(), readJson: vi.fn(),
  buildDraft: vi.fn(), read: vi.fn(), update: vi.fn(),
}));
vi.mock('@/lib/instance/access', () => ({
  requireInstanceAdmin: state.requireAdmin,
  consumeInstanceRate: state.consumeRate,
  readInstanceJson: state.readJson,
  withInstanceAdmission: async (_db: unknown, _instanceId: string, _kind: string, operation: () => Promise<unknown>) => operation(),
  instanceErrorResponse: (error: unknown) => Response.json({ code: error instanceof Error ? error.message : 'unknown' }, { status: 400 }),
}));
vi.mock('@/lib/instance/store', () => ({
  InstanceDraftPatchSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
  instanceSnapshot: (value: { editRevision: number; activeVersion: number; candidateVersion: number | null }) => value,
  buildInstanceDraft: state.buildDraft,
  readInstance: state.read,
  updateInstance: state.update,
}));

function makeControl() {
  const active = { version: 1, publicOrigin: 'https://portal.example.test', github: { webhookUrl: undefined as string | undefined },
    zitadel: { issuer: 'https://identity.example.test', clientId: 'client', projectId: 'project', audience: 'audience' },
    preferences: { displayName: 'Synthetic', description: '', docsFolder: 'docs' }, runtime: {}, secrets: {}, checks: [], ownerProof: null as null | {
      instanceId: string; candidateVersion: number; issuer: string; subject: string; projectId: string; securityEpoch: number; nonce: string; expiresAt: Date;
    }, impact: null as null | { confirmationNonce: string } };
  return { instanceId: 'synthetic-instance', revision: 0, editRevision: 0, securityEpoch: 1, nextBundleVersion: 2, active,
    candidate: null as typeof active | null, previous: null as null | { version: number }, activation: null as null | { phase: string },
    lifecycle: 'ready', auditOutbox: [] as { _id: string; instanceId: string; at: Date; actor: string; operation: string; fromVersion: number | null; toVersion: number; resultCode: string; requestId: string }[] };
}
const db = {};
const maxInstanceAuditOutbox = 128;
let control: ReturnType<typeof makeControl>;
let binding: { kind: 'owner' | 'administrator'; bindingId: string };
let payload: unknown;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('INSTANCE_DATABASE_FILE', '');
  control = makeControl(); binding = { kind: 'owner', bindingId: 'synthetic-owner' };
  payload = { candidateVersion: 0, changes: { displayName: 'Synthetic draft' } };
  state.requireAdmin.mockImplementation(async () => ({ db, host: { instanceId: control.instanceId, setupOrigin: 'https://portal.example.test', keyring: {} },
    control, binding, csrfToken: 'synthetic-csrf' }));
  state.consumeRate.mockResolvedValue(undefined); state.readJson.mockImplementation(async () => payload);
  state.read.mockImplementation(async () => control);
  state.buildDraft.mockImplementation(async (_control, _origin, _input, _keyring, _actor, now) => ({ ...control.active, version: 2, createdAt: now }));
  state.update.mockImplementation(async (_db, _id, _revision, mutate) => mutate(control));
});

it('returns an owner proof only for an owner binding with a current proof', async () => {
  const active = control.active;
  const candidate = { ...active, version: 2, ownerProof: { instanceId: control.instanceId, candidateVersion: 2,
    issuer: active.zitadel.issuer, subject: 'synthetic-owner', projectId: active.zitadel.projectId, securityEpoch: control.securityEpoch,
    nonce: 'synthetic-proof', expiresAt: new Date(Date.now() + 60_000) } };
  control.candidate = candidate;
  const { GET } = await import('../../app/api/instance/settings/route');
  expect(await (await GET(new Request('https://portal.example.test/api/instance/settings'))).json()).toMatchObject({ ownerProofId: 'synthetic-proof' });
  binding = { kind: 'administrator', bindingId: 'synthetic-admin' };
  expect(await (await GET(new Request('https://portal.example.test/api/instance/settings'))).json()).toMatchObject({ ownerProofId: null });
  binding = { kind: 'owner', bindingId: 'synthetic-owner' };
  candidate.ownerProof.expiresAt = new Date(Date.now() - 1);
  expect(await (await GET(new Request('https://portal.example.test/api/instance/settings'))).json()).toMatchObject({ ownerProofId: null });
});

it('rejects database edits by non-owners and when the host locator is unavailable', async () => {
  const { PATCH } = await import('../../app/api/instance/settings/route');
  payload = { candidateVersion: 0, changes: { database: { mongodbDatabase: 'librarian_next' } } };
  binding = { kind: 'administrator', bindingId: 'synthetic-admin' };
  expect(await (await PATCH(new Request('https://portal.example.test/api/instance/settings', { method: 'PATCH' }))).json()).toMatchObject({ code: 'instance_forbidden' });
  binding = { kind: 'owner', bindingId: 'synthetic-owner' };
  expect(await (await PATCH(new Request('https://portal.example.test/api/instance/settings', { method: 'PATCH' }))).json()).toMatchObject({ code: 'instance_operator_required' });
});

it('fails safely when stored control is missing or the audit outbox is full', async () => {
  const { PATCH } = await import('../../app/api/instance/settings/route');
  payload = { candidateVersion: 0, changes: { displayName: 'Synthetic draft' } };
  state.read.mockResolvedValueOnce(null);
  expect(await (await PATCH(new Request('https://portal.example.test/api/instance/settings', { method: 'PATCH', headers: { 'if-match': '"0"' } }))).json())
    .toMatchObject({ code: 'instance_unavailable' });
  control.auditOutbox = Array.from({ length: maxInstanceAuditOutbox }, () => ({ _id: 'synthetic', instanceId: control.instanceId,
    at: new Date(), actor: 'synthetic-owner', operation: 'candidate_saved', fromVersion: null, toVersion: 1, resultCode: 'accepted', requestId: 'synthetic' }));
  expect(await (await PATCH(new Request('https://portal.example.test/api/instance/settings', { method: 'PATCH', headers: { 'if-match': '"0"' } }))).json())
    .toMatchObject({ code: 'instance_unavailable' });
});
