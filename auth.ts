import NextAuth, { type NextAuthConfig } from 'next-auth';
import ZITADEL, { type ZitadelProfile } from 'next-auth/providers/zitadel';
import type { Db, MongoClient } from 'mongodb';
import type { NextRequest } from 'next/server';
import { createLibrarianAdapter, persistOAuthSignInTokens } from './lib/auth/adapter';
import { loadConfig } from './lib/config';
import { getMongo } from './lib/mongo';
import { LIMITS } from './lib/limits';
import { operationEvent } from './lib/operations/logging';

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
        session.user = { id: user.id } as typeof session.user;
        return session;
      },
      redirect({ url, baseUrl }) { return safeRedirect(url, baseUrl); },
    },
    logger: { error(error) { console.error(operationEvent(error, null)); }, warn() {}, debug() {} },
  };
  return NextAuth(options);
}

let server: Promise<RuntimeAuth> | undefined;
async function getServerAuth() {
  server ??= Promise.all([loadConfig(), getMongo()]).then(async ([config, mongo]) => ({
    config, server: await createServerAuth(config, mongo.client, mongo.db),
  }))
    .catch(error => { server = undefined; throw error; });
  return server;
}

export async function auth() { return (await getServerAuth()).server.auth(); }
export async function getAuthContext() {
  const runtime = await getServerAuth();
  return { session: await runtime.server.auth(), config: runtime.config };
}

export const handlers = {
  GET: async (request: NextRequest) => (await getServerAuth()).server.handlers.GET(request),
  POST: async (request: NextRequest) => (await getServerAuth()).server.handlers.POST(request),
};
