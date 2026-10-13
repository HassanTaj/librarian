import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Collection, ObjectId } from 'mongodb';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { adminCsrfToken } from '../../lib/auth/admin';
import { candidateManifestDigest } from '../../lib/public-approvals';
import { ensureCatalogStorage, newCatalogRecord, type Catalog } from '../../lib/catalog';
import { LIMITS } from '../../lib/limits';
import { claimNextSyncJob, ensureSyncJobStorage, type SyncJob } from '../../lib/sync/jobs';
import { GET as csrf } from '../../app/api/admin/csrf/route';
import { GET as list, POST as create } from '../../app/api/admin/repos/route';
import { DELETE as remove, PATCH as update } from '../../app/api/admin/repos/[id]/route';
import { POST as sync } from '../../app/api/admin/repos/[id]/sync/route';
import { createStorageHarness } from './http-harness';

const state = vi.hoisted(() => ({ getAuthContext: vi.fn(), auth: vi.fn(), getMongo: vi.fn(), verifyRepository: vi.fn(), readCandidate: vi.fn() }));
vi.mock('../../auth', () => ({ getAuthContext: state.getAuthContext, auth: state.auth }));
vi.mock('../../lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('../../lib/sync/github', () => ({ createGitHubClient: () => ({ verifyRepository: state.verifyRepository, readCandidate: state.readCandidate }) }));

const issuer = 'https://identity.synthetic.invalid';
const projectId = 'synthetic-project';
const subject = 'synthetic-subject';
const userId = new ObjectId().toHexString();
const sessionToken = 'synthetic-session-token';
const authSecret = 'synthetic-auth-secret-with-enough-bytes-for-hmac';
const approvedFiles = [{ path: 'index.md', mode: '100644', content: Buffer.from('# Approved synthetic documentation') }];
const reviewedCommit = 'a'.repeat(40);
const config = { authUrl: 'https://portal.synthetic.invalid', authSecret, zitadelIssuer: issuer,
  zitadelProjectId: projectId, zitadelClientId: 'synthetic-client', zitadelSecret: 'synthetic-secret',
  oauthTokenEncryptionKey: Buffer.alloc(32, 7), githubAppId: '123456', githubPrivateKey: 'synthetic-key', publicCatalogApprovalsFile: '', contentRoot: '' };
const identityId = createHash('sha256').update(`${issuer}\0${subject}\0${projectId}`).digest('hex');
let storage: Awaited<ReturnType<typeof createStorageHarness>>;

function request(path: string, options: { method?: string; headers?: Record<string, string>; body?: string; csrf?: boolean } = {}) {
  const headers = new Headers({ cookie: `__Secure-authjs.session-token=${sessionToken}`, ...options.headers });
  if (options.csrf) {
    headers.set('origin', config.authUrl);
    headers.set('x-csrf-token', adminCsrfToken(authSecret, sessionToken));
  }
  return new Request(`${config.authUrl}${path}`, { method: options.method ?? 'GET', headers,
    ...(options.body === undefined ? {} : { body: options.body }) });
}

async function seedCatalog() {
  const catalog = newCatalogRecord({ github: { repositoryId: 51, installationId: 61, owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs' },
    slug: 'admin-fixture', title: 'Admin fixture', visibility: 'private' });
  catalog.accessState = 'ready';
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
  return catalog;
}

beforeEach(async () => {
  vi.clearAllMocks();
  storage = await createStorageHarness();
  config.contentRoot = storage.contentRoot;
  config.publicCatalogApprovalsFile = join(storage.root, 'public-approvals.json');
  const approval = (approvalId: string, repositoryId: number, slug: string) => ({ approvalId, version: 1,
    approvedAt: '2026-10-12T00:00:00.000Z', ownerReference: 'synthetic-owner-ticket', repositoryId,
    branch: 'main', docsPath: 'docs', slug, reviewedCommit,
    candidateManifestDigest: candidateManifestDigest(approvedFiles), allowFutureUpdates: true });
  await writeFile(config.publicCatalogApprovalsFile, JSON.stringify({ formatVersion: 1, approvals: [
    approval('owner-review-new-public', 72, 'new-public'), approval('owner-review-admin-fixture', 51, 'admin-fixture'),
  ] }));
  await ensureCatalogStorage(storage.db);
  await ensureSyncJobStorage(storage.db);
  await storage.db.collection('accounts').insertOne({ provider: 'zitadel', issuer, userId: new ObjectId(userId), providerAccountId: subject });
  await storage.db.collection<{ _id: string; issuer: string; subject: string; projectId: string; roles: string[]; verifiedAt: Date; leaseFence: number; lease: null }>('identity_authorizations').insertOne({ _id: identityId, issuer, subject, projectId,
    roles: ['librarian-admin'], verifiedAt: new Date(), leaseFence: 0, lease: null });
  state.getMongo.mockResolvedValue(storage);
  state.getAuthContext.mockResolvedValue({ session: { user: { id: userId } }, config });
  state.auth.mockResolvedValue({ user: { id: userId } });
  state.verifyRepository.mockImplementation(async (input: { name: string; owner: string }) => ({
    repositoryId: input.name === 'public-docs' ? 72 : 51, owner: input.owner, name: input.name, isPrivate: true, commitSha: reviewedCommit,
  }));
  state.readCandidate.mockResolvedValue({ commitSha: reviewedCommit, treeSha: 'b'.repeat(40), files: approvedFiles });
});

afterEach(async () => { await storage.close(); });

it('issues a session-bound CSRF token and lists sanitized status without private content or storage paths', async () => {
  const catalog = await seedCatalog();
  const privateDocumentBody = 'SYNTHETIC_PRIVATE_DOCUMENT_BODY_8d1b6d';
  const generationDir = join(storage.contentRoot, catalog._id, 'generations', 'synthetic-generation');
  await mkdir(generationDir, { recursive: true });
  await writeFile(join(generationDir, 'private.md'), privateDocumentBody);
  const tokenResponse = await csrf(request('/api/admin/csrf'));
  expect(tokenResponse.status).toBe(200);
  expect(tokenResponse.headers.get('cache-control')).toBe('private, no-store');
  expect(await tokenResponse.json()).toEqual({ csrfToken: adminCsrfToken(authSecret, sessionToken) });

  const response = await list(request('/api/admin/repos'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const result = await response.json();
  expect(result).toMatchObject({ catalogs: [{ id: catalog._id, title: 'Admin fixture', status: 'pending', accessState: 'ready' }] });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(authSecret);
  expect(serialized).not.toContain(privateDocumentBody);
  expect(serialized).not.toContain(generationDir);
  expect(serialized).not.toContain(storage.contentRoot);
});

it('fails closed when the session, storage, linked account, or current administrator cannot be verified', async () => {
  state.getAuthContext.mockRejectedValueOnce(new Error('synthetic provider failure'));
  expect((await csrf(request('/api/admin/csrf'))).status).toBe(503);

  state.getAuthContext.mockResolvedValueOnce({ session: { user: { id: 'invalid' } }, config });
  expect((await csrf(request('/api/admin/csrf'))).status).toBe(401);

  state.getMongo.mockRejectedValueOnce(new Error('synthetic storage failure'));
  expect((await csrf(request('/api/admin/csrf'))).status).toBe(503);

  await storage.db.collection('accounts').deleteMany({});
  expect((await csrf(request('/api/admin/csrf'))).status).toBe(403);
  await storage.db.collection('accounts').insertOne({ provider: 'zitadel', issuer, userId: new ObjectId(userId), providerAccountId: subject });

  state.auth.mockRejectedValueOnce(new Error('synthetic session recheck failure'));
  expect((await csrf(request('/api/admin/csrf'))).status).toBe(401);
  state.auth.mockResolvedValueOnce({ user: { id: new ObjectId().toHexString() } });
  expect((await csrf(request('/api/admin/csrf'))).status).toBe(401);

  state.auth.mockImplementationOnce(async () => {
    await storage.db.collection('accounts').deleteMany({});
    return { user: { id: userId } };
  });
  expect((await csrf(request('/api/admin/csrf'))).status).toBe(401);
});

it('requires a secure session cookie, a matching mutation origin, and a constant-time CSRF token', async () => {
  expect((await csrf(new Request(`${config.authUrl}/api/admin/csrf`))).status).toBe(403);

  const body = { github: { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs', installationId: 61 },
    slug: 'no-csrf', title: 'No CSRF' };
  const wrongOrigin = await create(request('/api/admin/repos', { method: 'POST', headers: {
    origin: 'https://attacker.synthetic.invalid', 'content-type': 'application/json',
    'x-csrf-token': adminCsrfToken(authSecret, sessionToken),
  }, body: JSON.stringify(body) }));
  expect(wrongOrigin.status).toBe(403);
  expect(await wrongOrigin.json()).toMatchObject({ error: { code: 'admin_origin' } });

  const wrongToken = await create(request('/api/admin/repos', { method: 'POST', headers: {
    origin: config.authUrl, 'content-type': 'application/json', 'x-csrf-token': 'invalid-token',
  }, body: JSON.stringify(body) }));
  expect(wrongToken.status).toBe(403);
  expect(await wrongToken.json()).toMatchObject({ error: { code: 'admin_csrf' } });

  const missingToken = await create(request('/api/admin/repos', { method: 'POST', headers: {
    origin: config.authUrl, 'content-type': 'application/json',
  }, body: JSON.stringify(body) }));
  expect(missingToken.status).toBe(403);
  expect(state.verifyRepository).not.toHaveBeenCalled();
  expect(await storage.db.collection('catalogs').countDocuments()).toBe(0);
});

it('registers App-verified private sources and requires an exact owner approval for public registration', async () => {
  const body = { github: { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs', installationId: 61 },
    slug: 'new-docs', title: 'New docs' };
  const response = await create(request('/api/admin/repos', { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ catalog: { slug: 'new-docs', visibility: 'private', accessState: 'ready', status: 'pending' }, revision: 1 });
  expect(state.verifyRepository).toHaveBeenCalledWith(body.github);

  const publicBody = { ...body, github: { ...body.github, name: 'public-docs' }, slug: 'new-public', visibility: 'public', approvalRef: 'owner-review-new-public' };
  const publicResponse = await create(request('/api/admin/repos', { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(publicBody) }));
  expect(publicResponse.status).toBe(201);
  expect(await publicResponse.json()).toMatchObject({ catalog: { slug: 'new-public', visibility: 'public', approvalRef: 'owner-review-new-public', accessState: 'ready' } });

  const unapproved = await create(request('/api/admin/repos', { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...publicBody, slug: 'unapproved', approvalRef: 'missing-review' }) }));
  expect(unapproved.status).toBe(409);
  expect(await storage.db.collection('catalogs').countDocuments()).toBe(2);
});

it('rejects malformed or unsafe catalog creation and sanitizes GitHub verification failures', async () => {
  const body = { github: { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs', installationId: 61 },
    slug: 'new-docs', title: 'New docs' };
  const post = (value: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => create(request('/api/admin/repos', {
    method: 'POST', csrf: true, headers, body: typeof value === 'string' ? value : JSON.stringify(value),
  }));
  expect((await post(body, { 'content-type': 'text/plain' })).status).toBe(400);
  expect((await post('{')).status).toBe(400);
  expect((await post({ ...body, unexpected: 'field' })).status).toBe(400);
  expect((await post({ ...body, approvalRef: 'private-catalog-must-not-have-one' })).status).toBe(400);
  expect((await post({ ...body, visibility: 'public' })).status).toBe(409);

  state.verifyRepository.mockRejectedValueOnce(new Error('github_not_found'));
  expect((await post(body)).status).toBe(400);
  state.verifyRepository.mockRejectedValueOnce('provider detail must remain private');
  const unavailable = await post(body);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.text()).not.toContain('provider detail');

  await seedCatalog();
  expect((await post({ ...body, slug: 'admin-fixture' })).status).toBe(409);
  expect(await storage.db.collection('catalogs').countDocuments()).toBe(1);
});

it('accepts a request at the JSON byte limit and rejects the next byte before provider access', async () => {
  const input = { github: { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs', installationId: 61 },
    slug: 'bounded-body', title: 'Bounded body' };
  const json = JSON.stringify(input);
  const atLimit = json + ' '.repeat(LIMITS.maxAdminBytes - Buffer.byteLength(json));
  expect(Buffer.byteLength(atLimit)).toBe(LIMITS.maxAdminBytes);

  const accepted = await create(request('/api/admin/repos', { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json' }, body: atLimit }));
  expect(accepted.status, await accepted.clone().text()).toBe(201);

  const oversized = await create(request('/api/admin/repos', { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json' }, body: atLimit + ' ' }));
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ error: { code: 'admin_too_large' } });
  expect(state.verifyRepository).toHaveBeenCalledTimes(1);
  expect(await storage.db.collection('catalogs').countDocuments()).toBe(1);
});

it('rejects a catalog when the bounded lifetime creation reservation is exhausted', async () => {
  const quotas = storage.db.collection<{ _id: string; reservations: number }>('quotas');
  await quotas.updateOne({ _id: 'catalogs' }, { $set: { reservations: LIMITS.maxCatalogs } }, { upsert: true });
  const response = await create(request('/api/admin/repos', { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      github: { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs', installationId: 61 },
      slug: 'quota-exhausted', title: 'Quota exhausted',
    }) }));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'admin_unavailable' } });
  expect(await quotas.findOne({ _id: 'catalogs' })).toMatchObject({ reservations: LIMITS.maxCatalogs });
  expect(await storage.db.collection('catalogs').countDocuments()).toBe(0);
});

it('rejects values that pass the request shape but fail the persisted catalog schema', async () => {
  const response = await create(request('/api/admin/repos', { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      github: { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs', installationId: 61 },
      slug: 'bad/slug', title: 'Invalid slug',
    }) }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'admin_invalid_request' } });

  const unsafePath = await create(request('/api/admin/repos', { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      github: { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: '../outside', installationId: 61 },
      slug: 'unsafe-source-path', title: 'Unsafe source path',
    }) }));
  expect(unsafePath.status).toBe(400);
  expect(await unsafePath.json()).toMatchObject({ error: { code: 'admin_invalid_request' } });
  expect(await storage.db.collection('catalogs').countDocuments()).toBe(0);
});

it('keeps a newly inserted catalog unverified when its conditional verification write loses a race', async () => {
  type FindOneAndUpdate = Collection<Catalog>['findOneAndUpdate'];
  const original = Collection.prototype.findOneAndUpdate as unknown as FindOneAndUpdate;
  const spy = vi.spyOn(Collection.prototype, 'findOneAndUpdate').mockImplementation(async function (
    this: Collection<Catalog>, ...args: Parameters<FindOneAndUpdate>
  ) {
    if (this.collectionName === 'catalogs') return null;
    return original.apply(this, args);
  });
  try {
    const response = await create(request('/api/admin/repos', { method: 'POST', csrf: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        github: { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs', installationId: 61 },
        slug: 'verification-race', title: 'Verification race',
      }) }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'admin_unavailable' } });
    expect(await storage.db.collection<Catalog>('catalogs').findOne({ slug: 'verification-race' })).toMatchObject({
      accessState: 'unverified', enabled: true,
    });
  } finally { spy.mockRestore(); }
});

it('requires the reviewed GitHub commit and exact approval scope for public registration', async () => {
  const body = { github: { owner: 'synthetic', name: 'public-docs', branch: 'main', docsPath: 'docs', installationId: 61 },
    slug: 'new-public', title: 'New public docs', visibility: 'public', approvalRef: 'owner-review-new-public' };
  state.readCandidate.mockResolvedValueOnce({ commitSha: 'c'.repeat(40), treeSha: 'b'.repeat(40), files: approvedFiles });
  expect((await create(request('/api/admin/repos', { method: 'POST', csrf: true, headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) }))).status).toBe(409);
  state.readCandidate.mockRejectedValueOnce(new Error('github_invalid_content'));
  expect((await create(request('/api/admin/repos', { method: 'POST', csrf: true, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, slug: 'invalid-content' }) }))).status).toBe(400);
  expect(await storage.db.collection('catalogs').countDocuments()).toBe(0);
});

