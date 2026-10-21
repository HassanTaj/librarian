import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import { LIMITS } from '../limits';

const tokenFields = ['access_token', 'refresh_token', 'id_token'] as const;
type TokenField = typeof tokenFields[number];
type EncryptedTokens = Partial<Record<TokenField, string>>;
type Account = Document & { issuer: string; provider: string; providerAccountId: string; encryptedTokens: EncryptedTokens;
  expires_at?: number; tokenVersion: number; refreshFence: number; refreshLease?: { owner: string; fence: number; expiresAt: Date } | null };

async function readProviderResponse(response: Response) {
  const body = response.body;
  if (!body) throw new Error('oauth_refresh_failed');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declared) && declared > LIMITS.maxOAuthResponseBytes) {
    await body.cancel();
    throw new Error('oauth_refresh_failed');
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.maxOAuthResponseBytes) throw new Error('oauth_refresh_failed');
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error('oauth_refresh_failed');
  }
}

export function encryptOAuthToken(value: string, key: Buffer) {
  if (!value || key.length !== 32) throw new Error('oauth_token_invalid');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

export function decryptOAuthToken(value: string, key: Buffer) {
  if (key.length !== 32) throw new Error('oauth_token_invalid');
  const parts = value.split('.');
  if (parts.length !== 3 || parts.some(part => !part || Buffer.from(part, 'base64url').toString('base64url') !== part)) throw new Error('oauth_token_invalid');
  const [ivText, tagText, encryptedText] = parts;
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  const encrypted = Buffer.from(encryptedText, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) throw new Error('oauth_token_invalid');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch { throw new Error('oauth_token_invalid'); }
}

export function encryptAccountTokens(account: Record<string, unknown>, key: Buffer): EncryptedTokens {
  const encrypted: EncryptedTokens = {};
  for (const field of tokenFields) {
    const value = account[field];
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string') throw new Error('oauth_token_invalid');
      encrypted[field] = encryptOAuthToken(value, key);
    }
  }
  return encrypted;
}

export async function getOAuthAccessToken(db: Db, issuer: string, subject: string, clientId: string,
  clientSecret: string, key: Buffer, fetcher: typeof fetch = fetch) {
  if (fetcher === fetch) fetcher = await (await import('../instance/validation')).runtimeProviderFetch(issuer);
  const accounts = db.collection<Account>('accounts');
  const filter = { provider: 'zitadel', providerAccountId: subject, issuer };
  const startedAt = Date.now();
  while (Date.now() - startedAt <= LIMITS.roleContenderMs) {
    const account = await accounts.findOne(filter);
    if (!account?.encryptedTokens?.access_token || !Number.isSafeInteger(account.tokenVersion) || !Number.isSafeInteger(account.refreshFence)) throw new Error('oauth_token_unavailable');
    try {
      if (Number.isSafeInteger(account.expires_at) && account.expires_at! * 1000 > Date.now() + 5000) {
        return decryptOAuthToken(account.encryptedTokens.access_token, key);
      }
    } catch { throw new Error('oauth_token_unavailable'); }
    const refresh = account.encryptedTokens.refresh_token;
    if (!refresh) throw new Error('oauth_token_unavailable');
    const owner = randomUUID();
    const fence = account.refreshFence + 1;
    const now = new Date();
    const lease = await accounts.findOneAndUpdate({ ...filter, _id: account._id, tokenVersion: account.tokenVersion, refreshFence: account.refreshFence,
      $or: [{ refreshLease: null }, { refreshLease: { $exists: false } }, { 'refreshLease.expiresAt': { $lte: now } }],
    }, { $set: { refreshFence: fence, refreshLease: { owner, fence, expiresAt: new Date(now.getTime() + LIMITS.roleLeaseMs) } } }, { returnDocument: 'after' });
    if (!lease) {
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }
    try {
      const refreshToken = decryptOAuthToken(refresh, key);
      const endpoint = new URL('/oauth/v2/token', issuer);
      const encodeFormValue = (value: string) => new URLSearchParams({ value }).toString().slice(6);
      const credentials = Buffer.from(`${encodeFormValue(clientId)}:${encodeFormValue(clientSecret)}`).toString('base64');
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
        signal: AbortSignal.timeout(LIMITS.roleQueryTimeoutMs),
      });
      const raw = await readProviderResponse(response);
      if (!response.ok) throw new Error('oauth_refresh_failed');
      const payload: unknown = JSON.parse(raw);
      if (!payload || typeof payload !== 'object') throw new Error('oauth_refresh_failed');
      const token = payload as Record<string, unknown>;
      if (typeof token.access_token !== 'string' || !token.access_token || token.token_type?.toString().toLowerCase() !== 'bearer' ||
          !Number.isSafeInteger(token.expires_in) || Number(token.expires_in) <= 0 ||
          (token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token)) ||
          (token.id_token !== undefined && (typeof token.id_token !== 'string' || !token.id_token))) throw new Error('oauth_refresh_failed');
      const encryptedTokens = { ...account.encryptedTokens,
        access_token: encryptOAuthToken(token.access_token, key),
        ...(token.refresh_token ? { refresh_token: encryptOAuthToken(token.refresh_token as string, key) } : {}),
        ...(token.id_token ? { id_token: encryptOAuthToken(token.id_token as string, key) } : {}),
      };
      const updated = await accounts.findOneAndUpdate({ ...filter, _id: account._id, tokenVersion: account.tokenVersion,
        'refreshLease.owner': owner, 'refreshLease.fence': fence,
      }, { $set: { encryptedTokens, expires_at: Math.floor(Date.now() / 1000) + Number(token.expires_in), tokenVersion: account.tokenVersion + 1 },
        $unset: { refreshLease: '' } }, { returnDocument: 'after' });
      if (!updated) throw new Error('oauth_refresh_stale');
      return token.access_token;
    } catch (error) {
      await accounts.updateOne({ ...filter, _id: account._id, tokenVersion: account.tokenVersion,
        'refreshLease.owner': owner, 'refreshLease.fence': fence }, { $unset: { refreshLease: '' } });
      if (error instanceof Error && ['oauth_refresh_failed', 'oauth_refresh_stale', 'oauth_token_invalid'].includes(error.message)) throw error;
      throw new Error('oauth_refresh_failed');
    }
  }
  throw new Error('oauth_token_busy');
}
