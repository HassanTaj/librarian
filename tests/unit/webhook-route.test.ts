import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/webhooks/github/route';

const state = vi.hoisted(() => ({
  getMongo: vi.fn(), loadConfig: vi.fn(), verifyGitHubSignature: vi.fn(), blockCatalogForAccessLoss: vi.fn(),
  admitControlReceipt: vi.fn(), admitSyncJob: vi.fn(), newGitHubJobId: vi.fn(),
}));

vi.mock('../../lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('../../lib/config', () => ({ loadConfig: state.loadConfig }));
vi.mock('../../lib/sync/webhook', () => ({ verifyGitHubSignature: state.verifyGitHubSignature }));
vi.mock('../../lib/catalog', () => ({ blockCatalogForAccessLoss: state.blockCatalogForAccessLoss }));
vi.mock('../../lib/sync/jobs', () => ({
  admitControlReceipt: state.admitControlReceipt,
  admitSyncJob: state.admitSyncJob,
  newGitHubJobId: state.newGitHubJobId,
}));

const config = { githubAppId: 'synthetic-app', githubWebhookSecret: 'synthetic-secret' };
const catalog = { _id: '00000000-0000-4000-8000-000000000001', github: {
  repositoryId: 41, installationId: 51, owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs',
} };
const delivery = '00000000-0000-4000-8000-000000000099';
const push = (ref = 'refs/heads/main') => JSON.stringify({ installation: { id: 51 },
  repository: { id: 41, full_name: 'synthetic/docs' }, ref });
const rows: Record<string, unknown[]> = { syncJobs: [], controlReceipts: [], catalogs: [] };
const failures: Record<string, unknown> = {};

function fakeDb() {
  return { collection: (name: string) => ({ find: () => {
    const cursor = {
      sort: () => cursor,
      limit: () => cursor,
      toArray: async () => {
        if (Object.hasOwn(failures, name)) throw failures[name];
        return rows[name];
      },
    };
    return cursor;
  } }) };
}

function request(body: string, event = 'push', options: { contentType?: string; id?: string } = {}) {
  return new Request('http://localhost/api/webhooks/github', { method: 'POST', headers: {
    'content-type': options.contentType ?? 'application/json',
    'x-github-delivery': options.id ?? delivery,
    'x-github-event': event,
    'x-hub-signature-256': 'sha256=synthetic',
  }, body });
}

async function outcome(response: Response) { return { status: response.status, body: await response.json() }; }

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(rows)) rows[key] = [];
  for (const key of Object.keys(failures)) delete failures[key];
  state.getMongo.mockResolvedValue({ db: fakeDb() });
  state.loadConfig.mockResolvedValue(config);
  state.verifyGitHubSignature.mockReturnValue(true);
  state.newGitHubJobId.mockImplementation((_app: string, id: string, catalogId: string) => `github:synthetic:${id}:${catalogId}`);
  state.blockCatalogForAccessLoss.mockResolvedValue('blocked');
  state.admitControlReceipt.mockImplementation(async (_db: unknown, input: { _id: string }) => ({ receipt: { _id: input._id }, duplicate: false }));
  state.admitSyncJob.mockImplementation(async (_db: unknown, input: { _id: string }) => ({ job: { _id: input._id }, duplicate: false }));
});

it('rejects invalid request headers, oversized bodies, signatures, and runtime dependencies', async () => {
  expect((await outcome(await POST(request('{}', 'push', { contentType: 'text/plain' })))).status).toBe(400);
  expect((await outcome(await POST(request('{}', 'push', { id: 'invalid' })))).status).toBe(400);
  expect((await outcome(await POST(request('{}', 'Bad!')))).status).toBe(400);
  expect((await outcome(await POST(request(' '.repeat(1024 * 1024 + 1))))).status).toBe(413);
  state.verifyGitHubSignature.mockReturnValueOnce(false);
  expect((await outcome(await POST(request('{}')))).status).toBe(403);
  state.loadConfig.mockRejectedValueOnce(new Error('synthetic config failure'));
  expect((await outcome(await POST(request('{}')))).status).toBe(503);
  state.getMongo.mockRejectedValueOnce(new Error('synthetic storage failure'));
  expect((await outcome(await POST(request('{}')))).status).toBe(503);
  failures.syncJobs = new Error('synthetic receipt query failure');
  expect((await outcome(await POST(request('{}')))).status).toBe(503);
});

it('validates signed JSON and handles unsupported, malformed, and no-op removal events', async () => {
  expect((await outcome(await POST(request('{')))).body).toEqual({ status: 'invalid_payload' });
  expect((await outcome(await POST(request('{}', 'push')))).body).toEqual({ status: 'invalid_payload' });
  expect((await outcome(await POST(request('{"other":true}', 'ping')))).body).toEqual({ status: 'ignored' });
  expect((await outcome(await POST(request('{"action":"added"}', 'installation')))).body).toEqual({ status: 'ignored' });
  expect((await outcome(await POST(request('{"action":"removed","installation":{"id":51},"repositories_removed":[]}', 'installation_repositories')))).body)
    .toEqual({ status: 'ignored' });
  rows.catalogs = [catalog];
  expect((await outcome(await POST(request('{"action":"deleted","repository":{"id":41}}', 'repository')))).body).toEqual({ status: 'accepted', jobs: ['github:synthetic:' + delivery + ':' + catalog._id] });
});

