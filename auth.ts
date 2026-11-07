import NextAuth, { type NextAuthConfig } from 'next-auth';
import { customFetch } from 'next-auth';
import ZITADEL, { type ZitadelProfile } from 'next-auth/providers/zitadel';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Db, MongoClient } from 'mongodb';
import { NextRequest } from 'next/server';
import { createLibrarianAdapter, persistOAuthSignInTokens } from './lib/auth/adapter';
import { getVerifiedRoles } from './lib/auth/roles';
import { loadConfig } from './lib/config';
import { getMongo } from './lib/mongo';
import { LIMITS } from './lib/limits';
import { operationEvent } from './lib/operations/logging';
import { readInstanceHost } from './lib/instance/bootstrap';
import { issueSetupOwnerProof, type SetupCandidateFlow } from './lib/instance/access';
import { decryptInstanceSecret } from './lib/instance/secrets';
import { InstanceBundleSchema, readInstance, updateInstance, type InstanceControl } from './lib/instance/store';
import { createPinnedFetch, runtimeProviderFetch } from './lib/instance/validation';

type Config = Awaited<ReturnType<typeof loadConfig>>;
type ServerAuth = ReturnType<typeof NextAuth>;
type RuntimeAuth = { server: ServerAuth; config: Config };

function safeRedirect(value: string, base: string) {
  if (/[\\\p{Cc}]/u.test(value) || value.startsWith('//')) return base;
  try {
    const target = new URL(value, base);
    return target.origin === base && !target.username && !target.password ? target.href : base;
  } catch { return base; }
}

export async function createServerAuth(config: Config, client: MongoClient, db: Db, now: () => number = Date.now): Promise<ServerAuth> {
  const adapter = await createLibrarianAdapter(client, db, config.zitadelIssuer, config.oauthTokenEncryptionKey, now);
  const secure = config.authUrl.startsWith('https://');
  const provider = ZITADEL({
    [customFetch]: await runtimeProviderFetch(config.zitadelIssuer),
    issuer: config.zitadelIssuer,
    clientId: config.zitadelClientId,
    clientSecret: config.zitadelSecret,
    client: { token_endpoint_auth_method: 'client_secret_basic' },
    authorization: { params: { scope: ['openid', 'profile', 'email', 'offline_access', config.zitadelApiAudience].join(' ') } },
    checks: ['pkce', 'state', 'nonce'],
    profile(profile: ZitadelProfile) {
      return { id: typeof profile.sub === 'string' ? profile.sub : '', name: null, email: null };
    },
  });
  const options: NextAuthConfig = {
    adapter,
    providers: [provider],
    secret: config.authSecret,
    trustHost: config.trustHost,
    useSecureCookies: secure,
    basePath: '/api/auth',
    session: { strategy: 'database', maxAge: LIMITS.sessionAbsoluteMs / 1000, updateAge: LIMITS.sessionAbsoluteMs / 1000 },
    cookies: { sessionToken: { name: `${secure ? '__Secure-' : ''}authjs.session-token`, options: { httpOnly: true, sameSite: 'lax', path: '/', secure } } },
    callbacks: {
      async signIn({ account, profile }) {
        const claims = profile as ZitadelProfile | undefined;
        if (account?.provider !== 'zitadel' || typeof account.providerAccountId !== 'string' ||
            claims?.iss !== config.zitadelIssuer || claims.sub !== account.providerAccountId) return false;
        await persistOAuthSignInTokens(db, config.zitadelIssuer, account, config.oauthTokenEncryptionKey, now);
        return true;
      },
      session({ session, user }) {
        return { expires: session.expires, user: { id: user.id } as typeof session.user };
      },
      redirect({ url, baseUrl }) { return safeRedirect(url, baseUrl); },
    },
    logger: { error(error) { console.error(operationEvent(error, null)); }, warn() {}, debug() {} },
  };
  return NextAuth(options);
}

