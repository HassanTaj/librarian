import { expect, it } from 'vitest';
import { catalogs } from '../fixtures/catalogs';
import { CatalogSchema, CatalogDefinitionSchema, newCatalogRecord, applyCatalogChanges, toDirectoryCard, CATALOG_INDEXES } from '../../lib/catalog';

const now = new Date('2026-01-01T00:00:00Z');
const definition = () => ({ github: { ...catalogs[1].github }, slug: 'synthetic', title: 'Synthetic project', publicDescription: 'Configured description' });
const pointer = () => ({ generationId: '00000000-0000-4000-8000-000000000004', commitSha: 'a'.repeat(40), jobId: `manual:${catalogs[1]._id}:00000000-0000-4000-8000-000000000005`, fence: 1, configRevision: 1, manifestDigest: 'b'.repeat(64), publishedAt: now });

it('validates all synthetic catalog records and defaults creation to private, unpublished and unverified', () => {
  for (const catalog of catalogs) expect(CatalogSchema.safeParse(catalog).success).toBe(true);
  const record = newCatalogRecord(definition(), now);
  expect(record._id).toMatch(/^[a-f0-9-]{36}$/);
  expect(record).toMatchObject({ visibility: 'private', readerRole: 'docs:synthetic:reader', enabled: true, accessState: 'unverified', published: null, retained: [], lease: null, leaseFence: 0, configRevision: 1, authEpoch: 1, publicationRevision: 0, readPins: [], admissionReservations: 0, lastSuccess: null, lastFailure: null });
  expect(record.createdAt).toEqual(now);
  expect(record.updatedAt).toEqual(now);
  expect(() => newCatalogRecord({ ...definition(), _id: catalogs[0]._id }, now)).toThrow();
});

it.each([
  { _id: 'not-a-uuid' }, { slug: 'Uppercase' }, { slug: 'a'.repeat(64) }, { slug: '1invalid' },
  ...['admin', 'api', '_next', 'auth', 'health', 'repositories', 'favicon.ico', 'robots.txt', 'sitemap.xml'].map(slug => ({ slug })),
  { title: '' }, { title: 'x'.repeat(121) }, { publicDescription: 'x'.repeat(501) },
  { readerRole: '' }, { readerRole: 'x'.repeat(201) }, { readerRole: 'docs:\u0000reader' },
  { enabled: 'true' }, { visibility: 'unknown' }, { accessState: 'unknown' },
  { configRevision: 0 }, { authEpoch: 0 }, { publicationRevision: -1 }, { leaseFence: -1 },
  { admissionReservations: 100_001 }, { admissionReservations: -1 },
  { rateWindow: { window: now, count: 61 } }, { rateWindow: { window: '2026-01-01', count: 0 } },
  { createdAt: new Date(NaN) }, { updatedAt: new Date('2025-01-01') },
  { approvalRef: 'not-applicable-to-private' }, { credential: 'synthetic-secret-must-not-be-stored' },
])('rejects invalid or secret-bearing catalog fields (%j)', patch => {
  expect(CatalogSchema.safeParse({ ...catalogs[1], ...patch }).success).toBe(false);
});

it.each([
  { repositoryId: 0 }, { installationId: -1 }, { repositoryId: 1.5 }, { repositoryId: Number.MAX_SAFE_INTEGER + 1 },
  { owner: '' }, { owner: 'https://synthetic.invalid' }, { name: '../escape' }, { branch: '' },
  { branch: '../escape' }, { branch: 'main.lock' }, { branch: 'main@{unsafe}' }, { branch: 'main ref' },
  { docsPath: '../outside' }, { docsPath: '/absolute' }, { docsPath: 'docs\\nested' }, { docsPath: 'docs//nested' },
  { docsPath: 'x'.repeat(1025) }, { docsPath: Array(33).fill('a').join('/') },
])('rejects unsafe GitHub configuration (%j)', patch => {
  expect(CatalogDefinitionSchema.safeParse({ ...definition(), github: { ...definition().github, ...patch } }).success).toBe(false);
});

it('counts Unicode characters, strips display controls and preserves exact role identity', () => {
  const record = newCatalogRecord({ ...definition(), title: '\u0000' + '😀'.repeat(120), publicDescription: 'Safe\nconfigured\tdescription', readerRole: 'custom:reader', github: { ...definition().github, docsPath: '.', branch: 'feature/synthetic' } }, now);
  expect(record.title).toBe('😀'.repeat(120));
  expect(record.publicDescription).toBe('Safeconfigureddescription');
  expect(record.readerRole).toBe('custom:reader');
});

