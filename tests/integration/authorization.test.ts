import { expect, it, vi } from 'vitest';
import { Db, ObjectId } from 'mongodb';
import { catalogs } from '../fixtures/catalogs';
import { CatalogSchema, type Catalog } from '../../lib/catalog';
import { encryptOAuthToken } from '../../lib/auth/tokens';
import { authorizeCatalog } from '../../lib/auth/authorization';
import { LIMITS } from '../../lib/limits';
import { createStorageHarness } from './http-harness';

const authMocks = vi.hoisted(() => ({ auth: vi.fn(), getAuthContext: vi.fn() }));
vi.mock('../../auth', () => authMocks);

const issuer = 'https://identity.example';
const projectId = 'project-123';
const subject = 'subject-123';
const userId = '65a000000000000000000001';
const encryptionKey = Buffer.alloc(32, 8);
const config = {
  zitadelIssuer: issuer, zitadelProjectId: projectId, zitadelClientId: 'synthetic-client',
  zitadelSecret: 'synthetic-secret', oauthTokenEncryptionKey: encryptionKey,
};

async function seed(storage: Awaited<ReturnType<typeof createStorageHarness>>) {
  await storage.db.collection<Catalog>('catalogs').insertMany(catalogs.map(catalog => CatalogSchema.parse(catalog)));
  await storage.db.collection('accounts').insertOne({
    provider: 'zitadel', issuer, providerAccountId: subject, userId: new ObjectId(userId),
    encryptedTokens: { access_token: encryptOAuthToken('synthetic-access', encryptionKey) },
    expires_at: Math.floor(Date.now() / 1000) + 3600, tokenVersion: 1, refreshFence: 0,
  });
  authMocks.getAuthContext.mockResolvedValue({ session: { user: { id: userId } }, config });
  authMocks.auth.mockResolvedValue({ user: { id: userId } });
}

const roleResponse = (roles: string[]) => new Response(JSON.stringify({
  pagination: { totalResult: 1, appliedLimit: 100 },
  authorizations: [{ id: 'authorization-1', user: { id: subject }, project: { id: projectId }, state: 'STATE_ACTIVE', roles: roles.map(key => ({ key })) }],
}));

it('authorizes a fresh configured reader role and denies another project role', async () => {
  const storage = await createStorageHarness();
  const fetcher = vi.fn(async () => roleResponse(['docs:private-one:reader']));
  vi.stubGlobal('fetch', fetcher);
  try {
    await seed(storage);
    await expect(authorizeCatalog(storage.db, 'private-one')).resolves.toMatchObject({
      catalog: { slug: 'private-one' }, privateContent: true, roleVerifiedAt: expect.any(Number),
    });
    await expect(authorizeCatalog(storage.db, 'private-two')).rejects.toThrow('unauthorized');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const verified = await storage.db.collection('identity_authorizations').findOne({ issuer, subject, projectId });
    expect(verified?.roles).toEqual(['docs:private-one:reader']);
    expect(verified?.verifiedAt).toBeInstanceOf(Date);
  } finally { vi.unstubAllGlobals(); await storage.close(); }
});

it('does not treat an administrator role as repository reader access', async () => {
  const storage = await createStorageHarness();
  vi.stubGlobal('fetch', vi.fn(async () => roleResponse(['librarian-admin'])));
  try {
    await seed(storage);
    await expect(authorizeCatalog(storage.db, 'private-one')).rejects.toThrow('unauthorized');
  } finally { vi.unstubAllGlobals(); await storage.close(); }
});

it('denies a changed session identity, missing linked account, and provider failure', async () => {
  const storage = await createStorageHarness();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(roleResponse(['docs:private-one:reader']))
    .mockResolvedValueOnce(new Response('{}', { status: 503 }))
    .mockResolvedValueOnce(roleResponse(['docs:private-one:reader']));
  vi.stubGlobal('fetch', fetcher);
  try {
    await seed(storage);
    authMocks.auth.mockResolvedValueOnce({ user: { id: '65a000000000000000000002' } });
    await expect(authorizeCatalog(storage.db, 'private-one')).rejects.toThrow('unauthorized');

    authMocks.getAuthContext.mockResolvedValueOnce({ session: { user: { id: '65a000000000000000000003' } }, config });
    await expect(authorizeCatalog(storage.db, 'private-one')).rejects.toThrow('unauthorized');

    await storage.db.collection('identity_authorizations').updateOne({ issuer, subject, projectId },
      { $set: { verifiedAt: new Date(Date.now() - LIMITS.roleFreshMs) } });
    await expect(authorizeCatalog(storage.db, 'private-one')).rejects.toThrow('unauthorized');

    authMocks.auth.mockImplementationOnce(async () => {
      await storage.db.collection('accounts').updateOne({ provider: 'zitadel', issuer, providerAccountId: subject }, { $set: { providerAccountId: 'changed-subject' } });
      return { user: { id: userId } };
    });
    await expect(authorizeCatalog(storage.db, 'private-one')).rejects.toThrow('unauthorized');
  } finally { vi.unstubAllGlobals(); await storage.close(); }
});

it('fails closed for invalid sessions and account storage errors before reading private content', async () => {
  const storage = await createStorageHarness();
  vi.stubGlobal('fetch', vi.fn(async () => roleResponse(['docs:private-one:reader'])));
  try {
    await seed(storage);
    authMocks.getAuthContext.mockRejectedValueOnce(new Error('synthetic identity failure'));
    await expect(authorizeCatalog(storage.db, 'private-one')).rejects.toThrow('unauthorized');
    authMocks.getAuthContext.mockResolvedValueOnce({ session: { user: { id: 'invalid-user-id' } }, config });
    await expect(authorizeCatalog(storage.db, 'private-one')).rejects.toThrow('unauthorized');

    const unavailableAccounts = { collection: (name: string) => name === 'accounts'
      ? { findOne: vi.fn().mockRejectedValue(new Error('synthetic account storage failure')) }
      : storage.db.collection(name) } as unknown as Db;
    await expect(authorizeCatalog(unavailableAccounts, 'private-one')).rejects.toThrow('storage_unavailable');

    authMocks.auth.mockRejectedValueOnce(new Error('synthetic current-session failure'));
    await expect(authorizeCatalog(storage.db, 'private-one')).rejects.toThrow('unauthorized');
  } finally { vi.unstubAllGlobals(); await storage.close(); }
});