export async function createCandidateAuth(host: Awaited<ReturnType<typeof readInstanceHost>>, db: Db, candidate: NonNullable<InstanceControl['candidate']>,
  flow: SetupCandidateFlow | null, now: () => number = Date.now): Promise<ServerAuth> {
  const bundle = InstanceBundleSchema.parse(candidate);
  const identitySecret = decryptInstanceSecret(bundle.secrets.zitadelClientSecret, {
    instanceId: host.instanceId, purpose: 'zitadelClientSecret', credentialVersion: bundle.secrets.zitadelClientSecret.credentialVersion,
  }, host.keyring);
  const testProviderCaFile = process.env.NODE_ENV === 'development' && new URL(bundle.zitadel.issuer).hostname === 'localhost' &&
    host.policy.origins.some(rule => rule.origin === bundle.zitadel.issuer) ? process.env.LIBRARIAN_TEST_PROVIDER_CA_FILE : undefined;
  const fetcher = createPinnedFetch({ policy: host.policy, ...(testProviderCaFile ? { ca: { origin: bundle.zitadel.issuer, certificate: await readFile(testProviderCaFile) } } : {}) });
  const adapterSecret = createHmac('sha256', host.config.authSecret).update(`librarian-candidate-auth\0${host.instanceId}`).digest('base64url');
  const provider = ZITADEL({
    issuer: bundle.zitadel.issuer,
    clientId: bundle.zitadel.clientId,
    clientSecret: identitySecret,
    client: { token_endpoint_auth_method: 'client_secret_basic' },
    authorization: { params: { scope: ['openid', 'profile', 'offline_access', bundle.zitadel.audience].join(' ') } },
    checks: ['pkce', 'state', 'nonce'],
    profile(profile: ZitadelProfile) { return { id: typeof profile.sub === 'string' ? profile.sub : '', name: null, email: null }; },
    [customFetch]: fetcher,
  });
  const options: NextAuthConfig = {
    providers: [provider], secret: adapterSecret, trustHost: true, useSecureCookies: true, basePath: '/api/instance/auth',
    session: { strategy: 'jwt', maxAge: LIMITS.instanceProofMs / 1000, updateAge: LIMITS.instanceProofMs / 1000 },
    cookies: {
      sessionToken: { name: '__Secure-librarian-candidate-session', options: { httpOnly: true, sameSite: 'lax', path: '/api/instance/auth', secure: true } },
      csrfToken: { name: '__Secure-librarian-candidate-csrf', options: { httpOnly: true, sameSite: 'lax', path: '/api/instance/auth', secure: true } },
      callbackUrl: { name: '__Secure-librarian-candidate-callback-url', options: { httpOnly: true, sameSite: 'lax', path: '/api/instance/auth', secure: true } },
      state: { name: '__Secure-librarian-candidate-state', options: { httpOnly: true, sameSite: 'lax', path: '/api/instance/auth', secure: true } },
      pkceCodeVerifier: { name: '__Secure-librarian-candidate-pkce', options: { httpOnly: true, sameSite: 'lax', path: '/api/instance/auth', secure: true } },
      nonce: { name: '__Secure-librarian-candidate-nonce', options: { httpOnly: true, sameSite: 'lax', path: '/api/instance/auth', secure: true } },
    },
    callbacks: {
      async signIn({ account, profile }) {
        const claims = profile as ZitadelProfile | undefined;
        if (!flow || account?.provider !== 'zitadel' || typeof account.providerAccountId !== 'string' ||
            typeof account.access_token !== 'string' || claims?.iss !== bundle.zitadel.issuer || claims.sub !== account.providerAccountId) return false;
        const identity = { issuer: bundle.zitadel.issuer, subject: claims.sub, projectId: bundle.zitadel.projectId };
        try {
          const roles = await getVerifiedRoles(db, identity, async () => account.access_token as string, fetcher, now);
          if (!roles.includes('librarian-instance-admin')) return false;
          const current = await readInstance(db, host.instanceId);
          const at = new Date(now());
          if (!current?.candidate || current.candidate.version !== flow.candidateVersion ||
              (flow.recovery ? current.lifecycle !== 'maintenance' || !current.initializedAt || !current.bootstrap.consumedAt
                : flow.ownerBindingId ? current.lifecycle !== 'ready' || !current.administrators.some(item => item.bindingId === flow.ownerBindingId && item.kind === 'owner' && item.status === 'active') : current.lifecycle === 'ready' || current.bootstrap.consumedAt) ||
              current.bootstrap.epoch !== flow.setupEpoch || current.recoveryEpoch !== flow.recoveryEpoch || current.securityEpoch !== flow.securityEpoch ||
              at >= flow.expiresAt) return false;
          const existing = current.candidate.ownerProof;
          if (existing && existing.expiresAt > at && existing.subject !== identity.subject) return false;
          const ownerProof = issueSetupOwnerProof(current, identity, at);
          const check = { type: 'zitadel_owner_login' as const, candidateVersion: flow.candidateVersion, at, status: 'passed' as const, code: 'provider_ok' as const };
          await updateInstance(db, host.instanceId, current.revision, latest => {
            if (!latest.candidate || latest.candidate.version !== flow.candidateVersion || latest.securityEpoch !== flow.securityEpoch ||
                latest.recoveryEpoch !== flow.recoveryEpoch || latest.bootstrap.epoch !== flow.setupEpoch) throw new Error('instance_conflict');
            return { ...latest, lifecycle: flow.ownerBindingId || flow.recovery ? latest.lifecycle : 'awaiting_owner', candidate: { ...latest.candidate, ownerProof,
              checks: [...latest.candidate.checks.filter(item => item.type !== 'zitadel_owner_login'), check] } };
          }, at);
          return true;
        } catch { return false; }
      },
      redirect({ url }) {
        try {
          const target = new URL(safeRedirect(url, host.setupOrigin));
          const path = flow?.ownerBindingId ? '/instance/settings' : '/instance/setup';
          return target.origin === host.setupOrigin && target.pathname === path ? target.href : `${host.setupOrigin}${path}`;
        } catch { return `${host.setupOrigin}${flow?.ownerBindingId ? '/instance/settings' : '/instance/setup'}`; }
      },
    },
    logger: { error(error) {
      const type = Reflect.get(error, 'type');
      const message = Reflect.get(error, 'message');
      const fallbackType = error instanceof Error ? error.name : 'unknown';
      const event: Record<string, string | number> = { ...operationEvent(error, null), authErrorType: typeof type === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(type)
        ? type : /^[A-Za-z0-9_-]{1,64}$/.test(fallbackType) ? fallbackType : 'unknown' };
      const safeCode = error instanceof Error && /^(?:provider_unavailable|request_timeout|invalid_configuration|response_invalid|authentication_failed|permission_denied|installation_missing|delivery_unverified|rate_limited)$/.test(error.message)
        ? error.message : undefined;
      if (safeCode) event.authErrorCode = safeCode;
      const actionPath = typeof message === 'string' ? /^Cannot parse action at (\/[A-Za-z0-9/_-]{1,200})$/.exec(message)?.[1] : undefined;
      if (actionPath) event.authErrorPath = actionPath;
      console.error(event);
    }, warn() {}, debug() {} },
  };
  return NextAuth(options);
}

