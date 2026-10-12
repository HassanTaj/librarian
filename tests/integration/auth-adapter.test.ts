import { expect, it } from 'vitest';
import type { AdapterAccount } from 'next-auth/adapters';
import { ObjectId } from 'mongodb';
import { LIMITS } from '../../lib/limits';
import { createLibrarianAdapter, persistOAuthSignInTokens } from '../../lib/auth/adapter';
import { createStorageHarness } from './http-harness';

const issuer = 'https://identity.example';
const key = Buffer.alloc(32, 7);

it('replaces encrypted Zitadel tokens when an already linked account signs in again', async () => {
  const storage = await createStorageHarness();
  try {
    const adapter = await createLibrarianAdapter(storage.client, storage.db, issuer, key);
    const user = await adapter.createUser!({ id: new ObjectId().toHexString(), name: 'Synthetic reader', email: 'tokens@example.invalid', emailVerified: null, image: null });
    const first: AdapterAccount = {
      userId: user.id, type: 'oidc', provider: 'zitadel', providerAccountId: 'subject-tokens',
      access_token: 'old-access-token', refresh_token: 'old-refresh-token', id_token: 'old-id-token',
      expires_at: Math.floor(Date.now() / 1000) + 300, token_type: 'bearer', scope: 'openid profile offline_access',
    };
    await adapter.linkAccount!(first);
    await storage.db.collection('accounts').updateOne({ provider: 'zitadel', issuer, providerAccountId: 'subject-tokens' }, {
      $set: { tokenVersion: 1, refreshFence: 1, refreshLease: { owner: 'in-flight-refresh', fence: 1, expiresAt: new Date(Date.now() + 10_000) } },
    });

    await expect(persistOAuthSignInTokens(storage.db, issuer, {
      ...first, access_token: 'new-access-token', refresh_token: 'new-refresh-token', id_token: 'new-id-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }, key)).resolves.toBe(true);

    const stored = await storage.db.collection('accounts').findOne({ provider: 'zitadel', issuer, providerAccountId: 'subject-tokens' });
    expect(stored).toMatchObject({ tokenVersion: 2, refreshFence: 2, expires_at: expect.any(Number) });
    expect(stored?.refreshLease).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('new-access-token');
    expect(await adapter.getAccount!('subject-tokens', 'zitadel')).toMatchObject({
      access_token: 'new-access-token', refresh_token: 'new-refresh-token', id_token: 'new-id-token',
    });
  } finally { await storage.close(); }
});

it('leaves first-link token persistence to linkAccount', async () => {
  const storage = await createStorageHarness();
  try {
    const fresh: AdapterAccount = {
      userId: 'first-user', type: 'oidc', provider: 'zitadel', providerAccountId: 'subject-first',
      access_token: 'fresh-access-token', refresh_token: 'fresh-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', scope: 'openid offline_access',
    };
    await expect(persistOAuthSignInTokens(storage.db, issuer, fresh, key)).resolves.toBe(false);
  } finally { await storage.close(); }
});

it('encrypts linked tokens and enforces the absolute database-session lifetime', async () => {
  const storage = await createStorageHarness();
  let now = 1_000_000;
  try {
    const adapter = await createLibrarianAdapter(storage.client, storage.db, issuer, key, () => now);
    const user = await adapter.createUser!({ id: new ObjectId().toHexString(), name: 'Synthetic reader', email: 'reader@example.invalid', emailVerified: null, image: null });
    const account: AdapterAccount = {
      userId: user.id, type: 'oidc', provider: 'zitadel', providerAccountId: 'subject-123',
      access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', id_token: 'synthetic-id-token',
      expires_at: Math.floor(now / 1000) + 3600, token_type: 'bearer', scope: 'openid profile',
    };

    await adapter.linkAccount!(account);
    const storedAccount = await storage.db.collection('accounts').findOne({ provider: 'zitadel', issuer });
    expect(storedAccount).toMatchObject({ encryptedTokens: { access_token: expect.any(String), refresh_token: expect.any(String), id_token: expect.any(String) } });
    expect(JSON.stringify(storedAccount)).not.toContain('synthetic-access-token');
    expect(await adapter.getAccount!('subject-123', 'zitadel')).toMatchObject({
      access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', id_token: 'synthetic-id-token',
    });
    await expect(adapter.getUserByAccount!({ provider: 'zitadel', providerAccountId: 'subject-123' })).resolves.toMatchObject({ id: user.id });
    await expect(adapter.getUserByAccount!({ provider: 'zitadel', providerAccountId: 'missing' })).resolves.toBeNull();
    await expect(adapter.getAccount!('missing', 'zitadel')).resolves.toBeNull();

    await expect(adapter.linkAccount!({ ...account, userId: 'another-user' })).rejects.toThrow();
    const session = await adapter.createSession!({ sessionToken: 'opaque-session', userId: user.id, expires: new Date(now + LIMITS.sessionAbsoluteMs * 2) });
    const deadline = new Date(now + LIMITS.sessionAbsoluteMs);
    expect(session.expires).toEqual(deadline);
    const storedSession = await storage.db.collection('sessions').findOne({ sessionToken: 'opaque-session' });
    expect(storedSession).toMatchObject({ createdAt: new Date(now), absoluteExpiresAt: deadline, expires: deadline });

    const extended = await adapter.updateSession!({ sessionToken: 'opaque-session', expires: new Date(now + LIMITS.sessionAbsoluteMs * 2) });
    expect(extended?.expires).toEqual(deadline);
    await expect(adapter.getSessionAndUser!('opaque-session')).resolves.toMatchObject({ session: { expires: deadline }, user: { id: user.id } });

    now = deadline.getTime();
    await expect(adapter.updateSession!({ sessionToken: 'opaque-session', expires: new Date(now + LIMITS.sessionAbsoluteMs) })).resolves.toBeNull();
    await expect(adapter.getSessionAndUser!('opaque-session')).resolves.toBeNull();
    await expect(storage.db.collection('sessions').countDocuments({ sessionToken: 'opaque-session' })).resolves.toBe(0);
    await adapter.deleteSession!('opaque-session');
  } finally { await storage.close(); }
});

it('rejects malformed persisted session timestamps instead of extending them', async () => {
  const storage = await createStorageHarness();
  try {
    const adapter = await createLibrarianAdapter(storage.client, storage.db, issuer, key);
    const user = await adapter.createUser!({ id: new ObjectId().toHexString(), name: 'Synthetic reader', email: 'session@example.invalid', emailVerified: null, image: null });
    await adapter.createSession!({ sessionToken: 'invalid-session', userId: user.id, expires: new Date(Date.now() + LIMITS.sessionAbsoluteMs) });
    await storage.db.collection('sessions').updateOne({ sessionToken: 'invalid-session' }, { $set: { absoluteExpiresAt: new Date(Date.now() + 1) } });
    await expect(adapter.getSessionAndUser!('invalid-session')).resolves.toBeNull();
    await expect(storage.db.collection('sessions').countDocuments({ sessionToken: 'invalid-session' })).resolves.toBe(0);
  } finally { await storage.close(); }
});