it('requires a matching owner approval before changing a private catalog to public', async () => {
  const catalog = await seedCatalog();
  const response = await update(request(`/api/admin/repos/${catalog._id}`, { method: 'PATCH', csrf: true,
    headers: { 'content-type': 'application/json', 'if-match': `"${catalog.updatedAt.toISOString()}"` },
    body: JSON.stringify({ visibility: 'public', approvalRef: 'owner-review-admin-fixture' }) }), { params: Promise.resolve({ id: catalog._id }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ catalog: { visibility: 'public', approvalRef: 'owner-review-admin-fixture', accessState: 'ready', publishedCommit: null }, revision: 2 });
});

it('explains a rejected public approval and leaves the previous catalog settings unchanged', async () => {
  const catalog = await seedCatalog();
  const response = await update(request(`/api/admin/repos/${catalog._id}`, { method: 'PATCH', csrf: true,
    headers: { 'content-type': 'application/json', 'if-match': `"${catalog.updatedAt.toISOString()}"` },
    body: JSON.stringify({ title: 'Unapproved title', slug: 'different-scope', visibility: 'public', approvalRef: 'owner-review-admin-fixture' }) }),
  { params: Promise.resolve({ id: catalog._id }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'public_approval_required',
    message: expect.stringContaining('not a GitHub App Installation ID problem') } });
  expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id })).toMatchObject({
    title: 'Admin fixture', slug: 'admin-fixture', visibility: 'private', approvalRef: null,
    configRevision: catalog.configRevision, updatedAt: catalog.updatedAt,
  });
});

