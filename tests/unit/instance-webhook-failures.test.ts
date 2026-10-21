import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/webhooks/github/route';
import type { InstanceControl } from '../../lib/instance/store';
import { instanceControl, readyInstance } from '../fixtures/instance';

const state = vi.hoisted(() => ({ host: vi.fn(), connect: vi.fn(), read: vi.fn(), check: vi.fn(), rate: vi.fn(), index: vi.fn(), receipt: vi.fn(), insert: vi.fn(), close: vi.fn() }));
vi.mock('../../lib/instance/bootstrap', () => ({ readInstanceHost: state.host }));
vi.mock('../../lib/mongo', () => ({ connectMongo: state.connect }));
vi.mock('../../lib/instance/access', async original => ({ ...await original<typeof import('../../lib/instance/access')>(), consumeInstanceRate: state.rate }));
vi.mock('../../lib/instance/store', async original => ({ ...await original<typeof import('../../lib/instance/store')>(), readInstance: state.read, recordInstanceCheck: state.check }));
let control: InstanceControl;
const body = JSON.stringify({ hook_id: 7, hook: { id: 7 } }); const payloadDigest = createHash('sha256').update(body).digest('hex');
const request = () => new Request('https://portal.example.test/api/webhooks/github', { method: 'POST', headers: {
  'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': randomUUID(),
  'x-hub-signature-256': `sha256=${createHmac('sha256', 'synthetic').update(body).digest('hex')}`,
}, body });
beforeEach(() => {
  vi.resetAllMocks(); control = instanceControl(); control.candidate = readyInstance(control.instanceId, control.createdAt).active; control.nextBundleVersion = 2;
  vi.stubEnv('INSTANCE_ID', control.instanceId);
  state.host.mockResolvedValue({ instanceId: control.instanceId, config: {}, keyring: { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } } });
  state.connect.mockResolvedValue({ db: { collection: () => ({ createIndex: state.index, findOne: state.receipt, insertOne: state.insert }) }, client: { close: state.close } });
  state.read.mockImplementation(async () => control); state.receipt.mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllEnvs(); });

it.each(['host', 'connection', 'control', 'index', 'receipt', 'rate', 'insert', 'check'] as const)('fails closed without recording setup proof when %s is unavailable', async condition => {
  const failure = new Error('SYNTHETIC_PRIVATE_PROVIDER_BODY');
  if (condition === 'host') state.host.mockRejectedValue(failure);
  if (condition === 'connection') state.connect.mockRejectedValue(failure);
  if (condition === 'control') state.read.mockRejectedValue(failure);
  if (condition === 'index') state.index.mockRejectedValue(failure);
  if (condition === 'receipt') state.receipt.mockRejectedValue(failure);
  if (condition === 'rate') state.rate.mockRejectedValue(failure);
  if (condition === 'insert') state.insert.mockRejectedValue(failure);
  if (condition === 'check') state.check.mockRejectedValue(failure);
  const response = await POST(request()); expect(response.status).toBe(503); expect(await response.text()).not.toContain(failure.message);
  expect(state.close).toHaveBeenCalledTimes(condition === 'host' || condition === 'connection' ? 0 : 1);
});

it.each(['missing', 'payload', 'event', 'version', 'matching'] as const)('checks the durable %s receipt after an insert race', async condition => {
  state.insert.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));
  const duplicate = { payloadDigest, event: 'ping', candidateVersion: 1 };
  if (condition === 'payload') duplicate.payloadDigest = 'b'.repeat(64);
  if (condition === 'event') duplicate.event = 'push';
  if (condition === 'version') duplicate.candidateVersion++;
  state.receipt.mockResolvedValueOnce(null).mockResolvedValueOnce(condition === 'missing' ? null : duplicate);
  const response = await POST(request()); expect(response.status).toBe(condition === 'matching' ? 200 : 409);
  expect(state.check).toHaveBeenCalledTimes(condition === 'matching' ? 1 : 0);
});

it.each(['missing', 'failed', 'passed', 'read failure'] as const)('rechecks %s current proof after a concurrent check update', async condition => {
  state.check.mockRejectedValue(new Error('instance_conflict'));
  const latest = structuredClone(control);
  latest.candidate!.checks = [{ type: 'github_webhook', candidateVersion: 1, at: new Date(), status: condition === 'passed' ? 'passed' : 'failed', code: 'provider_ok' }];
  state.read.mockResolvedValueOnce(control);
  if (condition === 'read failure') state.read.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_BODY'));
  else state.read.mockResolvedValueOnce(condition === 'missing' ? null : latest);
  expect((await POST(request())).status).toBe(condition === 'passed' ? 200 : 409);
  expect(state.close).toHaveBeenCalledOnce();
});
