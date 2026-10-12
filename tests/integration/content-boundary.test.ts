import { expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { catalogs } from '../fixtures/catalogs';
import { CatalogSchema, type Catalog } from '../../lib/catalog';
import { authorizeCatalog, readAuthorizedGeneration } from '../../lib/auth/authorization';
import { createStorageHarness } from './http-harness';
import { generationRoot } from '../../lib/content/paths';

const authState = vi.hoisted(() => ({ getAuthContext: vi.fn(), auth: vi.fn(), getVerifiedRoles: vi.fn(), getOAuthAccessToken: vi.fn() }));
vi.mock('../../auth', () => ({ getAuthContext: authState.getAuthContext, auth: authState.auth }));
vi.mock('../../lib/auth/roles', () => ({ getVerifiedRoles: authState.getVerifiedRoles }));
vi.mock('../../lib/auth/tokens', () => ({ getOAuthAccessToken: authState.getOAuthAccessToken }));

it('checks current public/private/catalog state before reading any snapshot or cache', async () => {
  authState.getAuthContext.mockResolvedValue({ session: null, config: { zitadelIssuer: 'https://identity.synthetic.invalid' } });
  const storage = await createStorageHarness();
  try {
    await storage.db.collection<Catalog>('catalogs').insertMany(catalogs.map(item => CatalogSchema.parse(item)));
    expect((await authorizeCatalog(storage.db, 'public-project')).catalog._id).toBe(catalogs[0]._id);
    for (const slug of ['private-one', 'private-two']) {
      let read = false;
      await expect(readAuthorizedGeneration(storage.db, storage.contentRoot, slug, undefined, async () => { read = true; return 'private'; })).rejects.toThrow('unauthorized');
      expect(read).toBe(false);
    }
    await expect(authorizeCatalog(storage.db, 'missing')).rejects.toThrow('not_found');
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalogs[0]._id }, { $set: { enabled: true } });
    await expect(authorizeCatalog(storage.db, 'public-project')).resolves.toMatchObject({ catalog: { published: null }, privateContent: false, roleVerifiedAt: null });
    await expect(authorizeCatalog(storage.db, '../outside')).rejects.toThrow('invalid_path');
    for (const patch of [{ enabled: false }, { accessState: 'blocked' as const }, { accessState: 'unverified' as const }]) {
      await storage.db.collection<Catalog>('catalogs').updateOne({ _id: catalogs[0]._id }, { $set: patch });
      await expect(authorizeCatalog(storage.db, 'public-project')).rejects.toThrow();
    }
  } finally { await storage.close(); }
});

