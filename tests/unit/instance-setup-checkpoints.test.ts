import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST as finalize } from '../../app/api/instance/setup/finalize/route';
import { POST as check } from '../../app/api/instance/setup/check/route';
import { issueSetupOwnerProof } from '../../lib/instance/access';
import type { InstanceControl } from '../../lib/instance/store';
import { instanceControl, readyInstance } from '../fixtures/instance';

const state = vi.hoisted(() => ({ host: vi.fn(), connect: vi.fn(), read: vi.fn(), raw: vi.fn(), role: vi.fn(), session: vi.fn(), rate: vi.fn(),
  commit: vi.fn(), reconcile: vi.fn(), record: vi.fn(), provider: vi.fn(), run: vi.fn(), command: vi.fn(), close: vi.fn() }));
vi.mock('../../lib/instance/bootstrap', () => ({ readInstanceHost: state.host }));
vi.mock('../../lib/mongo', () => ({ connectMongo: state.connect }));
vi.mock('../../lib/instance/store', async original => ({ ...await original<typeof import('../../lib/instance/store')>(), readInstance: state.read, recordInstanceCheck: state.record }));
vi.mock('../../lib/instance/activation', async original => ({ ...await original<typeof import('../../lib/instance/activation')>(), commitInitialInstance: state.commit, reconcileInitialAdoption: state.reconcile }));
vi.mock('../../lib/instance/access', async original => ({ ...await original<typeof import('../../lib/instance/access')>(), readInstanceSetupSession: state.session, consumeInstanceRate: state.rate,
  withInstanceProviderCheck: async (_db: unknown, _id: string, operation: () => Promise<unknown>) => operation() }));