it('validates publication, lease, pin and sanitized status records with exact bounded relationships', () => {
  const published = pointer();
  const record = { ...catalogs[1], published, leaseFence: 1, lease: { owner: catalogs[2]._id, fence: 1, heartbeatAt: now, expiresAt: new Date(now.getTime() + 30_000) }, readPins: [{ requestId: catalogs[0]._id, generationId: published.generationId, expiresAt: new Date(now.getTime() + 60_000) }], lastSuccess: { commitSha: published.commitSha, at: now, jobId: published.jobId }, lastFailure: { code: 'invalid_content', at: now, jobId: published.jobId } };
  expect(CatalogSchema.safeParse(record).success).toBe(true);
  for (const patch of [
    { published: { ...published, generationId: 'invalid' } }, { published: { ...published, commitSha: 'invalid' } },
    { published: { ...published, configRevision: 2 } }, { published: { ...published, manifestDigest: 'invalid' } },
    { published: { ...published, jobId: 'private-body-or-token' } }, { published: { ...published, fence: 2 } },
    { retained: Array(3).fill(published) }, { retained: [published] },
    { readPins: Array(65).fill(record.readPins[0]) },
    { lease: { ...record.lease, expiresAt: new Date(now.getTime() - 1) } },
    { lastFailure: { ...record.lastFailure, message: 'synthetic-provider-response' } },
    { lastFailure: { ...record.lastFailure, code: 'unbounded unsafe code' } },
  ]) expect(CatalogSchema.safeParse({ ...record, ...patch }).success).toBe(false);
});

it('projects safe directory metadata and keeps never-synced catalogs non-openable', () => {
  for (const catalog of catalogs) {
    expect(toDirectoryCard(catalog)).toEqual({ id: catalog._id, slug: catalog.slug, title: catalog.title,
      publicDescription: catalog.publicDescription, visibility: catalog.visibility, canOpen: false, url: `/${catalog.slug}` });
    expect(toDirectoryCard({ ...catalog, enabled: false })).toBeNull();
  }
  const successful = { ...catalogs[0], lastSuccess: { at: now, jobId: 'manual:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000099', commitSha: 'a'.repeat(40) } };
  expect(toDirectoryCard(successful)?.canOpen).toBe(true);
});

it('preserves publication for safe metadata edits and fences incompatible source/permission changes', () => {
  const current = CatalogSchema.parse({ ...catalogs[1], published: pointer(), leaseFence: 1 });
  const safe = applyCatalogChanges(current, { title: 'Updated configured title' }, 1, now);
  expect(safe.published).toEqual(current.published);
  expect(safe.configRevision).toBe(1);
  expect(safe.updatedAt.getTime()).toBeGreaterThan(current.updatedAt.getTime());
  const reorderedSource = Object.fromEntries(Object.entries(current.github).reverse());
  expect(applyCatalogChanges(current, { github: reorderedSource }, 1, now).configRevision).toBe(1);
  for (const changes of [{ slug: 'renamed' }, { readerRole: 'different:reader' }, { github: { ...current.github, branch: 'other' } }, { visibility: 'public', approvalRef: 'synthetic-owner-approval' }]) {
    const updated = applyCatalogChanges(current, changes, 1, now);
    expect(updated).toMatchObject({ published: null, retained: [], lease: null, configRevision: 2, authEpoch: 2, leaseFence: 2, accessState: 'unverified' });
  }
  const disabled = applyCatalogChanges(current, { enabled: false }, 1, now);
  expect(disabled.published).toEqual(current.published);
  expect(disabled.enabled).toBe(false);
  expect(disabled.lease).toBeNull();
  expect(disabled.authEpoch).toBe(2);
  expect(() => applyCatalogChanges(current, { title: 'stale' }, 2, now)).toThrow('catalog_conflict');
  expect(() => applyCatalogChanges(current, { credential: 'not-allowed' }, 1, now)).toThrow();
  expect(current.published).toEqual(pointer());
});

it('requires fresh access and a new compatible generation when recovering a blocked catalog', () => {
  const current = CatalogSchema.parse({ ...catalogs[1], enabled: false, accessState: 'blocked', published: pointer(), leaseFence: 1 });
  const recovered = applyCatalogChanges(current, { enabled: true }, 1, now);
  expect(recovered).toMatchObject({ enabled: true, accessState: 'unverified', published: null, retained: [],
    configRevision: 2, authEpoch: 2, leaseFence: 2, lastSuccess: null, lastFailure: null });
});

it('declares unique route and stable source indexes, plus the safe directory query index', () => {
  expect(CATALOG_INDEXES).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: { slug: 1 }, unique: true }),
    expect.objectContaining({ key: { 'github.repositoryId': 1, 'github.branch': 1, 'github.docsPath': 1 }, unique: true }),
    expect.objectContaining({ key: { enabled: 1, accessState: 1 } }),
  ]));
});

it('assigns server timestamps by default and rejects unapproved public activation', () => {
  const record = newCatalogRecord(definition());
  expect(record.createdAt).toBeInstanceOf(Date);
  expect(applyCatalogChanges(record, { title: 'Updated' }, 1).updatedAt.getTime()).toBeGreaterThan(record.updatedAt.getTime());
  expect(() => newCatalogRecord({ ...definition(), visibility: 'public' })).toThrow();
  expect(() => applyCatalogChanges(record, { visibility: 'public' }, 1)).toThrow();
});
