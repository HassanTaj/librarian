import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export function signedGitHubBody(body: Uint8Array, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Synthetic provider only: generated keys, explicit identities and a controlled clock. */
export async function createProviderFixtures(now = () => Date.now()) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const state = {
    subject: 'synthetic-reader', projectId: '123', roles: ['docs:private-one:reader'],
    clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret',
    failRoles: false, failToken: false,
    github: new Map<string, { status: number; body: unknown }>(),
  };
  const codes = new Map<string, { subject: string; nonce: string | null; challenge: string | null; redirect: string }>();
  const tokens = new Map<string, string>();
  function jwt(claims: Record<string, unknown>) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  }
  function json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }
  async function body(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 32 * 1024) throw new Error('Fixture request too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, origin);
      if (url.pathname === '/.well-known/openid-configuration') return json(response, 200, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`, userinfo_endpoint: `${origin}/userinfo`, end_session_endpoint: `${origin}/logout`,
        response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      });
      if (url.pathname === '/jwks') return json(response, 200, { keys: [jwk] });
      if (url.pathname === '/authorize') {
        const redirect = new URL(url.searchParams.get('redirect_uri')!);
        if (!['127.0.0.1', 'localhost'].includes(redirect.hostname) || url.searchParams.get('client_id') !== state.clientId || url.searchParams.get('response_type') !== 'code') return json(response, 400, { error: 'invalid_request' });
        const code = randomUUID();
        codes.set(code, { subject: state.subject, nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge'), redirect: redirect.href });
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
        response.writeHead(302, { Location: redirect.href });
        return response.end();
      }
      if (url.pathname === '/token') {
        if (state.failToken) return json(response, 503, { error: 'temporarily_unavailable' });
        const input = new URLSearchParams(await body(request));
        const basic = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
        if (basic !== `${state.clientId}:${state.clientSecret}` && (input.get('client_id') !== state.clientId || input.get('client_secret') !== state.clientSecret)) return json(response, 401, { error: 'invalid_client' });
        let subject: string | undefined;
        let nonce: string | null = null;
        if (input.get('grant_type') === 'authorization_code') {
          const code = input.get('code') ?? '';
          const authorization = codes.get(code);
          codes.delete(code);
          if (!authorization || authorization.redirect !== input.get('redirect_uri')) return json(response, 400, { error: 'invalid_grant' });
          if (authorization.challenge && createHash('sha256').update(input.get('code_verifier') ?? '').digest('base64url') !== authorization.challenge) return json(response, 400, { error: 'invalid_grant' });
          subject = authorization.subject;
          nonce = authorization.nonce;
        } else if (input.get('grant_type') === 'refresh_token') {
          const refresh = input.get('refresh_token') ?? '';
          subject = tokens.get(refresh);
          tokens.delete(refresh);
        }
        if (!subject) return json(response, 400, { error: 'invalid_grant' });
        const access = randomUUID();
        const refresh = randomUUID();
        tokens.set(access, subject); tokens.set(refresh, subject);
        const time = Math.floor(now() / 1000);
        return json(response, 200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 60, id_token: jwt({ iss: origin, sub: subject, aud: state.clientId, iat: time, exp: time + 60, ...(nonce ? { nonce } : {}) }) });
      }
      const subject = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (url.pathname === '/userinfo') return json(response, subject ? 200 : 401, subject ? { sub: subject, name: 'Synthetic Reader', email: 'reader@example.test' } : { error: 'invalid_token' });
      if (url.pathname === '/zitadel.authorization.v2.AuthorizationService/ListAuthorizations') {
        if (request.method !== 'POST' || request.headers['connect-protocol-version'] !== '1') return json(response, 400, { error: 'invalid_request' });
        if (state.failRoles) return json(response, 503, { error: 'temporarily_unavailable' });
        if (!subject) return json(response, 401, { error: 'invalid_token' });
        return json(response, 200, { authorizations: state.roles.map((role, index) => ({ id: `synthetic-${index}`, user: { id: subject }, project: { id: state.projectId }, state: 'STATE_ACTIVE', roles: [{ key: role }] })), pagination: { totalResult: state.roles.length, appliedLimit: 100 } });
      }
      if (url.pathname === '/logout') { response.writeHead(204); return response.end(); }
      const github = state.github.get(url.pathname);
      if (github) return json(response, github.status, github.body);
      return json(response, 404, { error: 'fixture_not_found' });
    })().catch(() => json(response, 400, { error: 'invalid_fixture_request' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, state, jwt, jwk,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