vi.mock('../../lib/instance/validation', () => ({ createProviderCheckRunner: state.provider }));
let control: InstanceControl; let payload: { candidateVersion: number; confirmationNonce: string; confirm: true };
const origin = 'https://portal.example.test';
const request = (body: unknown = payload, headers: Record<string, string> = {}) => new Request(`${origin}/api/instance/setup/finalize`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', 'if-match': `"${control.editRevision}"`,
    cookie: '__Host-librarian_setup=synthetic-session', 'x-csrf-token': 'synthetic-csrf', ...headers }, body: JSON.stringify(body),
});
function committed(ready = true) {
  const value = readyInstance(control.instanceId, control.createdAt); value.active = structuredClone(control.candidate) as InstanceControl['active'];
  value.updatedAt = control.updatedAt;
  if (!ready) { value.lifecycle = 'maintenance'; value.gate.state = 'maintenance'; } return value;
}
beforeEach(() => {
  vi.resetAllMocks(); const now = new Date(); control = instanceControl(undefined, new Date(now.getTime() - 1000)); control.updatedAt = now;
  control.candidate = readyInstance(control.instanceId, control.createdAt).active; control.nextBundleVersion = 2;
  const candidate = control.candidate!; candidate.impact = { categories: [], securityEpochIncrement: false, revalidateSources: false, confirmationNonce: randomUUID() };
  const identity = { issuer: candidate.zitadel.issuer, projectId: candidate.zitadel.projectId, subject: 'synthetic-owner' };
  candidate.ownerProof = issueSetupOwnerProof(control, identity, now); control.lifecycle = 'awaiting_owner';
  candidate.checks = [{ type: 'zitadel_owner_login', candidateVersion: 1, at: now, status: 'passed', code: 'provider_ok' }];
  payload = { candidateVersion: 1, confirmationNonce: candidate.impact.confirmationNonce, confirm: true };
  state.host.mockResolvedValue({ instanceId: control.instanceId, setupOrigin: origin, config: {}, policy: { origins: [] },
    keyring: { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } } });
  state.read.mockImplementation(async () => control); state.raw.mockImplementation(async () => control);
  state.role.mockResolvedValue({ ...identity, roles: ['librarian-instance-admin'], verifiedAt: now });
  state.connect.mockResolvedValue({ db: { command: state.command, collection: (name: string) => ({ findOne: name === 'identity_authorizations' ? state.role : state.raw }) }, client: { close: state.close } });
  state.commit.mockImplementation(async () => ({ ...control, editRevision: control.editRevision + 1 }));
  state.reconcile.mockResolvedValue(false); state.provider.mockReturnValue({ run: state.run });
  state.run.mockResolvedValue({ type: 'github_structure', candidateVersion: 1, status: 'failed', code: 'invalid_configuration' });
  state.record.mockImplementation(async (_db, _id, result) => {
    control.candidate!.checks = [...control.candidate!.checks.filter(item => item.type !== result.type), result]; return structuredClone(control);
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

it.each(['origin', 'input', 'stale', 'missing', 'candidate', 'expired owner', 'owner epoch'] as const)('rejects %s finalization before a durable commit', async condition => {
  let status = 409; let body: unknown = payload; const headers: Record<string, string> = {};
  if (condition === 'origin') { headers.origin = 'https://attacker.example.test'; status = 403; }
  if (condition === 'input') { body = { ...payload, confirm: false }; status = 400; }
  if (condition === 'stale') headers['if-match'] = '"999"';
  if (condition === 'missing') state.read.mockResolvedValue(null);
  if (condition === 'candidate') control.candidate = null;
  if (condition === 'expired owner') control.candidate!.ownerProof!.expiresAt = new Date(Date.now() - 1);
  if (condition === 'owner epoch') control.candidate!.ownerProof!.securityEpoch++;
  expect((await finalize(request(body, headers))).status).toBe(status); expect(state.commit).not.toHaveBeenCalled();
});

it.each(['conflict replay', 'conflict missing', 'conflict read failure', 'unavailable', 'non-error'] as const)('preserves an unconfirmed outcome for %s', async condition => {
  state.commit.mockRejectedValue(condition.startsWith('conflict') ? new Error('instance_conflict') : condition === 'non-error' ? 'SYNTHETIC_PRIVATE_BODY' : new Error('instance_unavailable'));
  state.read.mockResolvedValueOnce(control).mockResolvedValueOnce(control);
  if (condition === 'conflict read failure') state.read.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_BODY'));
  else state.read.mockResolvedValueOnce(condition === 'conflict replay' ? committed(false) : null);
  const response = await finalize(request()); expect(response.status).toBe(condition === 'conflict replay' ? 202 : condition.startsWith('conflict') ? 409 : 503);
  expect(await response.text()).not.toContain('SYNTHETIC_PRIVATE_BODY'); expect(state.close).toHaveBeenCalledOnce();
});

it.each(['ready', 'pending', 'missing', 'closing'] as const)('reports an exact replay as %s only after reconciliation', async condition => {
  const existing = committed(false); const latest = committed();
  if (condition === 'closing') latest.gate.state = 'maintenance';
  state.read.mockResolvedValueOnce(existing).mockResolvedValueOnce(condition === 'missing' ? null : latest);
  state.reconcile.mockResolvedValue(condition !== 'pending');
  const response = await finalize(request()); expect(response.status).toBe(condition === 'ready' ? 200 : 202);
  expect(response.headers.get('etag')).toBe(condition === 'missing' ? null : '"0"'); expect(state.session).not.toHaveBeenCalled();
});

it('returns ready after a new durable commit is adopted and returns pending while adoption remains unavailable', async () => {
  expect((await finalize(request())).status).toBe(202);
  state.read.mockResolvedValueOnce(control).mockResolvedValueOnce(control).mockResolvedValueOnce(committed()); state.reconcile.mockResolvedValue(true);
  expect((await finalize(request())).status).toBe(200); expect(state.close).toHaveBeenCalledTimes(2);
});

it('records failed database checks and refuses to invent a missing saved result', async () => {
  state.command.mockRejectedValue(new Error('SYNTHETIC_DATABASE_URI'));
  const response = await check(request({ candidateVersion: 1, type: 'database' }));
  expect(await response.json()).toMatchObject({ status: 'failed', code: 'provider_unavailable' });
  state.record.mockResolvedValue({ ...control, candidate: null });
  expect((await check(request({ candidateVersion: 1, type: 'database' }))).status).toBe(503);
});

it.each(['missing', 'candidate', 'lifecycle', 'consumed', 'stale', 'version', 'input', 'origin'] as const)('denies %s provider checks before provider work', async condition => {
  let body: unknown = { candidateVersion: 1, type: 'github_structure' }; const headers: Record<string, string> = {}; let status = 503;
  if (condition === 'missing') state.read.mockResolvedValue(null);
  if (condition === 'candidate') control.candidate = null;
  if (condition === 'lifecycle') control.lifecycle = 'maintenance';
  if (condition === 'consumed') control.bootstrap.consumedAt = new Date();
  if (condition === 'stale') { headers['if-match'] = '"999"'; status = 409; }
  if (condition === 'version') { body = { candidateVersion: 2, type: 'github_structure' }; status = 409; }
  if (condition === 'input') { body = { candidateVersion: 1, type: 'unknown' }; status = 400; }
  if (condition === 'origin') { headers.origin = 'https://attacker.example.test'; status = 403; }
  expect((await check(request(body, headers))).status).toBe(status); expect(state.provider).not.toHaveBeenCalled();
});

it('uses an existing exact webhook proof and confines the development CA to the approved local provider', async () => {
  control.candidate!.checks.push({ type: 'github_webhook', candidateVersion: 1, at: new Date(), status: 'passed', code: 'provider_ok' });
  expect(await (await check(request({ candidateVersion: 1, type: 'github_webhook' }))).json()).toMatchObject({ status: 'passed', code: 'provider_ok' });
  expect(state.record).not.toHaveBeenCalled();
  const root = await mkdtemp(join(tmpdir(), 'librarian-check-ca-'));
  try {
    const file = join(root, 'synthetic.pem'); await writeFile(file, 'synthetic-ca');
    const issuer = 'https://localhost:3229'; control.candidate!.zitadel.issuer = issuer; control.candidate!.ownerProof = null; control.lifecycle = 'configuring';
    const host = await state.host(); host.policy.origins = [{ origin: issuer, addresses: ['127.0.0.1'] }];
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('LIBRARIAN_TEST_GITHUB_API_ORIGIN', issuer); vi.stubEnv('LIBRARIAN_TEST_PROVIDER_CA_FILE', file);
    await check(request({ candidateVersion: 1, type: 'github_structure' }));
    expect(state.provider).toHaveBeenLastCalledWith(expect.objectContaining({ ca: { origin: issuer, certificate: Buffer.from('synthetic-ca') } }));
    host.policy.origins = []; await check(request({ candidateVersion: 1, type: 'github_structure' }));
    expect(state.provider.mock.calls.at(-1)![0]).not.toHaveProperty('ca');
  } finally { await rm(root, { recursive: true, force: true }); }
});
