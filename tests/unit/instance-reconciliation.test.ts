import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcileInstanceActivation } from '../../lib/instance/activation';
import type { InstanceControl } from '../../lib/instance/store';
import { CatalogSchema } from '../../lib/catalog';
import { readyInstance } from '../fixtures/instance';
import { catalogs } from '../fixtures/catalogs';

const state = vi.hoisted(() => ({ host: vi.fn(), connect: vi.fn(), read: vi.fn(), update: vi.fn(), health: vi.fn(), provider: vi.fn() }));
vi.mock('../../lib/instance/bootstrap', () => ({ readInstanceHost: state.host }));
vi.mock('../../lib/mongo', () => ({ connectMongo: state.connect }));
vi.mock('../../lib/instance/store', async original => ({ ...await original<typeof import('../../lib/instance/store')>(), readInstance: state.read, updateInstance: state.update }));
vi.mock('../../lib/operations/health', () => ({ checkHealth: state.health }));
vi.mock('../../lib/sync/github', () => ({ createGitHubClient: state.provider }));

let control: InstanceControl;
let selected: ReturnType<typeof CatalogSchema.parse>[];
const close = vi.fn(); const fence = vi.fn(); const findOne = vi.fn(); const verifyRepository = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  const now = new Date(); control = readyInstance(undefined, new Date(now.getTime() - 1000));
  control.candidate = structuredClone(control.active); control.candidate!.version = control.nextBundleVersion++;
  control.candidate!.impact = { categories: ['preferences'], securityEpochIncrement: false, revalidateSources: false, confirmationNonce: randomUUID() };
  const id = randomUUID(); const deadline = new Date(now.getTime() + 60_000);
  control.gate = { state: 'closing', activationId: id, deadline };
  control.activation = { id, from: 1, to: 2, actor: control.administrators[0].bindingId, phase: 'draining', deadline, fencedCatalogIds: [], result: null };
  selected = [];
  state.host.mockResolvedValue({ instanceId: control.instanceId, config: { contentRoot: '/synthetic' }, marker: { phase: 'initialized' },
    keyring: { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } } });
  state.connect.mockResolvedValue({ client: { close }, db: { collection: () => ({
    find: () => ({ limit: () => ({ toArray: async () => selected }) }), updateOne: fence, findOne,
  }) } });
  state.read.mockImplementation(async () => structuredClone(control));
  state.update.mockImplementation(async (_db, _id, revision, mutate) => {
    expect(revision).toBe(control.revision); control = mutate(structuredClone(control)); control.revision++; return structuredClone(control);
  });
  state.health.mockResolvedValue({ status: 'ok' }); state.provider.mockReturnValue({ verifyRepository });
  fence.mockResolvedValue({ matchedCount: 1 }); findOne.mockResolvedValue(null);
});
afterEach(() => { vi.useRealTimers(); });

it('does no activation work for absent state, completed activation or bootstrap-owned adoption', async () => {
  const initial = structuredClone(control);
  state.read.mockResolvedValueOnce(null); expect(await reconcileInstanceActivation()).toBe(false);
  control.activation = null; control.gate = { state: 'open', activationId: null, deadline: null };
  expect(await reconcileInstanceActivation()).toBe(false);
  control = initial; control.activation!.actor = 'bootstrap'; expect(await reconcileInstanceActivation()).toBe(false);
  expect(state.update).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(3);
});

it('bounds catalog fencing and preserves the active bundle when upstream source validation fails', async () => {
  selected = Array.from({ length: 21 }, () => CatalogSchema.parse(catalogs[0]));
  expect(await reconcileInstanceActivation()).toBe(false); expect(fence).not.toHaveBeenCalled(); expect(control.active!.version).toBe(1);
  selected = [CatalogSchema.parse(catalogs[0])]; control.candidate!.impact!.revalidateSources = true;
  verifyRepository.mockResolvedValueOnce({ repositoryId: selected[0].github.repositoryId + 1 });
  expect(await reconcileInstanceActivation()).toBe(false); expect(control.active!.version).toBe(1); expect(fence).not.toHaveBeenCalled();
  verifyRepository.mockRejectedValueOnce(new Error('SYNTHETIC_UPSTREAM_BODY'));
  expect(await reconcileInstanceActivation()).toBe(false); expect(control.active!.version).toBe(1);
  verifyRepository.mockResolvedValue({ repositoryId: selected[0].github.repositoryId });
  expect(await reconcileInstanceActivation()).toBe(true); expect(control.active!.version).toBe(2);
});