it('allows only a linked session with a current project reader role and fails closed at every recheck', async () => {
  const storage = await createStorageHarness();
  const record = CatalogSchema.parse(catalogs[1]);
  const issuer = 'https://identity.synthetic.invalid';
  const projectId = 'synthetic-project';
  const subject = 'synthetic-subject';
  const userId = new ObjectId().toHexString();
  const identityId = createHash('sha256').update(`${issuer}\0${subject}\0${projectId}`).digest('hex');
  authState.getAuthContext.mockResolvedValue({ session: { user: { id: userId } }, config: {
    zitadelIssuer: issuer, zitadelProjectId: projectId, zitadelClientId: 'synthetic-client',
    zitadelSecret: 'synthetic-secret', oauthTokenEncryptionKey: Buffer.alloc(32, 5),
  } });
  authState.auth.mockResolvedValue({ user: { id: userId } });
  authState.getVerifiedRoles.mockImplementationOnce(async (...args: unknown[]) => {
    await (args[2] as () => Promise<string>)();
    return [record.readerRole];
  });
  authState.getVerifiedRoles.mockResolvedValue([record.readerRole]);
  authState.getOAuthAccessToken.mockResolvedValue('synthetic-access-token');
  try {
    await storage.db.collection<Catalog>('catalogs').insertOne(record);
    await storage.db.collection('accounts').insertOne({ provider: 'zitadel', issuer, userId: new ObjectId(userId), providerAccountId: subject });
    await storage.db.collection<{ _id: string; issuer: string; subject: string; projectId: string; verifiedAt: Date }>('identity_authorizations')
      .insertOne({ _id: identityId, issuer, subject, projectId, verifiedAt: new Date() });
    await expect(authorizeCatalog(storage.db, record.slug)).resolves.toMatchObject({ privateContent: true, roleVerifiedAt: expect.any(Number) });
    expect(authState.getOAuthAccessToken).toHaveBeenCalledWith(storage.db, issuer, subject, 'synthetic-client', 'synthetic-secret', Buffer.alloc(32, 5));

    authState.getAuthContext.mockRejectedValueOnce(new Error('synthetic identity outage'));
    await expect(authorizeCatalog(storage.db, record.slug)).rejects.toThrow('unauthorized');
    authState.getAuthContext.mockResolvedValueOnce({ session: { user: { id: 'invalid-user-id' } }, config: { zitadelIssuer: issuer } });
    await expect(authorizeCatalog(storage.db, record.slug)).rejects.toThrow('unauthorized');

    await storage.db.collection('accounts').deleteMany({});
    await expect(authorizeCatalog(storage.db, record.slug)).rejects.toThrow('unauthorized');
    await storage.db.collection('accounts').insertOne({ provider: 'zitadel', issuer, userId: new ObjectId(userId), providerAccountId: subject });

    authState.getVerifiedRoles.mockResolvedValueOnce([]);
    await expect(authorizeCatalog(storage.db, record.slug)).rejects.toThrow('unauthorized');
    authState.getVerifiedRoles.mockRejectedValueOnce(new Error('storage_unavailable'));
    await expect(authorizeCatalog(storage.db, record.slug)).rejects.toThrow('storage_unavailable');
    authState.getVerifiedRoles.mockRejectedValueOnce(new Error('synthetic role provider failure'));
    await expect(authorizeCatalog(storage.db, record.slug)).rejects.toThrow('unauthorized');

    await storage.db.collection('identity_authorizations').deleteMany({});
    await expect(authorizeCatalog(storage.db, record.slug)).rejects.toThrow('unauthorized');
    await storage.db.collection<{ _id: string; issuer: string; subject: string; projectId: string; verifiedAt: Date }>('identity_authorizations')
      .insertOne({ _id: identityId, issuer, subject, projectId, verifiedAt: new Date() });

    authState.auth.mockResolvedValueOnce({ user: { id: new ObjectId().toHexString() } });
    await expect(authorizeCatalog(storage.db, record.slug)).rejects.toThrow('unauthorized');
    authState.auth.mockRejectedValueOnce(new Error('synthetic session recheck failure'));
    await expect(authorizeCatalog(storage.db, record.slug)).rejects.toThrow('unauthorized');

    authState.getVerifiedRoles.mockImplementationOnce(async () => {
      await storage.db.collection('accounts').deleteMany({});
      return [record.readerRole];
    });
    await expect(authorizeCatalog(storage.db, record.slug)).rejects.toThrow('unauthorized');
  } finally {
    authState.getAuthContext.mockReset();
    authState.auth.mockReset();
    authState.getVerifiedRoles.mockReset();
    authState.getOAuthAccessToken.mockReset();
    await storage.close();
  }
});

it('rechecks current access and config before returning public snapshot data', async () => {
  const storage = await createStorageHarness();
  const generationId = randomUUID();
  const record = CatalogSchema.parse(catalogs[0]);
  const manifest = { formatVersion: 1, complete: true, catalogId: record._id, configRevision: 1, generationId,
    commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), fence: 1, completedAt: new Date().toISOString(), normalizedBytes: 1024,
    documents: [{ path: 'index.md', route: '', title: 'Synthetic', description: '', headings: [], links: [], sha256: 'c'.repeat(64), size: 10 }], assets: [], metadata: [] };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const root = generationRoot(storage.contentRoot, record._id, generationId);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'manifest.json'), bytes);
    record.published = { generationId, configRevision: 1, commitSha: manifest.commitSha, fence: 1, jobId: `manual:${record._id}:${randomUUID()}`, manifestDigest: createHash('sha256').update(bytes).digest('hex'), publishedAt: new Date() };
    record.leaseFence = 1;
    await storage.db.collection<Catalog>('catalogs').insertOne(record);
    expect(await readAuthorizedGeneration(storage.db, storage.contentRoot, record.slug, undefined, async selected => selected.generationId)).toBe(generationId);
    for (const patch of [{ enabled: false }, { visibility: 'private' as const, approvalRef: null, authEpoch: 2 }, { configRevision: 2, authEpoch: 2, published: null }]) {
      await storage.db.collection<Catalog>('catalogs').replaceOne({ _id: record._id }, record);
      await expect(readAuthorizedGeneration(storage.db, storage.contentRoot, record.slug, undefined, async () => {
        await storage.db.collection<Catalog>('catalogs').updateOne({ _id: record._id }, { $set: patch });
        return 'SYNTHETIC_MUST_NOT_BE_DELIVERED';
      })).rejects.toThrow();
      expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: record._id }))?.readPins).toHaveLength(0);
    }
  } finally { await storage.close(); }
});

it('fails closed on corrupt records and unavailable persistence with sanitized errors', async () => {
  const storage = await createStorageHarness();
  try {
    await storage.db.collection<{ _id: string; credential: string }>('catalogs').insertOne({ ...catalogs[0], credential: 'SYNTHETIC_NOT_IN_ERROR' });
    await expect(authorizeCatalog(storage.db, 'public-project')).rejects.toThrow('storage_unavailable');
    await storage.client.close();
    await expect(authorizeCatalog(storage.db, 'public-project')).rejects.toThrow('storage_unavailable');
  } finally { await storage.client.connect(); await storage.close(); }
});
