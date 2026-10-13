import { beforeEach, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/admin/repos/sync/route';

const state = vi.hoisted(() => ({ requireAdmin: vi.fn(), admitSyncJob: vi.fn(), newManualJobId: vi.fn(), readAdminJson: vi.fn(), adminErrorResponse: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({
  requireAdmin: state.requireAdmin,
  readAdminJson: state.readAdminJson,
  adminErrorResponse: state.adminErrorResponse,
}));
vi.mock('@/lib/sync/jobs', () => ({ admitSyncJob: state.admitSyncJob, newManualJobId: state.newManualJobId }));

const key = '00000000-0000-4000-8000-000000000099';
const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];

function request(value: unknown, headers: Record<string, string> = {}) {
  return new Request('https://docs.example.invalid/api/admin/repos/sync', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...headers }, body: JSON.stringify(value),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.requireAdmin.mockResolvedValue({ db: { marker: 'synthetic' } });
  state.readAdminJson.mockImplementation((value: Request) => value.json());
  state.adminErrorResponse.mockImplementation(error => Response.json({ error: String(error) }, { status: 400 }));
  state.newManualJobId.mockImplementation((id: string, idempotencyKey: string) => `manual:${id}:${idempotencyKey}`);
});

it('admits a selected set through the admin guard and returns each durable repository job', async () => {
  state.admitSyncJob.mockImplementation(async (_db, input) => ({
    job: { state: input.catalogId === ids[0] ? 'queued' : 'running', result: null },
  }));
  const req = request({ ids });
  const response = await POST(req);

  expect(state.requireAdmin).toHaveBeenCalledWith(req, true);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ jobs: [
    { catalogId: ids[0], status: 'pending' }, { catalogId: ids[1], status: 'running' },
  ] });
  expect(state.newManualJobId).toHaveBeenNthCalledWith(1, ids[0], key);
  expect(state.newManualJobId).toHaveBeenNthCalledWith(2, ids[1], key);
});

it('preserves partial admission results and sanitizes unknown storage failures', async () => {
  state.admitSyncJob.mockImplementation(async (_db, input) => {
    if (input.catalogId === ids[0]) throw new Error('sync_rate_limited');
    throw new Error('private database detail');
  });
  const response = await POST(request({ ids }));

  expect(await response.json()).toMatchObject({ jobs: [
    { catalogId: ids[0], status: 'failed', error: 'sync_rate_limited' },
    { catalogId: ids[1], status: 'failed', error: 'sync_storage_unavailable' },
  ] });
});

it('maps terminal job results and keeps the JSON content-type optional', async () => {
  state.admitSyncJob.mockImplementation(async (_db, input) => ({
    job: input.catalogId === ids[0]
      ? { state: 'succeeded', result: null }
      : { state: 'failed', result: { kind: 'failure', code: 'github_invalid_content' } },
  }));
  const req = request({ ids });
  req.headers.delete('content-type');
  const response = await POST(req);

  expect(await response.json()).toMatchObject({ jobs: [
    { catalogId: ids[0], status: 'succeeded' },
    { catalogId: ids[1], status: 'failed', error: 'github_invalid_content' },
  ] });

  const unsupported = await POST(request({ ids }, { 'content-type': 'text/plain' }));
  expect(unsupported.status).toBe(400);
  expect(state.admitSyncJob).toHaveBeenCalledTimes(2);
});

it('rejects duplicate or empty selections before admitting any jobs', async () => {
  const duplicate = await POST(request({ ids: [ids[0], ids[0]] }));
  const empty = await POST(request({ ids: [] }));

  expect(duplicate.status).toBe(400);
  expect(empty.status).toBe(400);
  expect(state.admitSyncJob).not.toHaveBeenCalled();
});
