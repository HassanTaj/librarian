import { connectMongo } from '@/lib/mongo';
import { createCandidateAuth } from '@/auth';
import { readInstanceHost } from '@/lib/instance/bootstrap';
import { instanceErrorResponse, issueSetupCandidateFlow, readInstanceSetupSession, verifySetupCandidateFlow } from '@/lib/instance/access';
import { readInstance } from '@/lib/instance/store';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { requireInstanceAdmin } from '@/lib/instance/access';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const setupCookieName = '__Host-librarian_setup';
const callbackSetupCookieName = '__Secure-librarian_candidate_setup';
const flowCookieName = '__Secure-librarian_candidate_flow';
const callbackPath = '/api/instance/auth/callback/zitadel';

function cookie(request: Request, name: string) {
  return request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

function withCookie(response: Response, value: string) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handle(request: NextRequest, method: 'GET' | 'POST') {
  let client: Awaited<ReturnType<typeof connectMongo>>['client'] | undefined;
  try {
    const host = await readInstanceHost();
    const storage = await connectMongo(host.config, { initializeLegacy: false });
    client = storage.client;
    const control = await readInstance(storage.db, host.instanceId);
    if (!control?.candidate) throw new Error('instance_setup_unauthorized');
    let ownerBindingId: string | undefined;
    let recovery = false;
    let setupToken = cookie(request, setupCookieName) || cookie(request, callbackSetupCookieName);
    let expiresAt: Date;
    if (control.lifecycle === 'ready') {
      const authority = await requireInstanceAdmin(request);
      if (authority.binding.kind !== 'owner') throw new Error('instance_forbidden');
      ownerBindingId = authority.binding.bindingId;
      const runtimeToken = cookie(request, '__Secure-authjs.session-token') || cookie(request, 'authjs.session-token');
      setupToken = createHash('sha256').update(runtimeToken).digest('base64url');
      expiresAt = new Date(Date.now() + 600_000);
    } else {
      const session = await readInstanceSetupSession(storage.db, host.instanceId, setupToken);
      recovery = session.purpose === 'recovery';
      if (recovery && host.operator.purpose !== 'recover') throw new Error('instance_forbidden');
      expiresAt = session.expiresAt;
    }
    if (new URL(request.url).origin !== host.setupOrigin) throw new Error('instance_origin');
    if (control.candidate.publicOrigin !== host.setupOrigin) throw new Error('instance_operator_required');
    const flow = verifySetupCandidateFlow(host.config.authSecret, cookie(request, flowCookieName), control, setupToken);
    const server = await createCandidateAuth(host, storage.db, control.candidate, flow);
    const handler = method === 'GET' ? server.handlers.GET : server.handlers.POST;
    const response = await handler(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/signin/zitadel') && response.headers.has('Location')) {
      const maxAge = Math.min(600, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      if (maxAge > 0) {
        const flowToken = issueSetupCandidateFlow(host.config.authSecret, control, setupToken, new Date(), ownerBindingId, recovery);
        const withSetupToken = withCookie(response,
          `${callbackSetupCookieName}=${setupToken}; Path=${callbackPath}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
        return withCookie(withSetupToken,
          `${flowCookieName}=${flowToken}; Path=${callbackPath}; Max-Age=${Math.min(600, maxAge)}; HttpOnly; Secure; SameSite=Lax`);
      }
    }
    if (path.endsWith('/callback/zitadel')) {
      return withCookie(withCookie(response,
        `${callbackSetupCookieName}=; Path=${callbackPath}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`),
      `${flowCookieName}=; Path=${callbackPath}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    }
    return response;
  } catch (error) { return instanceErrorResponse(error); }
  finally { await client?.close(); }
}

export async function GET(request: NextRequest) { return handle(request, 'GET'); }
export async function POST(request: NextRequest) { return handle(request, 'POST'); }