it('applies metadata edits with If-Match and rejects stale revisions without partial mutation', async () => {
  const catalog = await seedCatalog();
  const patch = (version: string, title: string) => update(request(`/api/admin/repos/${catalog._id}`, { method: 'PATCH', csrf: true,
    headers: { 'content-type': 'application/json', 'if-match': version }, body: JSON.stringify({ title }) }),
  { params: Promise.resolve({ id: catalog._id }) });
  const saved = await patch(`"${catalog.updatedAt.toISOString()}"`, 'Changed title');
  expect(saved.status).toBe(200);
  const currentVersion = saved.headers.get('etag')!;
  expect(currentVersion).not.toBe(`"${catalog.updatedAt.toISOString()}"`);
  expect(await saved.json()).toMatchObject({ catalog: { title: 'Changed title', revision: 1 }, revision: 1 });
  expect((await patch(`"${catalog.updatedAt.toISOString()}"`, 'stale edit')).status).toBe(409);
  expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id }))?.title).toBe('Changed title');
});

it('rejects malformed, missing, and private-approval catalog updates before replacement', async () => {
  const catalog = await seedCatalog();
  const patch = (id: string, version: string | null, body: string, contentType = 'application/json') => update(request(`/api/admin/repos/${id}`, {
    method: 'PATCH', csrf: true, headers: { 'content-type': contentType, ...(version ? { 'if-match': version } : {}) }, body,
  }), { params: Promise.resolve({ id }) });
  const valid = `"${catalog.updatedAt.toISOString()}"`;
  expect((await patch(catalog._id, valid, '{}', 'text/plain')).status).toBe(400);
  expect((await patch('not-a-uuid', valid, '{"title":"x"}')).status).toBe(400);
  expect((await patch(catalog._id, null, '{"title":"x"}')).status).toBe(400);
  expect((await patch(catalog._id, 'invalid-etag', '{"title":"x"}')).status).toBe(400);
  expect((await patch(catalog._id, '"2026-02-30T00:00:00.000Z"', '{"title":"x"}')).status).toBe(400);
  expect((await patch(catalog._id, valid, '{}')).status).toBe(400);
  expect((await patch(catalog._id, valid, '{')).status).toBe(400);
  expect((await patch(catalog._id, valid, JSON.stringify({ approvalRef: 'not-for-private' }))).status).toBe(400);
  const unknownField = await patch(catalog._id, valid, JSON.stringify({ title: 'Must not partially apply', unexpected: 'synthetic' }));
  expect(unknownField.status).toBe(400);
  expect(await unknownField.json()).toMatchObject({ error: { code: 'admin_invalid_request' } });
  const missingId = randomUUID();
  expect((await patch(missingId, valid, JSON.stringify({ title: 'Absent' }))).status).toBe(404);
  expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id })).toMatchObject({
    title: 'Admin fixture', slug: 'admin-fixture', visibility: 'private', configRevision: catalog.configRevision, updatedAt: catalog.updatedAt,
  });
});

