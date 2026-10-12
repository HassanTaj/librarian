import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { NextRequest } from 'next/server';
import { createServerAuth } from '../../auth';
import { createProviderFixtures } from '../fixtures/providers';
import { createStorageHarness } from './http-harness';

function cookieJar() {
  const jar = new Map<string, string>();
  return {
    header: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    update(headers: Headers) {
      for (const cookie of headers.getSetCookie()) {
        const [pair, ...attributes] = cookie.split(';');
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator);
        if (attributes.some(attribute => attribute.trim().toLowerCase() === 'max-age=0')) jar.delete(name);
        else jar.set(name, pair.slice(separator + 1));
      }
    },
  };
}

it('runs the OIDC code flow, stores encrypted tokens and enforces database-session logout', async () => {
  const provider = await createProviderFixtures();
  const storage = await createStorageHarness();
  const runtime = await createServerAuth({
    authUrl: 'http://127.0.0.1', trustHost: true, authSecret: Buffer.alloc(32, 9).toString('base64'),
    zitadelClientId: provider.state.clientId, zitadelSecret: provider.state.clientSecret, zitadelIssuer: provider.origin,
    zitadelProjectId: provider.state.projectId, zitadelApiAudience: 'urn:zitadel:iam:org:project:id:zitadel:aud',
    oauthTokenEncryptionKey: Buffer.alloc(32, 5),
  } as Parameters<typeof createServerAuth>[0], storage.client, storage.db);
  const app = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new NextRequest(new URL(incoming.url ?? '/', `http://${incoming.headers.host}`), {
        method: incoming.method,
        headers,
        ...(bytes.length ? { body: bytes } : {}),
      });
      const response = incoming.method === 'POST' ? await runtime.handlers.POST(request) : await runtime.handlers.GET(request);
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers.entries()), 'set-cookie': response.headers.getSetCookie() });
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic Auth.js listener unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  const cookies = cookieJar();
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookies.header()) headers.set('cookie', cookies.header());
    const response = await fetch(`${origin}${path}`, { ...init, headers, redirect: 'manual' });
    cookies.update(response.headers);
    return response;
  };
  try {
    const signInPage = await request('/api/auth/signin?callbackUrl=%2Fafter-login');
    expect(signInPage.status).toBe(200);
    expect(await signInPage.text()).toMatch(/<form[^>]+action="[^"]*\/api\/auth\/signin\/zitadel" method="POST"/);

    const csrf = await request('/api/auth/csrf');
    const csrfToken = (await csrf.json() as { csrfToken: string }).csrfToken;
    const signIn = await request('/api/auth/signin/zitadel', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, callbackUrl: `${origin}/after-login` }) });
    expect(signIn.status).toBe(302);
    const authorization = await fetch(signIn.headers.get('location')!, { redirect: 'manual' });
    expect(authorization.status, `${authorization.url}: ${await authorization.clone().text()}`).toBe(302);
    const callback = new URL(authorization.headers.get('location')!);
    const completed = await request(callback.pathname + callback.search);
    expect(completed.status).toBe(302);
    const sessionResponse = await request('/api/auth/session');
    const session = await sessionResponse.json() as { user?: Record<string, unknown>; expires?: string };
    expect(Object.keys(session.user ?? {})).toEqual(['id']);
    expect(session.expires).toBeTruthy();
    const account = await storage.db.collection('accounts').findOne({ provider: 'zitadel', issuer: provider.origin });
    expect(account?.providerAccountId).toBe(provider.state.subject);
    expect(account?.encryptedTokens).toBeDefined();
    expect(account?.access_token).toBeUndefined();
    expect(account?.refresh_token).toBeUndefined();
    expect(account?.id_token).toBeUndefined();
    expect(JSON.stringify(account)).not.toContain(provider.state.clientSecret);
    const storedSession = await storage.db.collection('sessions').findOne({ sessionToken: { $exists: true } });
    expect(storedSession?.createdAt).toBeInstanceOf(Date);
    expect(storedSession?.absoluteExpiresAt.getTime() - storedSession?.createdAt.getTime()).toBe(8 * 60 * 60 * 1000);

    const nextCsrf = await request('/api/auth/csrf');
    const signOutToken = (await nextCsrf.json() as { csrfToken: string }).csrfToken;
    const signOut = await request('/api/auth/signout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: signOutToken, callbackUrl: `${origin}/` }) });
    expect(signOut.status).toBe(302);
    await expect((await request('/api/auth/session')).json()).resolves.toBeNull();
    expect(await storage.db.collection('sessions').countDocuments()).toBe(0);

    const unsafeCsrf = await request('/api/auth/csrf');
    const unsafeCsrfToken = (await unsafeCsrf.json() as { csrfToken: string }).csrfToken;
    const unsafeRedirect = await request('/api/auth/signout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: unsafeCsrfToken, callbackUrl: 'http://[' }) });
    expect(unsafeRedirect.status).toBe(302);
    const safeLocation = new URL(unsafeRedirect.headers.get('location')!);
    expect(['127.0.0.1', 'localhost']).toContain(safeLocation.hostname);
    expect(safeLocation.port).toBe(String(address.port));

    const relativeCsrf = await request('/api/auth/csrf');
    const relativeCsrfToken = (await relativeCsrf.json() as { csrfToken: string }).csrfToken;
    const relativeRedirect = await request('/api/auth/signout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: relativeCsrfToken, callbackUrl: '//external.invalid' }) });
    expect(relativeRedirect.status).toBe(302);
    const safeRelativeLocation = new URL(relativeRedirect.headers.get('location')!);
    expect(['127.0.0.1', 'localhost']).toContain(safeRelativeLocation.hostname);
    expect(safeRelativeLocation.port).toBe(String(address.port));
  } finally {
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
    await provider.close();
    await storage.close();
  }
});
