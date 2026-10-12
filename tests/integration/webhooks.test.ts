import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { POST } from '../../app/api/webhooks/github/route';
import { closeMongo } from '../../lib/mongo';
import { blockCatalogForAccessLoss, newCatalogRecord, type Catalog } from '../../lib/catalog';
import type { ControlReceipt, SyncJob } from '../../lib/sync/jobs';
import { createStorageHarness } from './http-harness';

const signingSecret = 'synthetic-github-webhook-secret-with-enough-entropy';
const delivery = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
let storage: Awaited<ReturnType<typeof createStorageHarness>>;
let originalEnv: NodeJS.ProcessEnv;

async function writeConfig() {
  const configRoot = resolve(storage.root, 'config');
  await mkdir(configRoot);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const files = {
    AUTH_SECRET_FILE: 'auth-secret', AUTH_ZITADEL_SECRET_FILE: 'zitadel-secret', MONGODB_URI_FILE: 'mongo-uri',
    GITHUB_APP_PRIVATE_KEY_FILE: 'github-key', GITHUB_WEBHOOK_SECRET_FILE: 'webhook-secret',
    OAUTH_TOKEN_ENCRYPTION_KEY_FILE: 'oauth-key',
  };
  const values = {
    'auth-secret': 'synthetic-auth-secret-with-at-least-thirty-two-bytes', 'zitadel-secret': 'synthetic-zitadel-secret',
    'mongo-uri': `mongodb://127.0.0.1:27018/${storage.db.databaseName}`,
    'github-key': privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    'webhook-secret': signingSecret, 'oauth-key': Buffer.alloc(32, 7).toString('base64'),
  };
  for (const [name, value] of Object.entries(values)) await writeFile(resolve(configRoot, name), value);
  Object.assign(process.env, {
    NODE_ENV: 'test', AUTH_URL: 'http://localhost:3000', AUTH_TRUST_HOST: 'true', AUTH_ZITADEL_ID: 'synthetic.client',
    AUTH_ZITADEL_ISSUER: 'https://identity.example.test', ZITADEL_PROJECT_ID: 'synthetic_project',
    ZITADEL_API_AUDIENCE: 'synthetic_api', MONGODB_DATABASE: storage.db.databaseName, GITHUB_APP_ID: '12345',
    CONTENT_ROOT: storage.contentRoot,
    ...Object.fromEntries(Object.entries(files).map(([key, name]) => [key, resolve(configRoot, name)])),
  });
}

function pushBody(ref = 'refs/heads/main', repositoryId = 987) {
  return JSON.stringify({
    installation: { id: 888 },
    repository: { id: repositoryId, full_name: 'synthetic/docs' },
    ref, deleted: false,
  });
}

async function post(body: string, id: string, event = 'push', signature?: string, contentType = 'application/json') {
  const raw = Buffer.from(body);
  const signed = `sha256=${createHmac('sha256', signingSecret).update(raw).digest('hex')}`;
  return POST(new Request('http://localhost/api/webhooks/github', {
    method: 'POST', headers: {
      'content-type': contentType, 'x-github-delivery': id,
      'x-github-event': event, 'x-hub-signature-256': signature ?? signed,
    }, body: raw,
  }));
}

async function seedCatalog(id: string, slug: string, docsPath: string, repositoryId = 987) {
  const catalog = newCatalogRecord({ github: {
    repositoryId, installationId: 888, owner: 'synthetic', name: 'docs', branch: 'main', docsPath,
  }, slug, title: slug, visibility: 'private' });
  catalog._id = id;
  catalog.accessState = 'ready';
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
}

beforeAll(async () => {
  originalEnv = { ...process.env };
  storage = await createStorageHarness();
  await writeConfig();
  await seedCatalog('00000000-0000-4000-8000-000000000001', 'webhook-one', 'docs');
  await seedCatalog('00000000-0000-4000-8000-000000000002', 'webhook-two', 'manuals');
});

afterAll(async () => {
  await closeMongo();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await storage.close();
});

it('rejects missing, modified, and malformed signatures before creating receipts', async () => {
  const body = pushBody();
  const raw = Buffer.from(body);
  const valid = `sha256=${createHmac('sha256', signingSecret).update(raw).digest('hex')}`;
  const missing = await post(body, delivery(1), 'push', '');
  const modified = await post(`${body} `, delivery(2), 'push', valid);
  const malformed = await post(body, delivery(3), 'push', 'sha256=bad');
  expect([missing.status, modified.status, malformed.status]).toEqual([403, 403, 403]);
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments()).toBe(0);
});

it('rejects a raw body larger than 1 MiB without parsing or admitting it', async () => {
  const response = await post(' '.repeat(1024 * 1024 + 1), delivery(4));
  expect(response.status).toBe(413);
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments()).toBe(0);
});

