import { createHash, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { LIMITS } from '../limits';

export type RoleIdentity = { issuer: string; subject: string; projectId: string };
type RoleRecord = { _id: string } & RoleIdentity & { roles: string[]; verifiedAt: Date | null; leaseFence: number;
  lease: { owner: string; fence: number; expiresAt: Date } | null };

const identityId = ({ issuer, subject, projectId }: RoleIdentity) => createHash('sha256').update(`${issuer}\0${subject}\0${projectId}`).digest('hex');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const refreshes = new Map<string, Promise<string[]>>();
const count = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('role_verification_failed');
  return parsed;
};

async function readPage(response: Response) {
  if (!response.ok || !response.body) throw new Error('role_verification_failed');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.maxRoleResponseBytes) throw new Error('role_verification_failed');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel(); throw error; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
  catch { throw new Error('role_verification_failed'); }
}

export async function listCurrentRoles(issuer: string, subject: string, projectId: string, accessToken: string,
  fetcher: typeof fetch = fetch) {
  if (fetcher === fetch) fetcher = await (await import('../instance/validation')).runtimeProviderFetch(issuer);
  const endpoint = new URL('/zitadel.authorization.v2.AuthorizationService/ListAuthorizations', issuer);
  const roles = new Set<string>();
  const ids = new Set<string>();
  let offset = 0;
  let total: number | undefined;
  let pageSize: number | undefined;
  for (let page = 0; page < LIMITS.maxRolePages; page++) {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'connect-protocol-version': '1' },
      body: JSON.stringify({ pagination: { offset, limit: LIMITS.rolePageSize, asc: true }, sortingColumn: 'AUTHORIZATION_FIELD_NAME_ID',
        filters: [{ inUserIds: { ids: [subject] } }, { projectId: { id: projectId } }, { state: { state: 'STATE_ACTIVE' } }] }),
      signal: AbortSignal.timeout(LIMITS.roleQueryTimeoutMs),
    });
    const body = await readPage(response);
    if (!body.pagination || typeof body.pagination !== 'object' || !Array.isArray(body.authorizations)) throw new Error('role_verification_failed');
    const pagination = body.pagination as Record<string, unknown>;
    const reportedTotal = count(pagination.totalResult);
    const appliedLimit = count(pagination.appliedLimit);
    if (reportedTotal > LIMITS.maxRolePages * LIMITS.rolePageSize ||
        (total !== undefined && (reportedTotal !== total || appliedLimit !== pageSize))) throw new Error('role_verification_failed');
    total = reportedTotal;
    if (reportedTotal === 0) {
      if (body.authorizations.length) throw new Error('role_verification_failed');
      return [];
    }
    if (appliedLimit < 1 || appliedLimit > LIMITS.rolePageSize || body.authorizations.length !== Math.min(appliedLimit, reportedTotal - offset)) {
      throw new Error('role_verification_failed');
    }
    pageSize = appliedLimit;
    for (const value of body.authorizations) {
      if (!value || typeof value !== 'object') throw new Error('role_verification_failed');
      const authorization = value as Record<string, unknown>;
      const user = authorization.user as Record<string, unknown> | undefined;
      const project = authorization.project as Record<string, unknown> | undefined;
      if (typeof authorization.id !== 'string' || !authorization.id || ids.has(authorization.id) || user?.id !== subject ||
          project?.id !== projectId || authorization.state !== 'STATE_ACTIVE' || !Array.isArray(authorization.roles) || !authorization.roles.length) {
        throw new Error('role_verification_failed');
      }
      ids.add(authorization.id);
      for (const item of authorization.roles) {
        const key = item && typeof item === 'object' ? (item as Record<string, unknown>).key : undefined;
        if (typeof key !== 'string' || !key || [...key].length > 200 || /\p{Cc}/u.test(key)) throw new Error('role_verification_failed');
        roles.add(key);
      }
    }
    offset += appliedLimit;
    if (offset >= total) return [...roles].sort();
    if (page === LIMITS.maxRolePages - 1) throw new Error('role_verification_failed');
  }
  throw new Error('role_verification_failed');
}

function cached(record: RoleRecord | null, identity: RoleIdentity, now: number) {
  if (!record || record.issuer !== identity.issuer || record.subject !== identity.subject || record.projectId !== identity.projectId ||
      !(record.verifiedAt instanceof Date) || !Array.isArray(record.roles) || now < record.verifiedAt.getTime() ||
      now - record.verifiedAt.getTime() >= LIMITS.roleFreshMs || record.roles.some(role => typeof role !== 'string')) return undefined;
  return record.roles;
}

export async function getVerifiedRoles(db: Db, identity: RoleIdentity, accessToken: () => Promise<string>,
  fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  const key = identityId(identity);
  const existing = refreshes.get(key);
  if (existing) return existing;
  const refresh = verifyRoles(db, identity, key, accessToken, fetcher, now);
  refreshes.set(key, refresh);
  try { return await refresh; }
  finally { if (refreshes.get(key) === refresh) refreshes.delete(key); }
}

async function verifyRoles(db: Db, identity: RoleIdentity, _id: string, accessToken: () => Promise<string>,
  fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  const records = db.collection<RoleRecord>('identity_authorizations');
  try {
    await records.updateOne({ _id }, { $setOnInsert: { ...identity, roles: [], verifiedAt: null, leaseFence: 0, lease: null } }, { upsert: true });
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw new Error('role_verification_failed');
  }
  const owner = randomUUID();
  const started = Date.now();
  while (Date.now() - started <= LIMITS.roleContenderMs) {
    const current = await records.findOne({ _id });
    if (!current || current.issuer !== identity.issuer || current.subject !== identity.subject || current.projectId !== identity.projectId ||
        !Number.isSafeInteger(current.leaseFence) || (current.lease !== null && current.lease !== undefined &&
          (!(current.lease.expiresAt instanceof Date) || typeof current.lease.owner !== 'string' || !Number.isSafeInteger(current.lease.fence)))) {
      throw new Error('role_verification_failed');
    }
    const fresh = cached(current, identity, now());
    if (fresh) return fresh;
    const fence = current.leaseFence + 1;
    const time = new Date(now());
    const claimed = await records.findOneAndUpdate({ _id, leaseFence: current.leaseFence,
      $or: [{ lease: null }, { lease: { $exists: false } }, { 'lease.expiresAt': { $lte: time } }],
    }, { $set: { leaseFence: fence, lease: { owner, fence, expiresAt: new Date(time.getTime() + LIMITS.roleLeaseMs) } } }, { returnDocument: 'after' });
    if (!claimed) { await wait(25); continue; }
    try {
      const roles = await listCurrentRoles(identity.issuer, identity.subject, identity.projectId, await accessToken(), fetcher);
      const verifiedAt = new Date(now());
      const updated = await records.findOneAndUpdate({ _id, 'lease.owner': owner, 'lease.fence': fence, leaseFence: fence },
        { $set: { roles, verifiedAt, lease: null } }, { returnDocument: 'after' });
      if (!updated) throw new Error('role_verification_failed');
      return roles;
    } catch (error) {
      await records.updateOne({ _id, 'lease.owner': owner, 'lease.fence': fence, leaseFence: fence }, { $set: { lease: null } });
      if (error instanceof Error && error.message === 'role_verification_failed') throw error;
      throw new Error('role_verification_failed');
    }
  }
  throw new Error('role_verification_busy');
}
