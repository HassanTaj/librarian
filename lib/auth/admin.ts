import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { auth, getAuthContext } from '../../auth';
import { getMongo } from '../mongo';
import { getVerifiedRoles } from './roles';
import { getOAuthAccessToken } from './tokens';
import { LIMITS } from '../limits';

export function adminCsrfToken(secret: string, sessionToken: string) {
  return createHmac('sha256', secret).update(`librarian-admin\0${sessionToken}`).digest('base64url');
}

function sessionToken(request: Request, secure: boolean) {
  const name = `${secure ? '__Secure-' : ''}authjs.session-token`;
  const value = request.headers.get('cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value || value.length > 4096 || !/^[A-Za-z0-9._~-]+$/.test(value)) throw new Error('admin_csrf');
  return value;
}

export async function requireAdmin(request: Request, mutation = false) {
  let context: Awaited<ReturnType<typeof getAuthContext>>;
  try { context = await getAuthContext(); } catch { throw new Error('admin_unavailable'); }
  const userId = context.session?.user?.id;
  if (typeof userId !== 'string' || !/^[a-f0-9]{24}$/i.test(userId)) throw new Error('admin_unauthorized');
  let db: Db;
  try { ({ db } = await getMongo()); } catch { throw new Error('admin_unavailable'); }
  const accountFilter = { provider: 'zitadel', issuer: context.config.zitadelIssuer, userId: new ObjectId(userId) };
  let account: { providerAccountId: string } | null;
  try { account = await db.collection<{ providerAccountId: string }>('accounts').findOne(accountFilter, { projection: { providerAccountId: 1 } }); }
  catch { throw new Error('admin_unavailable'); }
  if (!account || typeof account.providerAccountId !== 'string' || !account.providerAccountId) throw new Error('admin_forbidden');
  const identity = { issuer: context.config.zitadelIssuer, subject: account.providerAccountId, projectId: context.config.zitadelProjectId };
  let roles: string[];
  try {
    roles = await getVerifiedRoles(db, identity, () => getOAuthAccessToken(db, identity.issuer, identity.subject,
      context.config.zitadelClientId, context.config.zitadelSecret, context.config.oauthTokenEncryptionKey));
  } catch { throw new Error('admin_unavailable'); }
  if (!roles.includes('librarian-admin')) throw new Error('admin_forbidden');
  let current;
  try { current = await auth(); } catch { throw new Error('admin_unauthorized'); }
  if (current?.user?.id !== userId) throw new Error('admin_unauthorized');
  let stillLinked: { providerAccountId: string } | null;
  try { stillLinked = await db.collection<{ providerAccountId: string }>('accounts').findOne(accountFilter, { projection: { providerAccountId: 1 } }); }
  catch { throw new Error('admin_unavailable'); }
  if (stillLinked?.providerAccountId !== identity.subject) throw new Error('admin_unauthorized');

  const session = sessionToken(request, context.config.authUrl.startsWith('https://'));
  const csrfToken = adminCsrfToken(context.config.authSecret, session);
  if (mutation) {
    const origin = request.headers.get('origin');
    if (origin !== context.config.authUrl) throw new Error('admin_origin');
    const supplied = request.headers.get('x-csrf-token') ?? '';
    const expectedBytes = Buffer.from(csrfToken);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) throw new Error('admin_csrf');
  }
  return { db, config: context.config, csrfToken, userId };
}

export async function readAdminJson(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > LIMITS.maxAdminBytes) throw new Error('admin_too_large');
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.maxAdminBytes) {
        await reader.cancel();
        throw new Error('admin_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'admin_too_large') throw error;
    throw new Error('admin_invalid_json');
  } finally { reader.releaseLock(); }
  if (!size) return {};
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw new Error('admin_invalid_json'); }
}

const messages: Record<string, string> = {
  admin_unauthorized: 'Sign in to continue.', admin_forbidden: 'Administrator access is required.',
  admin_origin: 'The request origin is not allowed.', admin_csrf: 'The request could not be verified.',
  admin_invalid_json: 'The request body is not valid JSON.', admin_invalid_request: 'The request fields are invalid.',
  admin_too_large: 'The request exceeds the allowed size.', admin_unavailable: 'Administration is temporarily unavailable.',
  public_approval_required: 'An owner-approved publication record is required before making a catalog public.',
  catalog_conflict: 'The catalog conflicts with an existing source or route.', catalog_not_found: 'The catalog is unavailable.',
  catalog_busy: 'A synchronization or reader request is active. Wait for it to finish, then try again.',
  sync_catalog_unavailable: 'The catalog is not ready to synchronize.', sync_catalog_conflict: 'The catalog changed. Try again.',
  sync_rate_limited: 'Too many synchronization requests. Try again shortly.',
  sync_quota_exhausted: 'The catalog has reached its synchronization limit.', sync_storage_unavailable: 'Synchronization storage is unavailable.',
  github_invalid_catalog: 'The selected repository configuration is invalid.', github_docs_missing: 'The configured documentation folder was not found.',
  github_access_denied: 'The application cannot read the selected repository.', github_not_found: 'The selected repository was not found.',
  github_invalid_content: 'The selected documentation content is unsupported or exceeds its limits.',
};

export function adminErrorResponse(error: unknown) {
  const value = error instanceof Error ? error.message : '';
  const code = Object.hasOwn(messages, value) ? value : 'admin_unavailable';
  const status = code === 'admin_unauthorized' ? 401 : ['admin_forbidden', 'admin_origin', 'admin_csrf'].includes(code) ? 403
    : code === 'admin_too_large' ? 413 : code === 'sync_rate_limited' ? 429
    : ['admin_invalid_json', 'admin_invalid_request', 'github_invalid_catalog', 'github_docs_missing', 'github_access_denied', 'github_not_found', 'github_invalid_content'].includes(code) ? 400
    : code === 'catalog_not_found' ? 404
    : ['catalog_conflict', 'catalog_busy', 'sync_catalog_unavailable', 'sync_catalog_conflict', 'public_approval_required'].includes(code) ? 409 : 503;
  return Response.json({ error: { code, message: messages[code] }, requestId: randomUUID() }, {
    status, headers: { 'Cache-Control': 'private, no-store' },
  });
}