it('blocks repository and installation removals before storing control receipts', async () => {
  rows.catalogs = [catalog];
  const repositoryDelete = await outcome(await POST(request(JSON.stringify({ action: 'deleted', repository: { id: 41 }, installation: { id: 51 } }), 'repository')));
  expect(repositoryDelete).toMatchObject({ status: 202, body: { status: 'accepted' } });
  expect(state.blockCatalogForAccessLoss).toHaveBeenCalledWith(expect.anything(), { catalogId: catalog._id, installationId: 51, repositoryId: 41 });

  state.admitControlReceipt.mockImplementationOnce(async (_db: unknown, input: { _id: string }) => ({ receipt: { _id: input._id }, duplicate: true }));
  const installationDelete = await outcome(await POST(request('{"action":"deleted","installation":{"id":51}}', 'installation', { id: '00000000-0000-4000-8000-000000000098' })));
  expect(installationDelete.status).toBe(200);
  expect(installationDelete.body.status).toBe('duplicate');

  rows.catalogs = [];
  const controlBody = '{"action":"deleted","installation":{"id":51}}';
  rows.controlReceipts = [{ _id: 'saved-control', payloadDigest: createHash('sha256').update(controlBody).digest('hex'), event: 'installation' }];
  expect(await outcome(await POST(request(controlBody, 'installation')))).toMatchObject({
    status: 200, body: { status: 'duplicate', jobs: ['saved-control'] },
  });
  rows.controlReceipts = [];
  state.blockCatalogForAccessLoss.mockResolvedValueOnce('unavailable');
  rows.catalogs = [catalog];
  expect((await outcome(await POST(request('{"action":"deleted","installation":{"id":51}}', 'installation')))).status).toBe(503);
  state.blockCatalogForAccessLoss.mockResolvedValueOnce('missing');
  expect(await outcome(await POST(request('{"action":"deleted","installation":{"id":51}}', 'installation', { id: '00000000-0000-4000-8000-000000000097' }))))
    .toEqual({ status: 202, body: { status: 'ignored' } });
});

it('rejects invalid control actions, reports storage failures, and preserves receipt replay outcomes', async () => {
  const invalid = await outcome(await POST(request('{"action":"deleted","repository":{"id":0}}', 'repository')));
  expect(invalid).toMatchObject({ status: 400, body: { status: 'invalid_payload' } });
  rows.catalogs = [catalog];
  failures.catalogs = new Error('synthetic catalog query failure');
  expect((await outcome(await POST(request('{"action":"deleted","repository":{"id":41}}', 'repository')))).status).toBe(503);
  delete failures.catalogs;
  state.admitControlReceipt.mockRejectedValueOnce(new Error('sync_replay_conflict'));
  expect((await outcome(await POST(request('{"action":"deleted","repository":{"id":41}}', 'repository')))).status).toBe(409);
  state.admitControlReceipt.mockRejectedValueOnce(new Error('synthetic receipt write failure'));
  expect((await outcome(await POST(request('{"action":"deleted","repository":{"id":41}}', 'repository')))).status).toBe(503);
  rows.catalogs = [];
  rows.controlReceipts = [{ _id: `github:synthetic:${delivery}:${catalog._id}`, payloadDigest: 'different', event: 'repository' }];
  expect((await outcome(await POST(request('{"action":"deleted","repository":{"id":41}}', 'repository')))).status).toBe(409);
});

it('admits only current matching branch pushes and handles duplicate and failed receipts', async () => {
  expect((await outcome(await POST(request(push('refs/tags/v1'))))).body).toEqual({ status: 'ignored' });
  expect((await outcome(await POST(request(push())))).body).toEqual({ status: 'ignored' });
  rows.catalogs = [catalog];
  failures.catalogs = new Error('synthetic catalog query failure');
  expect((await outcome(await POST(request(push())))).status).toBe(503);
  delete failures.catalogs;
  state.admitSyncJob.mockRejectedValueOnce(new Error('sync_replay_conflict'));
  expect((await outcome(await POST(request(push())))).status).toBe(409);
  state.admitSyncJob.mockRejectedValueOnce(new Error('sync_rate_limited'));
  expect((await outcome(await POST(request(push())))).status).toBe(429);
  state.admitSyncJob.mockRejectedValueOnce(new Error('synthetic admission failure'));
  expect((await outcome(await POST(request(push())))).status).toBe(503);
  state.admitSyncJob.mockImplementationOnce(async (_db: unknown, input: { _id: string }) => ({ job: { _id: input._id }, duplicate: true }));
  expect((await outcome(await POST(request(push())))).body.status).toBe('duplicate');
  rows.syncJobs = [{ _id: `github:synthetic:${delivery}:${catalog._id}`, payloadDigest: 'old', origin: 'github', event: 'push' }];
  expect((await outcome(await POST(request(push())))).status).toBe(409);
});
