import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ requireAdmin: vi.fn(), consumeRate: vi.fn(), readJson: vi.fn(),
  checkDatabase: vi.fn(), providerRun: vi.fn(), latest: null as null | { editRevision: number }, read: vi.fn(), record: vi.fn() }));
vi.mock('@/lib/instance/access', () => ({
  requireInstanceAdmin: state.requireAdmin,
  consumeInstanceRate: state.consumeRate,
  readInstanceJson: state.readJson,
  withInstanceProviderCheck: async (_db: unknown, _instanceId: string, operation: () => Promise<unknown>) => operation(),
  instanceErrorResponse: (error: unknown) => Response.json({ code: error instanceof Error ? error.message : 'unknown' }, { status: 400 }),
}));
vi.mock('@/lib/instance/database', () => ({ checkInstanceDatabase: state.checkDatabase }));
vi.mock('@/lib/instance/validation', () => ({ createProviderCheckRunner: () => ({ run: state.providerRun }) }));
vi.mock('@/lib/instance/secrets', () => ({ decryptInstanceSecret: () => null }));
vi.mock('@/lib/limits', () => ({ LIMITS: { instanceProofMs: 10 * 60_000 } }));
vi.mock('@/lib/instance/store', () => ({
  INSTANCE_CHECK_TYPES: ['database', 'zitadel_discovery', 'zitadel_owner_login', 'github_structure', 'github_authentication', 'github_permissions', 'github_installation', 'github_webhook'],
  readInstance: state.read,
  recordInstanceCheck: state.record,
}));

function makeControl() {
  const active = { version: 1, runtime: null as null | Record<string, unknown>,
    zitadel: { issuer: 'https://identity.example.test', clientId: 'client', projectId: 'project' }, github: { appId: '123' },
    secrets: { zitadelClientSecret: null, githubPrivateKey: null, githubWebhookSecret: null }, checks: [], ownerProof: null as null | {
      instanceId: string; candidateVersion: number; issuer: string; subject: string; projectId: string; securityEpoch: number; nonce: string; expiresAt: Date;
    } };
  return { instanceId: 'synthetic-instance', editRevision: 1, securityEpoch: 1, active,
    candidate: { ...active, version: 2, runtime: { mongodbUri: 'mongodb://127.0.0.1:27018/librarian', mongodbDatabase: 'librarian',
      authSecret: 'synthetic-auth', oauthTokenEncryptionKey: 'synthetic-oauth', trustHost: true, workerEnabled: false } as Record<string, unknown> | null,
      checks: [] as { type: string; candidateVersion: number; status: string; code: string; at: Date }[],
      ownerProof: null as typeof active.ownerProof } };
}
let control: ReturnType<typeof makeControl>;
let payload: { candidateVersion: number; type: string };

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('LIBRARIAN_TEST_GITHUB_API_ORIGIN', ''); vi.stubEnv('LIBRARIAN_TEST_PROVIDER_CA_FILE', '');
  control = makeControl();
  payload = { candidateVersion: 2, type: 'database' };
  state.latest = control;
  state.requireAdmin.mockImplementation(async () => ({ db: {}, host: { instanceId: control.instanceId, keyring: {}, policy: { origins: [] } }, control, binding: { bindingId: 'synthetic-owner' } }));
  state.read.mockImplementation(async () => state.latest);
  state.consumeRate.mockResolvedValue(undefined); state.readJson.mockImplementation(async () => payload);
  state.checkDatabase.mockResolvedValue(undefined); state.providerRun.mockResolvedValue({ status: 'passed', code: 'provider_ok' });
  state.record.mockImplementation(async (_db, _id, check: { type: string; candidateVersion: number; status: string; code: string; at: Date }) => {
    const next = structuredClone(control); next.editRevision++;
    next.candidate.checks = [...next.candidate.checks.filter(item => item.type !== check.type), check];
    return next;
  });
});

async function post() {
  const { POST } = await import('../../app/api/instance/settings/check/route');
  return POST(new Request('https://portal.example.test/api/instance/settings/check', { method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': `"${control.editRevision}"` }, body: '{}' }));
}

it('requires the saved runtime before running a database check', async () => {
  control.candidate.runtime = null;
  expect(await (await post()).json()).toMatchObject({ code: 'instance_invalid' });
  expect(state.checkDatabase).not.toHaveBeenCalled();
});

it('records owner login as passed only with a current proof and a fresh passed check', async () => {
  payload = { candidateVersion: 2, type: 'zitadel_owner_login' };
  const candidate = control.candidate;
  candidate.ownerProof = { instanceId: control.instanceId, candidateVersion: candidate.version, issuer: candidate.zitadel.issuer,
    subject: 'synthetic-owner', projectId: candidate.zitadel.projectId, securityEpoch: control.securityEpoch, nonce: 'synthetic-proof',
    expiresAt: new Date(Date.now() + 60_000) };
  candidate.checks = [{ type: 'zitadel_owner_login', candidateVersion: 2, status: 'passed', code: 'provider_ok', at: new Date() }];
  expect(await (await post()).json()).toMatchObject({ status: 'passed', code: 'provider_ok' });
  candidate.ownerProof = null;
  candidate.checks = [];
  expect(await (await post()).json()).toMatchObject({ status: 'not_run', code: 'not_run' });
});

it('loads the controlled development CA only for the exact localhost provider origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-provider-ca-'));
  try {
    const caFile = join(root, 'provider-ca.pem'); await writeFile(caFile, 'synthetic-provider-ca');
    const origin = 'https://localhost:8443';
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('LIBRARIAN_TEST_GITHUB_API_ORIGIN', origin); vi.stubEnv('LIBRARIAN_TEST_PROVIDER_CA_FILE', caFile);
    control.candidate.zitadel.issuer = origin;
    control.candidate.secrets.zitadelClientSecret = null;
    control.candidate.secrets.githubPrivateKey = null;
    control.candidate.secrets.githubWebhookSecret = null;
    state.requireAdmin.mockImplementation(async () => ({ db: {}, host: { instanceId: control.instanceId, keyring: {}, policy: { origins: [{ origin, addresses: ['127.0.0.1'] }] } }, control, binding: { bindingId: 'synthetic-owner' } }));
    payload = { candidateVersion: 2, type: 'github_webhook' };
    expect(await (await post()).json()).toMatchObject({ status: 'passed', code: 'provider_ok' });
    expect(state.providerRun).toHaveBeenCalledWith('github_webhook', control.candidate, {
      zitadelClientSecret: null, githubPrivateKey: null, githubWebhookSecret: null,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects a result when the saved settings changed while the check ran', async () => {
  payload = { candidateVersion: 2, type: 'database' };
  state.latest = { ...control, editRevision: control.editRevision + 1 };
  expect(await (await post()).json()).toMatchObject({ code: 'instance_conflict' });
  expect(state.record).not.toHaveBeenCalled();
});