it('validates declared body lengths and handles an absent request body', async () => {
  const raw = Buffer.from('{');
  const signature = `sha256=${createHmac('sha256', signingSecret).update(raw).digest('hex')}`;
  const headers = { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': signature };
  const declared = await POST(new Request('http://localhost/api/webhooks/github', { method: 'POST',
    headers: { ...headers, 'content-length': '1', 'x-github-delivery': delivery(19) }, body: raw }));
  expect(declared.status).toBe(400);
  const malformedLength = await POST(new Request('http://localhost/api/webhooks/github', { method: 'POST',
    headers: { ...headers, 'content-length': 'invalid', 'x-github-delivery': delivery(20) }, body: raw }));
  expect(malformedLength.status).toBe(413);

  const emptySignature = `sha256=${createHmac('sha256', signingSecret).update(Buffer.alloc(0)).digest('hex')}`;
  const empty = await POST(new Request('http://localhost/api/webhooks/github', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-github-delivery': delivery(21), 'x-github-event': 'push',
    'x-hub-signature-256': emptySignature,
  }, body: null }));
  expect(empty.status).toBe(400);
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments()).toBe(0);
});

it('durably accepts one receipt per matching catalog, then returns duplicate or conflict without new work', async () => {
  const body = pushBody();
  const response = await post(body, delivery(5));
  const receipt = await response.json();
  expect(response.status).toBe(202);
  expect(receipt).toMatchObject({ status: 'accepted' });
  expect(receipt.jobs).toHaveLength(2);
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments()).toBe(2);

  const duplicate = await post(body, delivery(5));
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({ status: 'duplicate', jobs: receipt.jobs });
  const conflict = await post(pushBody('refs/heads/main') + ' ', delivery(5));
  expect(conflict.status).toBe(409);
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments()).toBe(2);
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments({ state: 'queued' })).toBe(2);
});

it('ignores valid pushes for another repository, branch, or event', async () => {
  for (const [body, event, id] of [
    [pushBody('refs/heads/release'), 'push', delivery(6)],
    [pushBody('refs/heads/main', 999), 'push', delivery(7)],
    ['{}', 'ping', delivery(8)],
  ] as const) {
    const response = await post(body, id, event);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'ignored' });
  }
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments()).toBe(2);
});

it('rejects malformed signed requests and ignores non-branch, invalid-action, and unknown-installation events', async () => {
  expect((await post(pushBody(), delivery(12), 'push', undefined, 'text/plain')).status).toBe(400);
  expect((await post(pushBody(), '', 'push')).status).toBe(400);
  expect((await post(pushBody(), delivery(13), 'Bad!')).status).toBe(400);
  expect((await post('{', delivery(14))).status).toBe(400);
  expect((await post(JSON.stringify({ action: 'removed', installation: { id: 888 }, repositories_removed: 'not-an-array' }),
    delivery(15), 'installation_repositories')).status).toBe(400);
  expect(await (await post(pushBody('refs/tags/v1'), delivery(16))).json()).toEqual({ status: 'ignored' });
  expect(await (await post(JSON.stringify({ action: 'deleted', installation: { id: 999 } }), delivery(17), 'installation')).json())
    .toEqual({ status: 'ignored' });
});

it('ignores non-removal control actions and empty or unrelated repository removals', async () => {
  const noPayload = await post('null', delivery(22), 'installation');
  const installationCreated = await post(JSON.stringify({ action: 'created', installation: { id: 888 } }), delivery(23), 'installation');
  const repositoriesAdded = await post(JSON.stringify({ action: 'added' }), delivery(24), 'installation_repositories');
  const emptyRemoval = await post(JSON.stringify({ action: 'removed', installation: { id: 888 }, repositories_removed: [] }),
    delivery(25), 'installation_repositories');
  const repositoryCreated = await post(JSON.stringify({ action: 'created' }), delivery(26), 'repository');
  const unrelatedRepository = await post(JSON.stringify({ action: 'deleted', repository: { id: 9999 } }), delivery(27), 'repository');
  expect(noPayload.status).toBe(400);
  expect([installationCreated.status, repositoriesAdded.status, emptyRemoval.status, repositoryCreated.status, unrelatedRepository.status])
    .toEqual([202, 202, 202, 202, 202]);
  for (const response of [installationCreated, repositoriesAdded, emptyRemoval, repositoryCreated, unrelatedRepository]) {
    expect(await response.json()).toEqual({ status: 'ignored' });
  }
  expect(await storage.db.collection<ControlReceipt>('controlReceipts').countDocuments()).toBe(0);
});

it('returns unavailable when required runtime configuration cannot be read', async () => {
  const previous = process.env.AUTH_SECRET_FILE;
  process.env.AUTH_SECRET_FILE = resolve(storage.root, 'missing-auth-secret');
  try { expect((await post(pushBody(), delivery(18))).status).toBe(503); }
  finally { if (previous === undefined) delete process.env.AUTH_SECRET_FILE; else process.env.AUTH_SECRET_FILE = previous; }
});

