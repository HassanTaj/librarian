import { describe, expect, it } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorageHarness, startNextHarness } from './http-harness';
import { createProviderFixtures, signedGitHubBody } from '../fixtures/providers';

describe('disposable integration boundaries', () => {
  it('uses a real isolated Mongo database and filesystem and removes only its own data', async () => {
    const storage = await createStorageHarness();
    const client = storage.client;
    const root = storage.root;
    try {
      await storage.db.collection('probe').insertOne({ kind: 'synthetic' });
      expect(await storage.db.collection('probe').countDocuments()).toBe(1);
      expect(storage.db.databaseName).toMatch(/^librarian_test_[a-f0-9]+$/);
      const path = join(storage.contentRoot, 'synthetic.md');
      await writeFile(path, '# Synthetic content');
      expect(await readFile(path, 'utf8')).toBe('# Synthetic content');
    } finally { await storage.close(); }
    await expect(readFile(join(root, 'content', 'synthetic.md'))).rejects.toThrow();
    await expect(client.db('librarian_test_closed').command({ ping: 1 })).rejects.toThrow();
  });

  it('refuses any non-disposable Mongo URI before connecting', async () => {
    await expect(createStorageHarness('mongodb://remote.example.test')).rejects.toThrow('Disposable loopback');
  });

  it('serves the actual built Next application over HTTP and shuts down', async () => {
    const server = await startNextHarness({ appRoot: process.cwd(), port: 3187 });
    try {
      const directory = await fetch(server.origin);
      expect(directory.status).toBe(200);
      expect(await directory.text()).toContain('Project documentation');
      const search = await fetch(`${server.origin}/api/search?query=synthetic`);
      expect([200, 404]).toContain(search.status); // Next can stream the catch-all not-found page with a committed 200.
      expect(await search.text()).toContain('Page unavailable');
    } finally { await server.close(); }
    await expect(fetch(server.origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it('signs original GitHub bytes with the standard HMAC', () => {
    expect(signedGitHubBody(Buffer.from('Hi There'), '\x0b'.repeat(20))).toBe('sha256=b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  it('exercises OIDC discovery, JWKS, PKCE, current-role lookup and rotated refresh tokens', async () => {
    const providers = await createProviderFixtures(() => 1_800_000_000_000);
    try {
      const discovery = await (await fetch(`${providers.origin}/.well-known/openid-configuration`)).json();
      expect(discovery.issuer).toBe(providers.origin);
      const jwks = await (await fetch(discovery.jwks_uri)).json();
      expect(jwks.keys).toEqual([providers.jwk]);
      const verifier = 'synthetic-pkce-verifier-with-sufficient-length';
      const authorize = new URL(discovery.authorization_endpoint);
      authorize.search = new URLSearchParams({ client_id: providers.state.clientId, redirect_uri: 'http://127.0.0.1:3187/callback', response_type: 'code', state: 'synthetic-state', nonce: 'synthetic-nonce', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      const login = await fetch(authorize, { redirect: 'manual' });
      expect(login.status).toBe(302);
      const redirect = new URL(login.headers.get('location')!);
      expect(redirect.searchParams.get('state')).toBe('synthetic-state');
      const code = redirect.searchParams.get('code')!;
      async function token(body: Record<string, string>) {
        return fetch(discovery.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${providers.state.clientId}:${providers.state.clientSecret}`).toString('base64')}` }, body: new URLSearchParams(body) });
      }
      const response = await token({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:3187/callback', code_verifier: verifier });
      expect(response.status).toBe(200);
      const issued = await response.json();
      const [header, payload, signature] = issued.id_token.split('.');
      expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key: providers.jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))).toBe(true);
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ sub: providers.state.subject, nonce: 'synthetic-nonce', iat: 1_800_000_000 });
      const roles = await fetch(`${providers.origin}/zitadel.authorization.v2.AuthorizationService/ListAuthorizations`, { method: 'POST', headers: { Authorization: `Bearer ${issued.access_token}`, 'Connect-Protocol-Version': '1' } });
      expect((await roles.json()).authorizations[0]).toMatchObject({ user: { id: providers.state.subject }, project: { id: providers.state.projectId }, state: 'STATE_ACTIVE', roles: [{ key: 'docs:private-one:reader' }] });
      const renewed = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
      expect(renewed.status).toBe(200);
      expect((await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token })).status).toBe(400);
      expect((await token({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:3187/callback', code_verifier: verifier })).status).toBe(400);
    } finally { await providers.close(); }
  });
});