let server: Promise<RuntimeAuth> | undefined;
let serverVersion: string | undefined;
async function getServerAuth() {
  if (process.env.INSTANCE_ID || process.env.INSTANCE_STATE_FILE) {
    const config = await loadConfig();
    const host = await readInstanceHost();
    const { db } = await getMongo(config);
    const control = await readInstance(db, host.instanceId);
    const version = JSON.stringify([host.instanceId, control?.active?.version, control?.securityEpoch, control?.recoveryEpoch]);
    if (version !== serverVersion) { server = undefined; serverVersion = version; }
  }
  server ??= loadConfig().then(async config => {
    const mongo = await getMongo(config);
    return { config, server: await createServerAuth(config, mongo.client, mongo.db) };
  })
    .catch(error => { server = undefined; throw error; });
  return server;
}

export async function auth() { return (await getServerAuth()).server.auth(); }
export async function getAuthContext() {
  const runtime = await getServerAuth();
  return { session: await runtime.server.auth(), config: runtime.config };
}

export const handlers = {
  GET: (request: NextRequest) => handleRuntimeAuth(request, 'GET'),
  POST: (request: NextRequest) => handleRuntimeAuth(request, 'POST'),
};

async function handleRuntimeAuth(request: NextRequest, method: 'GET' | 'POST') {
  try {
    const { db } = await getMongo();
    const { withRuntimeInstanceAdmission, instanceErrorResponse } = await import('./lib/instance/access');
    return await withRuntimeInstanceAdmission(db, 'request', async () => {
      const { config, server } = await getServerAuth();
      const authUrl = new URL(request.url);
      const expected = new URL(config.authUrl);
      const forwardedProtocol = request.headers.get('x-forwarded-proto');
      const forwardedHost = request.headers.get('x-forwarded-host');
      if (config.trustHost && (forwardedProtocol || forwardedHost)) {
        // Standalone Next.js exposes its container URL; trust only the configured proxy origin.
        if (forwardedProtocol !== expected.protocol.slice(0, -1) ||
            (forwardedHost ?? request.headers.get('host')) !== expected.host) return instanceErrorResponse(new Error('instance_origin'));
        authUrl.protocol = expected.protocol;
        authUrl.host = expected.host;
        authUrl.port = expected.port;
      }
      const authRequest = new NextRequest(authUrl, request);
      if (authRequest.nextUrl.origin !== new NextRequest(expected).nextUrl.origin) return instanceErrorResponse(new Error('instance_origin'));
      return server.handlers[method](authRequest);
    });
  } catch { return Response.json({ error: { code: 'authentication_unavailable', message: 'Authentication is temporarily unavailable.' } },
    { status: 503, headers: { 'Cache-Control': 'private, no-store' } }); }
}
