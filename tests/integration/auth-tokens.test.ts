import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { decryptOAuthToken, encryptOAuthToken, getOAuthAccessToken } from '../../lib/auth/tokens';
import { createStorageHarness } from './http-harness';

const key = Buffer.alloc(32, 4);
const issuer = 'https://identity.example';

async function seed(storage: Awaited<ReturnType<typeof createStorageHarness>>, includeRefresh = true) {
  const _id = new ObjectId();
  await storage.db.collection('accounts').insertOne({ _id, provider: 'zitadel', issuer, providerAccountId: `subject-${randomUUID()}`,
    encryptedTokens: { access_token: encryptOAuthToken('expired-access', key), ...(includeRefresh ? { refresh_token: encryptOAuthToken('old-refresh', key) } : {}) },
    expires_at: 1, tokenVersion: 1, refreshFence: 0, refreshLease: null });
  return { _id, subject: (await storage.db.collection('accounts').findOne({ _id }))!.providerAccountId as string };
}

const refreshResponse = () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'rotated-refresh', id_token: 'new-id', expires_in: 3600, token_type: 'Bearer' }));

it('encrypts rotated tokens at rest and coalesces concurrent refresh requests', async () => {
  const storage = await createStorageHarness();
  try {
    const account = await seed(storage);
    let begin!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { begin = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${issuer}/oauth/v2/token`);
      expect(Buffer.from(new Headers(init?.headers).get('authorization')!.slice(6), 'base64').toString()).toBe('client%40app:secret%2Bvalue');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh' });
      begin(); await gate;
      return refreshResponse();
    });
    const first = getOAuthAccessToken(storage.db, issuer, account.subject, 'client@app', 'secret+value', key, fetcher);
    await entered;
    const second = getOAuthAccessToken(storage.db, issuer, account.subject, 'client@app', 'secret+value', key, fetcher);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['new-access', 'new-access']);
    const stored = await storage.db.collection('accounts').findOne({ _id: account._id });
    expect(stored?.tokenVersion).toBe(2);
    expect(stored?.refreshLease).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('new-access');
    expect(JSON.stringify(stored)).not.toContain('rotated-refresh');
  } finally { await storage.close(); }
});

it('fails closed when refresh credentials are absent or the provider fails, then permits retry', async () => {
  const storage = await createStorageHarness();
  try {
    const noRefresh = await seed(storage, false);
    await expect(getOAuthAccessToken(storage.db, issuer, noRefresh.subject, 'client', 'secret', key, async () => refreshResponse()))
      .rejects.toThrow('oauth_token_unavailable');

    const account = await seed(storage);
    await expect(getOAuthAccessToken(storage.db, issuer, account.subject, 'client', 'secret', key, async () => new Response('{}', { status: 503 })))
      .rejects.toThrow('oauth_refresh_failed');
    await expect(getOAuthAccessToken(storage.db, issuer, account.subject, 'client', 'secret', key, async () => refreshResponse()))
      .resolves.toBe('new-access');
  } finally { await storage.close(); }
});

it('returns only a current authenticated access token and fails closed for missing or corrupt accounts', async () => {
  const storage = await createStorageHarness();
  try {
    const fresh = await seed(storage);
    await storage.db.collection('accounts').updateOne({ _id: fresh._id }, { $set: {
      'encryptedTokens.access_token': encryptOAuthToken('fresh-access', key), expires_at: Math.floor(Date.now() / 1000) + 3600,
    } });
    const fetcher = vi.fn(async () => { throw new Error('must not refresh a current token'); });
    await expect(getOAuthAccessToken(storage.db, issuer, fresh.subject, 'client', 'secret', key, fetcher)).resolves.toBe('fresh-access');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(getOAuthAccessToken(storage.db, issuer, 'missing-subject', 'client', 'secret', key, fetcher))
      .rejects.toThrow('oauth_token_unavailable');

    await storage.db.collection('accounts').updateOne({ _id: fresh._id }, { $set: { 'encryptedTokens.access_token': 'invalid-ciphertext' } });
    await expect(getOAuthAccessToken(storage.db, issuer, fresh.subject, 'client', 'secret', key, fetcher))
      .rejects.toThrow('oauth_token_unavailable');
  } finally { await storage.close(); }
});

it('keeps existing optional tokens when the provider rotates only the access token and detects a stale write', async () => {
  const storage = await createStorageHarness();
  try {
    const account = await seed(storage);
    const accessOnly = async () => new Response(JSON.stringify({ access_token: 'access-only', expires_in: 3600, token_type: 'bearer' }));
    await expect(getOAuthAccessToken(storage.db, issuer, account.subject, 'client', 'secret', key, accessOnly)).resolves.toBe('access-only');
    const stored = await storage.db.collection('accounts').findOne({ _id: account._id });
    expect(decryptOAuthToken(stored?.encryptedTokens?.refresh_token as string, key)).toBe('old-refresh');
    expect(stored?.encryptedTokens?.id_token).toBeUndefined();

    const stale = await seed(storage);
    await expect(getOAuthAccessToken(storage.db, issuer, stale.subject, 'client', 'secret', key, async () => {
      await storage.db.collection('accounts').updateOne({ _id: stale._id }, { $inc: { tokenVersion: 1 } });
      return refreshResponse();
    })).rejects.toThrow('oauth_refresh_stale');
  } finally { await storage.close(); }
});

it('cancels an oversized token response without waiting for the provider stream to finish', async () => {
  const storage = await createStorageHarness();
  try {
    const account = await seed(storage);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; value.enqueue(new Uint8Array(64 * 1024 + 1)); },
      cancel() { cancelled = true; },
    });
    const attempt = getOAuthAccessToken(storage.db, issuer, account.subject, 'client', 'secret', key,
      async () => new Response(body)).then(() => 'resolved', error => error instanceof Error ? error.message : 'unknown');
    try {
      const result = await Promise.race([attempt, new Promise<string>(resolve => setTimeout(() => resolve('body_not_bounded'), 100))]);
      expect(result).toBe('oauth_refresh_failed');
      expect(cancelled).toBe(true);
    } finally {
      try { controller?.error(new Error('test_cleanup')); } catch { /* The bounded reader already cancelled the stream. */ }
      await attempt;
    }
  } finally { await storage.close(); }
});

it('rejects absent and declared-oversized OAuth response bodies', async () => {
  const storage = await createStorageHarness();
  try {
    const empty = await seed(storage);
    await expect(getOAuthAccessToken(storage.db, issuer, empty.subject, 'client', 'secret', key, async () => new Response(null)))
      .rejects.toThrow('oauth_refresh_failed');
    const oversized = await seed(storage);
    await expect(getOAuthAccessToken(storage.db, issuer, oversized.subject, 'client', 'secret', key, async () => new Response('{}', {
      headers: { 'content-length': String(64 * 1024 + 1) },
    }))).rejects.toThrow('oauth_refresh_failed');
  } finally { await storage.close(); }
});