it('removes the configured repository and snapshot, preserves replay history, and cancels orphaned jobs', async () => {
  const catalog = await seedCatalog();
  const key = randomUUID();
  const syncResponse = await sync(request(`/api/admin/repos/${catalog._id}/sync`, { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: '{}' }), { params: Promise.resolve({ id: catalog._id }) });
  expect(syncResponse.status).toBe(202);
  const generationDir = join(storage.contentRoot, catalog._id, 'generations', randomUUID());
  await mkdir(generationDir, { recursive: true });
  await writeFile(join(generationDir, 'private.md'), 'synthetic private content');
  const current = await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id });
  const removeRequest = (version = current!.updatedAt.toISOString()) => remove(request(`/api/admin/repos/${catalog._id}`, { method: 'DELETE', csrf: true,
    headers: { 'if-match': `"${version}"` } }), { params: Promise.resolve({ id: catalog._id }) });

  const response = await removeRequest();
  expect(response.status, await response.clone().text()).toBe(204);
  expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id })).toBeNull();
  await expect(access(join(storage.contentRoot, catalog._id))).rejects.toThrow();
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments({ catalogId: catalog._id })).toBe(1);
  expect(await claimNextSyncJob(storage.db, randomUUID())).toBeNull();
  expect(await storage.db.collection<SyncJob>('syncJobs').findOne({ catalogId: catalog._id })).toMatchObject({ state: 'cancelled' });
  const repeatedDelete = await removeRequest();
  expect(repeatedDelete.status, await repeatedDelete.clone().text()).toBe(204);
});