it('requires a successful fence or a durable matching fence before changing the active generation', async () => {
  selected = [CatalogSchema.parse(catalogs[0])]; fence.mockResolvedValue({ matchedCount: 0 });
  expect(await reconcileInstanceActivation()).toBe(false); expect(control.active!.version).toBe(1);
  findOne.mockResolvedValue(selected[0]);
  expect(await reconcileInstanceActivation()).toBe(true); expect(control.activation).toBeNull();
});

it.each([2, 3, 4])('aborts cutover if authority disappears or changes at read checkpoint %s', async checkpoint => {
  selected = [CatalogSchema.parse(catalogs[0])];
  for (const mutation of ['missing', 'identity', 'phase', 'deadline', 'candidate'] as const) {
    if (mutation === 'candidate' && checkpoint !== 4 || mutation === 'deadline' && checkpoint === 3) continue;
    const original = structuredClone(control); let reads = 0;
    state.read.mockImplementation(async () => {
      const value = structuredClone(control); if (++reads !== checkpoint) return value;
      if (mutation === 'missing') return null;
      if (mutation === 'identity') { value.activation!.id = randomUUID(); value.gate.activationId = value.activation!.id; }
      if (mutation === 'phase') value.activation!.phase = 'maintenance';
      if (mutation === 'deadline') value.activation!.deadline = new Date(Date.now() - 1);
      if (mutation === 'candidate') value.candidate!.version = 1;
      return value;
    });
    const result = await reconcileInstanceActivation();
    expect(result, `${checkpoint}:${mutation}`).toBe(false); expect(control.active!.version).toBe(1);
    control = original;
  }
});

it('keeps expired identity continuity proof in maintenance without retiring any administrator', async () => {
  const candidate = control.candidate!; candidate.impact!.securityEpochIncrement = true;
  candidate.ownerProof = { instanceId: control.instanceId, candidateVersion: candidate.version, issuer: candidate.zitadel.issuer,
    subject: 'synthetic-next-owner', projectId: candidate.zitadel.projectId, securityEpoch: control.securityEpoch,
    nonce: randomUUID(), expiresAt: new Date(Date.now() - 1) };
  expect(await reconcileInstanceActivation()).toBe(false); expect(control.active!.version).toBe(1);
  expect(control.administrators[0].status).toBe('active'); expect(control.gate.state).toBe('maintenance');
});

it.each(['storage', 'marker', 'request', 'deadline'] as const)('keeps committed activation unavailable until adoption satisfies %s', async condition => {
  control.active = control.candidate as InstanceControl['active']; control.candidate = null;
  control.lifecycle = 'maintenance'; control.gate.state = 'maintenance'; control.activation!.phase = 'adopting';
  if (condition === 'storage') state.health.mockResolvedValue({ status: 'unavailable' });
  if (condition === 'marker') (await state.host()).marker.phase = 'sealed';
  if (condition === 'request') control.admissions.push({ id: randomUUID(), purpose: 'request', createdAt: control.createdAt,
    expiresAt: new Date(Date.now() + 1000), bundleVersion: 2, securityEpoch: 1, recoveryEpoch: 1 });
  if (condition === 'deadline') {
    vi.useFakeTimers(); state.health.mockImplementation(async () => { vi.setSystemTime(Date.now() + 120_000); return { status: 'ok' }; });
  }
  expect(await reconcileInstanceActivation()).toBe(false); expect(control.lifecycle).toBe('maintenance'); expect(control.active!.version).toBe(2);
});