it('preserves a partial durable admission and fills the missing catalog receipt on retry', async () => {
  await storage.db.collection<Catalog>('catalogs').updateOne(
    { _id: '00000000-0000-4000-8000-000000000002' }, { $set: { admissionReservations: 100_000 } });
  const body = pushBody();
  const first = await post(body, delivery(9));
  expect(first.status).toBe(503);
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments({
    _id: { $regex: `^github:12345:${delivery(9)}:` },
  })).toBe(1);

  await storage.db.collection<Catalog>('catalogs').updateOne(
    { _id: '00000000-0000-4000-8000-000000000002' }, { $set: { admissionReservations: 0 } });
  const retry = await post(body, delivery(9));
  expect(retry.status).toBe(202);
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments({
    _id: { $regex: `^github:12345:${delivery(9)}:` },
  })).toBe(2);
});

it('rejects a removal event with more repository references than the fixed admission bound', async () => {
  const body = JSON.stringify({ action: 'removed', installation: { id: 888 },
    repositories_removed: Array.from({ length: 1001 }, (_, index) => ({ id: index + 1 })) });
  expect((await post(body, delivery(11), 'installation_repositories')).status).toBe(400);
  expect(await storage.db.collection<ControlReceipt>('controlReceipts').countDocuments()).toBe(0);
});

it('blocks every removed repository catalog before durably acknowledging control receipts, outside normal admission quotas', async () => {
  await storage.db.collection<Catalog>('catalogs').updateMany({}, { $set: {
    admissionReservations: 100_000, rateWindow: { window: new Date(), count: 60 },
  } });
  const body = JSON.stringify({ action: 'removed', installation: { id: 888 }, repositories_removed: [{ id: 987 }] });
  const accepted = await post(body, delivery(10), 'installation_repositories');
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({ status: 'accepted', jobs: expect.arrayContaining([
    `github:12345:${delivery(10)}:00000000-0000-4000-8000-000000000001`,
    `github:12345:${delivery(10)}:00000000-0000-4000-8000-000000000002`,
  ]) });
  const blocked = await storage.db.collection<Catalog>('catalogs').find({}).toArray();
  expect(blocked).toHaveLength(2);
  expect(blocked.every(catalog => !catalog.enabled && catalog.accessState === 'blocked' && catalog.lease === null && catalog.leaseFence === 1 && catalog.authEpoch === 2)).toBe(true);
  expect(await storage.db.collection<ControlReceipt>('controlReceipts').countDocuments()).toBe(2);

  const duplicate = await post(body, delivery(10), 'installation_repositories');
  expect(duplicate.status).toBe(200);
  expect(await storage.db.collection<ControlReceipt>('controlReceipts').countDocuments()).toBe(2);
  const conflict = await post(body.replace('987', '988'), delivery(10), 'installation_repositories');
  expect(conflict.status).toBe(409);
  expect(await storage.db.collection<ControlReceipt>('controlReceipts').countDocuments()).toBe(2);
});

it('distinguishes missing and repeated access-loss events and fails closed when the fence is exhausted', async () => {
  await expect(blockCatalogForAccessLoss(storage.db, {
    catalogId: '00000000-0000-4000-8000-000000000003', installationId: 888, repositoryId: 987,
  })).resolves.toBe('missing');
  await expect(blockCatalogForAccessLoss(storage.db, {
    catalogId: '00000000-0000-4000-8000-000000000001', installationId: 888, repositoryId: 987,
  })).resolves.toBe('already_blocked');

  await storage.db.collection<Catalog>('catalogs').updateOne({ _id: '00000000-0000-4000-8000-000000000002' }, { $set: {
    enabled: true, accessState: 'ready', leaseFence: Number.MAX_SAFE_INTEGER,
  } });
  await expect(blockCatalogForAccessLoss(storage.db, {
    catalogId: '00000000-0000-4000-8000-000000000002', installationId: 888, repositoryId: 987,
  })).resolves.toBe('unavailable');
});

it('treats a concurrent catalog deletion during access-loss fencing as missing', async () => {
  const id = '00000000-0000-4000-8000-000000000003';
  await seedCatalog(id, 'webhook-race', 'docs', 999);
  const catalogs = storage.db.collection<Catalog>('catalogs');
  const findOne = catalogs.findOne.bind(catalogs);
  const findSpy = vi.spyOn(catalogs, 'findOne');
  findSpy.mockImplementationOnce((filter, options) => findOne(filter, options));
  findSpy.mockResolvedValueOnce(null as never);
  vi.spyOn(catalogs, 'findOneAndUpdate').mockResolvedValueOnce(null as never);
  const racingDb = new Proxy(storage.db, { get(target, property) {
    if (property === 'collection') return (name: string) => name === 'catalogs' ? catalogs : target.collection(name);
    return Reflect.get(target, property, target);
  } });
  try {
    await expect(blockCatalogForAccessLoss(racingDb, { catalogId: id, installationId: 888, repositoryId: 999 }))
      .resolves.toBe('missing');
  } finally {
    vi.restoreAllMocks();
    await catalogs.deleteOne({ _id: id });
  }
});