it('allows an idempotent delete retry after snapshot cleanup fails', async () => {
  const catalog = await seedCatalog();
  const snapshotPath = join(storage.contentRoot, catalog._id);
  await writeFile(snapshotPath, 'synthetic cleanup blocker');
  const removeRequest = () => remove(request(`/api/admin/repos/${catalog._id}`, { method: 'DELETE', csrf: true,
    headers: { 'if-match': `"${catalog.updatedAt.toISOString()}"` } }), { params: Promise.resolve({ id: catalog._id }) });

  const first = await removeRequest();
  expect(first.status).toBe(503);
  expect(await first.json()).toMatchObject({ error: { code: 'admin_unavailable' } });
  expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id })).toBeNull();
  expect(await readFile(snapshotPath, 'utf8')).toBe('synthetic cleanup blocker');

  await unlink(snapshotPath);
  const retry = await removeRequest();
  expect(retry.status).toBe(204);
  await expect(access(snapshotPath)).rejects.toThrow();
});

it('requires a current version and refuses repository deletion while a lease or reader pin is active', async () => {
  const catalog = await seedCatalog();
  const removeRequest = (version = catalog.updatedAt.toISOString(), csrf = true) => remove(request(`/api/admin/repos/${catalog._id}`, { method: 'DELETE', csrf,
    headers: { 'if-match': `"${version}"` } }), { params: Promise.resolve({ id: catalog._id }) });
  expect((await removeRequest('2026-10-11T00:00:00.000Z')).status).toBe(409);
  expect((await removeRequest(catalog.updatedAt.toISOString(), false)).status).toBe(403);

  await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: { readPins: [{ requestId: randomUUID(),
    generationId: randomUUID(), expiresAt: new Date(Date.now() + 30_000) }] } });
  const pinnedDelete = await removeRequest();
  expect(pinnedDelete.status, await pinnedDelete.clone().text()).toBe(409);
  await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: { readPins: [], leaseFence: 1,
    lease: { owner: randomUUID(), fence: 1, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 30_000) } } });
  const leasedDelete = await removeRequest();
  expect(leasedDelete.status, await leasedDelete.clone().text()).toBe(409);
  expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id })).not.toBeNull();
});

