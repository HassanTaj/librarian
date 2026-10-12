import { MongoDBAdapter, format } from '@auth/mongodb-adapter';
import type { Adapter, AdapterAccount } from 'next-auth/adapters';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { LIMITS } from '../limits';
import { encryptAccountTokens, decryptOAuthToken } from './tokens';

type OAuthSignInTokens = Pick<AdapterAccount, 'provider' | 'providerAccountId' | 'access_token' | 'refresh_token' | 'id_token' | 'expires_at'>;

export async function ensureAuthIndexes(db: Db) {
  await Promise.all([
    db.collection('accounts').createIndex({ provider: 1, issuer: 1, providerAccountId: 1 }, { unique: true, name: 'auth_account_identity' }),
    db.collection('sessions').createIndex({ sessionToken: 1 }, { unique: true, name: 'auth_session_token' }),
    db.collection('sessions').createIndex({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0, name: 'auth_session_cleanup' }),
    db.collection('verification_tokens').createIndex({ identifier: 1, token: 1 }, { unique: true, name: 'auth_verification_token' }),
    db.collection('identity_authorizations').createIndex({ issuer: 1, subject: 1, projectId: 1 }, { unique: true, name: 'auth_verified_roles' }),
  ]);
}

export async function persistOAuthSignInTokens(db: Db, issuer: string, account: OAuthSignInTokens, encryptionKey: Buffer,
  now: () => number = Date.now) {
  if (account.provider !== 'zitadel' || typeof account.providerAccountId !== 'string' || !account.providerAccountId ||
      typeof account.access_token !== 'string' || !Number.isSafeInteger(account.expires_at) ||
      account.expires_at! <= Math.floor(now() / 1000)) throw new Error('oauth_token_unavailable');
  const encrypted = encryptAccountTokens({ access_token: account.access_token, refresh_token: account.refresh_token, id_token: account.id_token }, encryptionKey);
  if (!encrypted.access_token) throw new Error('oauth_token_unavailable');
  const set: Record<string, unknown> = { 'encryptedTokens.access_token': encrypted.access_token, expires_at: account.expires_at };
  if (encrypted.refresh_token) set['encryptedTokens.refresh_token'] = encrypted.refresh_token;
  if (encrypted.id_token) set['encryptedTokens.id_token'] = encrypted.id_token;
  const result = await db.collection('accounts').updateOne({ provider: 'zitadel', providerAccountId: account.providerAccountId, issuer }, {
    $set: set, $inc: { tokenVersion: 1, refreshFence: 1 }, $unset: { refreshLease: '' },
  });
  return result.matchedCount > 0;
}

export async function createLibrarianAdapter(client: MongoClient, db: Db, issuer: string, encryptionKey: Buffer,
  now: () => number = Date.now): Promise<Adapter> {
  await ensureAuthIndexes(db);
  const base = MongoDBAdapter(client, { databaseName: db.databaseName });
  const accounts = db.collection('accounts');
  const sessions = db.collection('sessions');
  return {
    ...base,
    async linkAccount(account) {
      const persisted = { ...account, issuer, encryptedTokens: encryptAccountTokens(account, encryptionKey), tokenVersion: 1,
        refreshFence: 0, refreshLease: null };
      delete persisted.access_token;
      delete persisted.refresh_token;
      delete persisted.id_token;
      await base.linkAccount?.(persisted as AdapterAccount);
      return account;
    },
    async getAccount(providerAccountId, provider) {
      const raw = await accounts.findOne({ provider, providerAccountId, issuer });
      if (!raw) return null;
      const { encryptedTokens, ...safe } = raw;
      delete safe.issuer; delete safe.refreshLease; delete safe.refreshFence; delete safe.tokenVersion;
      const account = format.from(safe) as AdapterAccount;
      const tokens: Record<string, string> = {};
      for (const field of ['access_token', 'refresh_token', 'id_token'] as const) {
        if (encryptedTokens?.[field]) tokens[field] = decryptOAuthToken(encryptedTokens[field], encryptionKey);
      }
      return { ...account, ...tokens } as AdapterAccount;
    },
    async getUserByAccount({ provider, providerAccountId }) {
      const raw = await accounts.findOne({ provider, providerAccountId, issuer }, { projection: { userId: 1 } });
      if (!raw?.userId) return null;
      const userId = raw.userId instanceof ObjectId ? raw.userId.toHexString() : String(raw.userId);
      return (await base.getUser?.(userId)) ?? null;
    },
    async createSession(session) {
      const createdAt = new Date(now());
      const absoluteExpiresAt = new Date(createdAt.getTime() + LIMITS.sessionAbsoluteMs);
      if (!base.createSession) throw new Error('session_storage_unavailable');
      const result = await base.createSession({ ...session, expires: absoluteExpiresAt });
      await sessions.updateOne({ sessionToken: session.sessionToken }, { $set: { createdAt, absoluteExpiresAt, expires: absoluteExpiresAt } });
      return { ...result, expires: absoluteExpiresAt };
    },
    async getSessionAndUser(sessionToken) {
      const result = await base.getSessionAndUser?.(sessionToken);
      if (!result) return null;
      const stored = await sessions.findOne({ sessionToken }, { projection: { createdAt: 1, absoluteExpiresAt: 1, expires: 1 } });
      const nowDate = new Date(now());
      if (!(stored?.createdAt instanceof Date) || !(stored.absoluteExpiresAt instanceof Date) ||
          !(stored.expires instanceof Date) || stored.absoluteExpiresAt.getTime() - stored.createdAt.getTime() !== LIMITS.sessionAbsoluteMs ||
          stored.absoluteExpiresAt <= nowDate || stored.expires <= nowDate) {
        await base.deleteSession?.(sessionToken);
        return null;
      }
      return { ...result, session: { ...result.session, expires: stored.absoluteExpiresAt } };
    },
    async updateSession(session) {
      const stored = await sessions.findOne({ sessionToken: session.sessionToken }, { projection: { createdAt: 1, absoluteExpiresAt: 1, expires: 1 } });
      const nowDate = new Date(now());
      if (!(stored?.createdAt instanceof Date) || !(stored.absoluteExpiresAt instanceof Date) || !(stored.expires instanceof Date) ||
          stored.absoluteExpiresAt <= nowDate || stored.expires <= nowDate) return null;
      const expires = new Date(Math.min(session.expires?.getTime() ?? stored.expires.getTime(), stored.absoluteExpiresAt.getTime()));
      const result = await base.updateSession?.({ ...session, expires });
      if (!result) return result;
      await sessions.updateOne({ sessionToken: session.sessionToken, absoluteExpiresAt: stored.absoluteExpiresAt }, { $set: { expires } });
      return { ...result, expires };
    },
    async deleteSession(sessionToken) { await base.deleteSession?.(sessionToken); },
  };
}