it('reports a conflict when deletion loses its conditional write to a concurrent edit', async () => {
  const catalog = await seedCatalog();
  const original = Collection.prototype.deleteOne;
  const spy = vi.spyOn(Collection.prototype, 'deleteOne').mockImplementationOnce(async function (this: Collection<Catalog>, filter, options) {
    if (this.collectionName === 'catalogs') await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: {
      title: 'Concurrent edit', updatedAt: new Date(catalog.updatedAt.getTime() + 1000),
    } });
    return original.call(this, filter, options);
  });
  try {
    const response = await remove(request(`/api/admin/repos/${catalog._id}`, { method: 'DELETE', csrf: true,
      headers: { 'if-match': `"${catalog.updatedAt.toISOString()}"` } }), { params: Promise.resolve({ id: catalog._id }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'catalog_conflict' } });
    expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id })).toMatchObject({ title: 'Concurrent edit' });
  } finally { spy.mockRestore(); }
});

it('treats deletion by another administrator as an idempotent success', async () => {
  const catalog = await seedCatalog();
  const original = Collection.prototype.deleteOne;
  const spy = vi.spyOn(Collection.prototype, 'deleteOne').mockImplementationOnce(async function (this: Collection<Catalog>, _filter, options) {
    await original.call(this, { _id: catalog._id }, options);
    return { acknowledged: true, deletedCount: 0 };
  });
  try {
    const response = await remove(request(`/api/admin/repos/${catalog._id}`, { method: 'DELETE', csrf: true,
      headers: { 'if-match': `"${catalog.updatedAt.toISOString()}"` } }), { params: Promise.resolve({ id: catalog._id }) });
    expect(response.status).toBe(204);
    expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id })).toBeNull();
  } finally { spy.mockRestore(); }
});

it('refuses to delete a catalog whose stored record no longer validates', async () => {
  const catalog = await seedCatalog();
  await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: { title: '' } });
  const response = await remove(request(`/api/admin/repos/${catalog._id}`, { method: 'DELETE', csrf: true,
    headers: { 'if-match': `"${catalog.updatedAt.toISOString()}"` } }), { params: Promise.resolve({ id: catalog._id }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'admin_invalid_request' } });
    expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id })).not.toBeNull();
});

it('durably acknowledges manual sync once per idempotency key and rejects untrusted mutation context', async () => {
  const catalog = await seedCatalog();
  const key = randomUUID();
  const post = () => sync(request(`/api/admin/repos/${catalog._id}/sync`, { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: '{}' }), { params: Promise.resolve({ id: catalog._id }) });
  const first = await post();
  expect(first.status, await first.clone().text()).toBe(202);
  const accepted = await first.json();
  expect(accepted).toMatchObject({ status: 'pending', jobId: expect.stringContaining(catalog._id) });
  const duplicate = await post();
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toEqual(accepted);
  expect(await storage.db.collection<SyncJob>('syncJobs').countDocuments({ catalogId: catalog._id })).toBe(1);

  const wrongOrigin = await sync(request(`/api/admin/repos/${catalog._id}/sync`, { method: 'POST', headers: {
    origin: 'https://attacker.synthetic.invalid', 'x-csrf-token': adminCsrfToken(authSecret, sessionToken), 'idempotency-key': randomUUID(),
  }, body: '{}' }), { params: Promise.resolve({ id: catalog._id }) });
  expect(wrongOrigin.status).toBe(403);
  await storage.db.collection<{ _id: string; roles: string[] }>('identity_authorizations').updateOne({ _id: identityId }, { $set: { roles: ['docs:admin-fixture:reader'] } });
  expect((await list(request('/api/admin/repos'))).status).toBe(403);
});

it('returns the durable running, retry, success and failure outcomes for repeated sync requests', async () => {
  const catalog = await seedCatalog();
  const idempotencyKey = randomUUID();
  const post = () => sync(request(`/api/admin/repos/${catalog._id}/sync`, { method: 'POST', csrf: true,
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: '{}' }),
  { params: Promise.resolve({ id: catalog._id }) });
  const initial = await post();
  const jobId = (await initial.json() as { jobId: string }).jobId;
  const jobs = storage.db.collection<SyncJob>('syncJobs');
  const expires = new Date(Date.now() + 60_000);

  await jobs.updateOne({ _id: jobId }, { $set: { state: 'running', attempts: 1, owner: randomUUID(), fence: 1 } });
  expect(await (await post()).json()).toMatchObject({ status: 'running' });

  await jobs.updateOne({ _id: jobId }, { $set: { state: 'retry_wait', owner: null, result: null, availableAt: expires } });
  expect(await (await post()).json()).toMatchObject({ status: 'pending' });

  await jobs.updateOne({ _id: jobId }, { $set: { state: 'succeeded', owner: null, generationId: randomUUID(),
    result: { kind: 'published', commitSha: reviewedCommit }, completedAt: new Date(), detailExpiresAt: expires } });
  expect(await (await post()).json()).toMatchObject({ status: 'succeeded', commit: reviewedCommit });

  await jobs.updateOne({ _id: jobId }, { $set: { state: 'failed', owner: null, generationId: null,
    result: { kind: 'failure', code: 'provider_busy' }, completedAt: new Date(), detailExpiresAt: expires } });
  expect(await (await post()).json()).toMatchObject({ status: 'failed', error: 'provider_busy' });
});

it('validates manual sync identifiers and empty bodies and enforces admission limits', async () => {
  const catalog = await seedCatalog();
  const post = (id: string, idempotencyKey: string, body: string | null = '{}', contentType: string | null = 'application/json') => sync(request(`/api/admin/repos/${id}/sync`, {
    method: 'POST', csrf: true, headers: { ...(contentType === null ? {} : { 'content-type': contentType }), 'idempotency-key': idempotencyKey },
    ...(body === null ? {} : { body }),
  }), { params: Promise.resolve({ id }) });
  expect((await post(catalog._id, randomUUID(), '{}', 'text/plain')).status).toBe(400);
  expect((await post('invalid', randomUUID())).status).toBe(400);
  expect((await post(catalog._id, 'invalid')).status).toBe(400);
  expect((await post(catalog._id, randomUUID(), '[]')).status).toBe(400);
  expect((await post(catalog._id, randomUUID(), '{')).status).toBe(400);
  expect((await post(catalog._id, randomUUID(), null, null)).status).toBe(202);

  await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: { admissionReservations: 100_000 } });
  expect((await post(catalog._id, randomUUID())).status).toBe(503);
  const now = new Date();
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: {
    admissionReservations: 0, rateWindow: { window: minute, count: 60 },
  } });
  expect((await post(catalog._id, randomUUID())).status).toBe(429);
});

it('rechecks GitHub and public approval outcomes before applying a catalog update', async () => {
  const catalog = await seedCatalog();
  const patch = (body: unknown) => update(request(`/api/admin/repos/${catalog._id}`, { method: 'PATCH', csrf: true,
    headers: { 'content-type': 'application/json', 'if-match': `"${catalog.updatedAt.toISOString()}"` }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: catalog._id }) });

  expect((await patch({ visibility: 'public' })).status).toBe(409);

  const github = { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs', installationId: 61 };
  state.verifyRepository.mockRejectedValueOnce(new Error('github_invalid_content'));
  expect((await patch({ github })).status).toBe(400);
  state.verifyRepository.mockRejectedValueOnce('synthetic provider failure');
  expect((await patch({ github })).status).toBe(503);

  const approval = { visibility: 'public', approvalRef: 'owner-review-admin-fixture' };
  state.readCandidate.mockResolvedValueOnce({ commitSha: 'c'.repeat(40), treeSha: 'b'.repeat(40), files: approvedFiles });
  expect((await patch(approval)).status).toBe(409);
  state.readCandidate.mockRejectedValueOnce(new Error('github_invalid_content'));
  expect((await patch(approval)).status).toBe(400);
  state.readCandidate.mockRejectedValueOnce(new Error('synthetic provider failure'));
  expect((await patch(approval)).status).toBe(503);
  state.readCandidate.mockRejectedValueOnce('synthetic provider failure without an Error object');
  expect((await patch(approval)).status).toBe(503);

  expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id }))?.visibility).toBe('private');
});

it('revalidates a blocked catalog before reenabling it', async () => {
  const catalog = await seedCatalog();
  await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: { enabled: false, accessState: 'blocked' } });
  const response = await update(request(`/api/admin/repos/${catalog._id}`, { method: 'PATCH', csrf: true,
    headers: { 'content-type': 'application/json', 'if-match': `"${catalog.updatedAt.toISOString()}"` },
    body: JSON.stringify({ enabled: true }) }), { params: Promise.resolve({ id: catalog._id }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ catalog: { enabled: true, accessState: 'ready', publishedCommit: null }, revision: 2 });
  expect(state.verifyRepository).toHaveBeenCalledOnce();
});

it('rechecks the existing publication before re-enabling a blocked public catalog', async () => {
  const catalog = await seedCatalog();
  const publishedCommit = reviewedCommit;
  const manifest = JSON.parse(await readFile(config.publicCatalogApprovalsFile, 'utf8')) as {
    approvals: Array<{ approvalId: string; allowFutureUpdates: boolean }>;
  };
  manifest.approvals.find(item => item.approvalId === 'owner-review-admin-fixture')!.allowFutureUpdates = false;
  await writeFile(config.publicCatalogApprovalsFile, JSON.stringify(manifest));
  await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: {
    enabled: false, accessState: 'blocked', visibility: 'public', approvalRef: 'owner-review-admin-fixture', leaseFence: 1,
    publicationRevision: 1, published: { generationId: randomUUID(), commitSha: publishedCommit,
      jobId: `manual:${catalog._id}:${randomUUID()}`, fence: 1, configRevision: 1, manifestDigest: 'd'.repeat(64), publishedAt: new Date() },
  } });
  state.readCandidate.mockResolvedValueOnce({ commitSha: publishedCommit, treeSha: 'b'.repeat(40), files: approvedFiles });

  const response = await update(request(`/api/admin/repos/${catalog._id}`, { method: 'PATCH', csrf: true,
    headers: { 'content-type': 'application/json', 'if-match': `"${catalog.updatedAt.toISOString()}"` },
    body: JSON.stringify({ enabled: true }) }), { params: Promise.resolve({ id: catalog._id }) });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ catalog: { enabled: true, accessState: 'ready', publishedCommit: null }, revision: 2 });
  expect(state.verifyRepository).toHaveBeenCalledOnce();
  expect(state.readCandidate).toHaveBeenCalledOnce();
});

it('detects changes to every GitHub scope field and the portal slug before updating the catalog', async () => {
  const catalog = await seedCatalog();
  const sourceChanges: Array<[keyof Catalog['github'], string | number]> = [
    ['owner', 'changed-owner'], ['name', 'renamed-docs'], ['branch', 'release/docs'], ['docsPath', 'manual'], ['installationId', 62],
  ];
  for (const [field, value] of sourceChanges) {
    const current = await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id });
    const { owner, name, branch, docsPath, installationId } = current!.github;
    const github = { owner, name, branch, docsPath, installationId, [field]: value };
    const response = await update(request(`/api/admin/repos/${catalog._id}`, { method: 'PATCH', csrf: true,
      headers: { 'content-type': 'application/json', 'if-match': `"${current!.updatedAt.toISOString()}"` },
      body: JSON.stringify({ github }) }), { params: Promise.resolve({ id: catalog._id }) });
    expect(response.status, `${field}: ${await response.clone().text()}`).toBe(200);
    expect(state.verifyRepository).toHaveBeenCalledWith(expect.objectContaining({ [field]: value }));
  }

  const current = await storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id });
  const slugResponse = await update(request(`/api/admin/repos/${catalog._id}`, { method: 'PATCH', csrf: true,
    headers: { 'content-type': 'application/json', 'if-match': `"${current!.updatedAt.toISOString()}"` },
    body: JSON.stringify({ slug: 'renamed-docs' }) }), { params: Promise.resolve({ id: catalog._id }) });
  expect(slugResponse.status).toBe(200);
});

it('preserves approved public metadata edits and safely returns content to private without another upstream check', async () => {
  const catalog = await seedCatalog();
  await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id }, { $set: {
    visibility: 'public', approvalRef: 'owner-review-admin-fixture',
  } });
  const patch = (etag: string, body: unknown) => update(request(`/api/admin/repos/${catalog._id}`, { method: 'PATCH', csrf: true,
    headers: { 'content-type': 'application/json', 'if-match': etag }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: catalog._id }) });
  const metadata = await patch(`"${catalog.updatedAt.toISOString()}"`, { title: 'Approved public title' });
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({ catalog: { visibility: 'public', approvalRef: 'owner-review-admin-fixture', title: 'Approved public title' } });
  expect(state.verifyRepository).not.toHaveBeenCalled();

  const toPrivate = await patch(metadata.headers.get('etag')!, { visibility: 'private' });
  expect(toPrivate.status).toBe(200);
  expect(await toPrivate.json()).toMatchObject({ catalog: { visibility: 'private', approvalRef: null, accessState: 'ready' } });
  expect(state.verifyRepository).not.toHaveBeenCalled();
});

it('returns conflict when an update loses its conditional write or collides with a unique source', async () => {
  const raced = await seedCatalog();
  const github = { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs', installationId: 61 };
  state.verifyRepository.mockImplementationOnce(async () => {
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: raced._id }, { $set: {
      title: 'Concurrent edit', updatedAt: new Date(raced.updatedAt.getTime() + 1000),
    } });
    return { repositoryId: 51, owner: 'synthetic', name: 'docs', isPrivate: true, commitSha: reviewedCommit };
  });
  const requestPatch = (catalog: Catalog, body: unknown) => update(request(`/api/admin/repos/${catalog._id}`, { method: 'PATCH', csrf: true,
    headers: { 'content-type': 'application/json', 'if-match': `"${catalog.updatedAt.toISOString()}"` }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: catalog._id }) });
  expect((await requestPatch(raced, { github })).status).toBe(409);

  const target = newCatalogRecord({ github: { repositoryId: 52, installationId: 61, owner: 'synthetic', name: 'other', branch: 'main', docsPath: 'docs' },
    slug: 'source-conflict', title: 'Source conflict' });
  target.accessState = 'ready';
  await storage.db.collection<Catalog>('catalogs').insertOne(target);
  const conflict = await requestPatch(target, { github });
  expect(conflict.status).toBe(409);
  expect(await storage.db.collection<Catalog>('catalogs').findOne({ _id: target._id })).toMatchObject({ github: { repositoryId: 52 } });
});
