import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { getVerifiedRoles, type RoleIdentity } from '../auth/roles';
import { LIMITS } from '../limits';
import { verifyBootstrapCredential } from './bootstrap';
import { readInstance, type InstanceControl } from './store';
import { parseDocument } from 'yaml';

export async function requireInstanceAdmin(request: Request, mutation = false) {
  const [{ getAuthContext }, { getMongo }, { readInstanceHost }, { getOAuthAccessToken }, { runtimeProviderFetch }] = await Promise.all([
    import('../../auth'), import('../mongo'), import('./bootstrap'), import('../auth/tokens'), import('./validation'),
  ]);
  const host = await readInstanceHost();
  const context = await getAuthContext();
  const userId = context.session?.user?.id;
  if (typeof userId !== 'string' || !/^[a-f0-9]{24}$/i.test(userId)) throw new Error('instance_unauthorized');
  const { db } = await getMongo(context.config);
  const account = await db.collection('accounts').findOne({ userId: new ObjectId(userId), provider: 'zitadel', issuer: context.config.zitadelIssuer });
  if (typeof account?.providerAccountId !== 'string' || !account.providerAccountId) throw new Error('instance_forbidden');
  const identity = { issuer: context.config.zitadelIssuer, subject: account.providerAccountId, projectId: context.config.zitadelProjectId };
  const secure = context.config.authUrl.startsWith('https://');
  const name = `${secure ? '__Secure-' : ''}authjs.session-token`;
  const values = (request.headers.get('cookie') ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  if (values.length !== 1) throw new Error('instance_unauthorized');
  const token = values[0].slice(name.length + 1);
  if (!/^[A-Za-z0-9._~-]{1,4096}$/.test(token)) throw new Error('instance_unauthorized');
  const session = await db.collection('sessions').findOne({ sessionToken: token, userId: new ObjectId(userId) });
  const control = await readInstance(db, host.instanceId);
  if (!control?.active || !session || !(session.expires instanceof Date) || session.expires <= new Date() ||
      session.instanceId !== host.instanceId || session.securityEpoch !== control.securityEpoch || session.recoveryEpoch !== control.recoveryEpoch) throw new Error('instance_unauthorized');
  const fetcher = await runtimeProviderFetch(identity.issuer);
  const binding = await requireInstanceAuthority({ db, instanceId: host.instanceId, identity,
    epochs: { securityEpoch: session.securityEpoch, recoveryEpoch: session.recoveryEpoch }, fetcher,
    accessToken: () => getOAuthAccessToken(db, identity.issuer, identity.subject, context.config.zitadelClientId,
      context.config.zitadelSecret, context.config.oauthTokenEncryptionKey, fetcher) });
  const csrfToken = instanceCsrfToken(context.config.authSecret, token);
  if (mutation) verifyInstanceMutation(request, control.active.publicOrigin, csrfToken);
  const latest = await readInstance(db, host.instanceId);
  if (!latest) throw new Error('instance_unavailable');
  verifyInstanceAuthority(latest, identity, ['librarian-instance-admin'], { securityEpoch: session.securityEpoch, recoveryEpoch: session.recoveryEpoch });
  return { db, host, control: latest, binding, identity, csrfToken };
}

export async function requireLegacyEnrollmentAuthority(request: Request, mutation = true) {
  const { requireAdmin } = await import('../auth/admin');
  const context = await requireAdmin(request, mutation);
  const account = await context.db.collection('accounts').findOne({ provider: 'zitadel', issuer: context.config.zitadelIssuer, userId: new ObjectId(context.userId) });
  if (typeof account?.providerAccountId !== 'string' || !account.providerAccountId) throw new Error('instance_forbidden');
  const identity = { issuer: context.config.zitadelIssuer, subject: account.providerAccountId, projectId: context.config.zitadelProjectId };
  const { getOAuthAccessToken } = await import('../auth/tokens');
  const roles = await getVerifiedRoles(context.db, identity, () => getOAuthAccessToken(context.db, identity.issuer, identity.subject,
    context.config.zitadelClientId, context.config.zitadelSecret, context.config.oauthTokenEncryptionKey));
  if (!roles.includes('librarian-instance-admin')) throw new Error('instance_forbidden');
  return { ...context, identity };
}

type Epochs = { securityEpoch: number; recoveryEpoch: number };
type Admission = InstanceControl['admissions'][number];
type SetupOwnerProof = NonNullable<NonNullable<InstanceControl['candidate']>['ownerProof']>;
type AdmissionContext = { db: Db; instanceId: string; pin: Admission };
const admissionContext = new AsyncLocalStorage<AdmissionContext>();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const setupCandidateFlow = z.strictObject({ instanceId: z.uuid(), setupEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  recoveryEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), securityEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  candidateVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), setupSessionHash: hash, expiresAt: z.coerce.date(), ownerBindingId: z.uuid().optional(), recovery: z.literal(true).optional() });
export type SetupCandidateFlow = z.infer<typeof setupCandidateFlow>;

export const InstanceSetupSessionSchema = z.strictObject({
  _id: hash, instanceId: z.uuid(), setupEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), recoveryEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  createdAt: z.date(), expiresAt: z.date(), purgeAt: z.date(), csrfHash: hash, candidateVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  lastNonceHash: hash.nullable(), purpose: z.enum(['bootstrap', 'legacy_enrollment', 'recovery']),
}).superRefine((value, context) => {
  if (value.expiresAt <= value.createdAt || value.expiresAt.getTime() - value.createdAt.getTime() > LIMITS.instanceSetupSessionMs ||
      value.purgeAt.getTime() !== value.expiresAt.getTime() + LIMITS.instanceSetupPurgeMs) context.addIssue({ code: 'custom', message: 'Invalid setup session' });
});
export type InstanceSetupSession = z.infer<typeof InstanceSetupSessionSchema>;

export function verifyInstanceAuthority(control: InstanceControl, identity: RoleIdentity, roles: string[], epochs: Epochs) {
  const binding = control.administrators.find(item => item.status === 'active' && item.issuer === identity.issuer && item.subject === identity.subject && item.projectId === identity.projectId);
  if (control.lifecycle !== 'ready' || control.gate.state !== 'open' || !control.active ||
      identity.issuer !== control.active.zitadel.issuer || identity.projectId !== control.active.zitadel.projectId ||
      !binding || !roles.includes('librarian-instance-admin') || control.securityEpoch !== epochs.securityEpoch || control.recoveryEpoch !== epochs.recoveryEpoch) throw new Error('instance_forbidden');
  return binding;
}

/** Identity/epochs come from the authenticated server session, never request JSON. */
export async function requireInstanceAuthority(options: { db: Db; instanceId: string; identity: RoleIdentity; epochs: Epochs; accessToken: () => Promise<string>; fetcher?: typeof fetch; now?: () => number }) {
  let control = await readInstance(options.db, options.instanceId);
  if (!control) throw new Error('instance_unavailable');
  // Reject wrong bindings before contacting any provider.
  verifyInstanceAuthority(control, options.identity, ['librarian-instance-admin'], options.epochs);
  let roles: string[];
  try { roles = await getVerifiedRoles(options.db, options.identity, options.accessToken, options.fetcher, options.now); }
  catch { throw new Error('instance_unavailable'); }
  control = await readInstance(options.db, options.instanceId);
  if (!control) throw new Error('instance_unavailable');
  return verifyInstanceAuthority(control, options.identity, roles, options.epochs);
}

export function instanceCsrfToken(secret: string, session: string) {
  return createHmac('sha256', secret).update(`librarian-instance\0${session}`).digest('base64url');
}

export function issueSetupOwnerProof(control: InstanceControl, identity: RoleIdentity, now = new Date()): SetupOwnerProof {
  const candidate = control.candidate;
  if (!candidate || !Number.isFinite(now.getTime()) || now < candidate.createdAt || !['configuring', 'awaiting_owner', 'ready', 'maintenance'].includes(control.lifecycle) ||
      identity.issuer !== candidate.zitadel.issuer || identity.projectId !== candidate.zitadel.projectId || !identity.subject) throw new Error('instance_forbidden');
  return { instanceId: control.instanceId, candidateVersion: candidate.version, issuer: identity.issuer, subject: identity.subject,
    projectId: identity.projectId, securityEpoch: control.securityEpoch, nonce: randomUUID(), expiresAt: new Date(now.getTime() + LIMITS.instanceProofMs) };
}

export function verifySetupOwnerProof(control: InstanceControl, identity: RoleIdentity, now = new Date()) {
  const candidate = control.candidate;
  const proof = candidate?.ownerProof;
  return !!candidate && !!proof && Number.isFinite(now.getTime()) && control.lifecycle === 'awaiting_owner' &&
    proof.instanceId === control.instanceId && proof.candidateVersion === candidate.version && proof.issuer === identity.issuer &&
    proof.issuer === candidate.zitadel.issuer && proof.subject === identity.subject && proof.projectId === identity.projectId &&
    proof.projectId === candidate.zitadel.projectId && proof.securityEpoch === control.securityEpoch && proof.expiresAt > now;
}

export function issueSetupCandidateFlow(secret: string, control: InstanceControl, setupToken: string, now = new Date(), ownerBindingId?: string, recovery = false) {
  const tokenBytes = Buffer.from(setupToken, 'base64url');
  const candidate = control.candidate;
  if (secret.length < 32 || !Number.isFinite(now.getTime()) || now < control.createdAt || !candidate ||
      (recovery ? control.lifecycle !== 'maintenance' || !control.initializedAt || !control.bootstrap.consumedAt || now >= control.bootstrap.expiresAt
        : ownerBindingId ? control.lifecycle !== 'ready' || control.gate.state !== 'open' || !control.administrators.some(item => item.bindingId === ownerBindingId && item.kind === 'owner' && item.status === 'active')
        : !['configuring', 'awaiting_owner'].includes(control.lifecycle) || control.bootstrap.consumedAt || now >= control.bootstrap.expiresAt) ||
      tokenBytes.length !== 32 || tokenBytes.toString('base64url') !== setupToken) throw new Error('instance_forbidden');
  const flow = setupCandidateFlow.parse({ instanceId: control.instanceId, setupEpoch: control.bootstrap.epoch, recoveryEpoch: control.recoveryEpoch,
    securityEpoch: control.securityEpoch, candidateVersion: candidate.version, setupSessionHash: createHash('sha256').update(setupToken).digest('hex'),
    expiresAt: new Date(Math.min(now.getTime() + LIMITS.instanceProofMs, ownerBindingId ? Infinity : control.bootstrap.expiresAt.getTime())), ...(ownerBindingId ? { ownerBindingId } : {}), ...(recovery ? { recovery: true } : {}) });
  const payload = Buffer.from(JSON.stringify(flow)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`librarian-instance-candidate-flow\0${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySetupCandidateFlow(secret: string, token: string, control: InstanceControl, setupToken: string, now = new Date()): SetupCandidateFlow | null {
  if (secret.length < 32 || token.length > 1024 || !Number.isFinite(now.getTime())) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const supplied = Buffer.from(signature, 'base64url');
  const expected = createHmac('sha256', secret).update(`librarian-instance-candidate-flow\0${payload}`).digest();
  const encoded = Buffer.from(payload, 'base64url');
  if (supplied.length !== expected.length || supplied.toString('base64url') !== signature || !timingSafeEqual(supplied, expected) ||
      encoded.toString('base64url') !== payload) return null;
  let raw: unknown;
  try { raw = JSON.parse(encoded.toString('utf8')); } catch { return null; }
  const parsed = setupCandidateFlow.safeParse(raw);
  const flow = parsed.success ? parsed.data : null;
  const tokenBytes = Buffer.from(setupToken, 'base64url');
  const candidate = control.candidate;
  if (!flow || tokenBytes.length !== 32 || tokenBytes.toString('base64url') !== setupToken || !candidate ||
      (flow?.recovery ? control.lifecycle !== 'maintenance' || !control.initializedAt || !control.bootstrap.consumedAt || now >= control.bootstrap.expiresAt
        : flow?.ownerBindingId ? control.lifecycle !== 'ready' || control.gate.state !== 'open' || !control.administrators.some(item => item.bindingId === flow.ownerBindingId && item.kind === 'owner' && item.status === 'active')
        : !['configuring', 'awaiting_owner'].includes(control.lifecycle) || control.bootstrap.consumedAt || now >= control.bootstrap.expiresAt) ||
      flow.instanceId !== control.instanceId || flow.setupEpoch !== control.bootstrap.epoch || flow.recoveryEpoch !== control.recoveryEpoch ||
      flow.securityEpoch !== control.securityEpoch || flow.candidateVersion !== candidate.version || flow.expiresAt <= now ||
      (!flow.ownerBindingId && flow.expiresAt > control.bootstrap.expiresAt) || flow.setupSessionHash !== createHash('sha256').update(setupToken).digest('hex')) return null;
  return flow;
}

export function verifyInstanceMutation(request: Request, origin: string, token: string) {
  if (request.headers.get('origin') !== origin) throw new Error('instance_origin');
  const supplied = Buffer.from(request.headers.get('x-csrf-token') ?? '');
  const expected = Buffer.from(token);
  if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('instance_csrf');
}

export const instancePreSessionCsrfCookie = '__Host-librarian_pre_csrf';

export function verifyInstancePreSessionMutation(request: Request, origin: string) {
  if (request.headers.get('origin') !== origin) throw new Error('instance_origin');
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${instancePreSessionCsrfCookie}=`))?.slice(instancePreSessionCsrfCookie.length + 1) ?? '';
  const supplied = request.headers.get('x-csrf-token') ?? '';
  const valid = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
  if (!valid(cookie) || !valid(supplied) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(supplied))) throw new Error('instance_csrf');
}

export async function acquireInstanceAdmission(db: Db, instanceId: string, purpose: Admission['purpose'], now = new Date()): Promise<Admission> {
  if (!['request', 'worker'].includes(purpose) || !Number.isFinite(now.getTime())) throw new Error('instance_invalid');
  const current = await readInstance(db, instanceId);
  const migrating = !!current?.migration && !current.initializedAt && ['legacy_migrating', 'configuring', 'awaiting_owner'].includes(current.lifecycle);
  if (!current || (!migrating && (!current.active || current.lifecycle !== 'ready')) || current.gate.state !== 'open') throw new Error('instance_busy');
  if (now < current.createdAt) throw new Error('instance_invalid');
  const pin: Admission = { id: randomUUID(), bundleVersion: current.active?.version ?? 0, securityEpoch: current.securityEpoch, recoveryEpoch: current.recoveryEpoch, purpose, createdAt: now,
    expiresAt: new Date(now.getTime() + (purpose === 'request' ? LIMITS.instanceRequestPinMs : LIMITS.instanceWorkerPinMs)) };
  const live = { $filter: { input: '$admissions', as: 'pin', cond: { $gt: ['$$pin.expiresAt', now] } } };
  const matching = { $filter: { input: live, as: 'pin', cond: { $eq: ['$$pin.purpose', purpose] } } };
  const result = await db.collection<InstanceControl>('instance_configuration').updateOne({
    _id: 'instance', instanceId, schemaVersion: 2, lifecycle: current.lifecycle, 'gate.state': 'open', securityEpoch: current.securityEpoch,
    recoveryEpoch: current.recoveryEpoch, 'active.version': current.active?.version ?? null,
    $expr: { $and: [{ $lt: [{ $size: matching }, purpose === 'request' ? LIMITS.maxInstanceRequestPins : 1] }, { $lt: ['$revision', Number.MAX_SAFE_INTEGER] }] },
  }, [{ $set: { admissions: { $concatArrays: [live, [{ $literal: pin }]] }, revision: { $add: ['$revision', 1] }, updatedAt: { $max: ['$updatedAt', { $literal: now }] } } }], { writeConcern: { w: 1, j: true } });
  if (result.matchedCount !== 1) throw new Error('instance_busy');
  return pin;
}

export async function verifyInstanceAdmission(db: Db, instanceId: string, pin: Admission, now = new Date()) {
  const current = await readInstance(db, instanceId);
  const actual = current?.admissions.find(item => item.id === pin.id);
  const migrating = !!current?.migration && !current.initializedAt && ['legacy_migrating', 'configuring', 'awaiting_owner'].includes(current.lifecycle);
  if (!current || (!migrating && (!current.active || current.lifecycle !== 'ready')) || current.gate.state === 'maintenance' || !actual || actual.expiresAt <= now || actual.createdAt > now ||
      actual.purpose !== pin.purpose || actual.createdAt.getTime() !== pin.createdAt.getTime() || actual.expiresAt.getTime() !== pin.expiresAt.getTime() ||
      actual.bundleVersion !== (current.active?.version ?? 0) || actual.securityEpoch !== current.securityEpoch ||
      actual.recoveryEpoch !== current.recoveryEpoch || actual.recoveryEpoch !== pin.recoveryEpoch || actual.bundleVersion !== pin.bundleVersion || actual.securityEpoch !== pin.securityEpoch) throw new Error('instance_admission_expired');
}

export async function withInstanceAdmission<T>(db: Db, instanceId: string, purpose: Admission['purpose'], operation: (pin: Admission) => Promise<T> | T): Promise<T> {
  const parent = admissionContext.getStore();
  if (parent) {
    if (parent.db !== db || parent.instanceId !== instanceId || parent.pin.purpose !== purpose) throw new Error('instance_busy');
    await verifyInstanceAdmission(db, instanceId, parent.pin);
    return operation(parent.pin);
  }
  const pin = await acquireInstanceAdmission(db, instanceId, purpose);
  return admissionContext.run({ db, instanceId, pin }, async () => {
    try {
      await verifyInstanceAdmission(db, instanceId, pin);
      const result = await operation(pin);
      await verifyInstanceAdmission(db, instanceId, pin);
      return result;
    } finally { await releaseInstanceAdmission(db, instanceId, pin.id); }
  });
}

export async function runInstanceEffect<T>(effect: () => Promise<T> | T): Promise<T> {
  const current = admissionContext.getStore();
  if (!current) throw new Error('instance_admission_expired');
  await verifyInstanceAdmission(current.db, current.instanceId, current.pin);
  return effect();
}

export async function withRuntimeInstanceAdmission<T>(db: Db, purpose: Admission['purpose'], operation: () => Promise<T>): Promise<T> {
  if (!process.env.INSTANCE_ID && !process.env.INSTANCE_STATE_FILE) return operation();
  const host = await (await import('./bootstrap')).readInstanceHost();
  const current = await readInstance(db, host.instanceId);
  if (!current) {
    await (await import('../config')).loadConfig();
    return operation();
  }
  return withInstanceAdmission(db, host.instanceId, purpose, operation);
}

export async function assertRuntimeInstanceEffect() {
  if (process.env.INSTANCE_ID || process.env.INSTANCE_STATE_FILE) await runInstanceEffect(() => undefined);
}

export async function instanceCatalogAuthority() {
  if (!process.env.INSTANCE_ID && !process.env.INSTANCE_STATE_FILE) return {};
  await assertRuntimeInstanceEffect();
  return { instanceRuntimeRevision: admissionContext.getStore()!.pin.bundleVersion, instanceActivationId: null };
}

export async function withInstanceProviderCheck<T>(db: Db, instanceId: string, operation: () => Promise<T>) {
  const leases = db.collection<{ _id: string; owner: string; expiresAt: Date }>('instance_check_leases');
  const owner = randomUUID();
  const now = new Date();
  try {
    const result = await leases.updateOne({ _id: instanceId, expiresAt: { $lte: now } },
      { $set: { owner, expiresAt: new Date(now.getTime() + 30_000) } }, { upsert: true, writeConcern: { w: 1, j: true } });
    if (!result.matchedCount && !result.upsertedCount) throw new Error('instance_busy');
  } catch { throw new Error('instance_busy'); }
  try { return await operation(); }
  finally { await leases.deleteOne({ _id: instanceId, owner }); }
}

export async function releaseInstanceAdmission(db: Db, instanceId: string, id: string) {
  await db.collection<InstanceControl>('instance_configuration').updateOne({ _id: 'instance', instanceId, 'admissions.id': id, revision: { $lt: Number.MAX_SAFE_INTEGER } },
    { $pull: { admissions: { id } }, $inc: { revision: 1 } }, { writeConcern: { w: 1, j: true } });
}

const errors: Record<string, { status: number; code: string; message: string; retryAfter?: number }> = {
  instance_unauthorized: { status: 401, code: 'authentication_required', message: 'Sign in to continue.' },
  instance_setup_unauthorized: { status: 401, code: 'setup_unauthorized', message: 'The setup credential or session is invalid.' },
  instance_forbidden: { status: 403, code: 'instance_forbidden', message: 'Instance administrator access is required.' },
  instance_origin: { status: 403, code: 'origin_rejected', message: 'The request origin is not allowed.' },
  instance_csrf: { status: 403, code: 'csrf_rejected', message: 'The request could not be verified.' },
  instance_invalid: { status: 400, code: 'invalid_request', message: 'The request is invalid.' },
  instance_secret_invalid: { status: 400, code: 'invalid_secret', message: 'The replacement credential is invalid.' },
  instance_provider_url_invalid: { status: 400, code: 'invalid_provider_url', message: 'The provider address is invalid.' },
  instance_request_too_large: { status: 413, code: 'request_too_large', message: 'The request is too large.' },
  instance_busy: { status: 409, code: 'invalid_transition', message: 'The instance is busy. Try again shortly.' },
  instance_conflict: { status: 409, code: 'revision_conflict', message: 'The configuration changed. Refresh and try again.' },
  instance_admission_expired: { status: 409, code: 'invalid_transition', message: 'The operation expired. Try again.' },
  instance_setup_closed: { status: 409, code: 'setup_closed', message: 'Setup has already been completed.' },
  instance_setup_incomplete: { status: 409, code: 'setup_incomplete', message: 'Current provider checks and owner verification are required.' },
  instance_migration_conflict: { status: 409, code: 'migration_conflict', message: 'The legacy configuration changed. Review it and try again.' },
  instance_owner_continuity_required: { status: 409, code: 'owner_continuity_required', message: 'Current owner confirmation is required.' },
  instance_database_mismatch: { status: 409, code: 'database_mismatch', message: 'This connection must reach the current instance database and its latest revision. Data migration to another database is a separate operation.' },
  instance_database_not_empty: { status: 409, code: 'database_not_empty', message: 'Initial setup requires an empty database. Existing data has been retained.' },
  instance_host_unavailable: { status: 503, code: 'configuration_unavailable', message: 'Host configuration is temporarily unavailable.' },
  instance_operator_required: { status: 409, code: 'operator_required', message: 'A host operator must prepare the requested origin and verify both callbacks before activation.' },
  instance_unavailable: { status: 503, code: 'storage_unavailable', message: 'Instance configuration is temporarily unavailable.' },
  instance_rate_limited: { status: 429, code: 'rate_limited', message: 'Too many requests. Try again shortly.', retryAfter: 60 },
} as const;
export function instanceErrorResponse(error: unknown) {
  const mapped = error instanceof Error && Object.hasOwn(errors, error.message) ? errors[error.message] : errors.instance_unavailable;
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (mapped.retryAfter) headers.set('Retry-After', String(mapped.retryAfter));
  return Response.json({ error: { code: mapped.code, message: mapped.message }, requestId: randomUUID() }, { status: mapped.status, headers });
}

export async function readInstanceJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) throw new Error('instance_invalid');
  const length = request.headers.get('content-length');
  if (length && !/^\d+$/.test(length)) throw new Error('instance_invalid');
  if (length && Number(length) > LIMITS.maxInstanceJsonBytes) throw new Error('instance_request_too_large');
  if (!request.body) throw new Error('instance_invalid');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.maxInstanceJsonBytes) throw new Error('instance_request_too_large');
      chunks.push(value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const value: unknown = JSON.parse(text);
    // The installed parser rejects duplicate JSON object keys, which JSON.parse discards.
    if (parseDocument(text, { uniqueKeys: true }).errors.length) throw new Error('instance_invalid');
    return value;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof Error && error.message === 'instance_request_too_large') throw error;
    throw new Error('instance_invalid');
  }
  finally { reader.releaseLock(); }
}

export async function consumeInstanceRate(db: Db, instanceId: string, actor: string, kind: 'mutation' | 'check' | 'setup_check' | 'webhook' | 'bootstrap', now = new Date()) {
  if (!Number.isFinite(now.getTime()) || !['mutation', 'check', 'setup_check', 'webhook', 'bootstrap'].includes(kind) || !/^[a-f0-9-]{36}$/.test(instanceId) || (kind !== 'bootstrap' && !/^[a-f0-9-]{36}$/.test(actor))) throw new Error('instance_invalid');
  const rules = kind === 'bootstrap'
    ? [[60_000, LIMITS.instanceGuessesPerMinute], [86_400_000, LIMITS.instanceGuessesPerDay]]
    : [[60_000, kind === 'setup_check' ? LIMITS.instanceSetupChecksPerMinute
      : kind === 'check' || kind === 'webhook' ? LIMITS.instanceChecksPerMinute : LIMITS.instanceMutationsPerMinute]];
  const records = db.collection<{ _id: string; hits: number; expiresAt: Date }>('instance_rate_buckets');
  try { await records.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); }
  catch { throw new Error('instance_unavailable'); }
  for (const [interval, limit] of rules) {
    const bucket = Math.floor(now.getTime() / interval);
    const _id = createHash('sha256').update(JSON.stringify([instanceId, kind === 'bootstrap' ? 'instance' : actor, kind, interval, bucket])).digest('hex');
    let result;
    try { result = await records.updateOne({ _id, hits: { $lt: limit } }, { $inc: { hits: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 1) * interval + LIMITS.instanceRateBucketRetentionMs) } }, { upsert: true, writeConcern: { w: 1, j: true } }); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) throw new Error('instance_rate_limited');
      throw new Error('instance_unavailable');
    }
    if (!result.matchedCount && !result.upsertedCount) throw new Error('instance_rate_limited');
  }
}

export async function authorizeInstanceSetup(db: Db, instanceId: string, credential: string, now = new Date(), purpose: 'bootstrap' | 'legacy_enrollment' | 'recovery' = 'bootstrap') {
  if (!Number.isFinite(now.getTime())) throw new Error('instance_invalid');
  const control = await readInstance(db, instanceId);
  if (!control) throw new Error('instance_setup_unauthorized');
  const recovery = purpose === 'recovery' && control.lifecycle === 'maintenance' && !!control.initializedAt && !!control.bootstrap.consumedAt && control.gate.state === 'maintenance';
  if (!recovery && control.bootstrap.consumedAt) throw new Error('instance_setup_closed');
  const enrollment = purpose === 'legacy_enrollment' && control.lifecycle === 'legacy_migrating' && !control.initializedAt && control.migration?.verificationSummary.includes('legacy_drained');
  if (!verifyBootstrapCredential(recovery ? { ...control, lifecycle: 'configuring', bootstrap: { ...control.bootstrap, consumedAt: null } }
    : enrollment ? { ...control, lifecycle: 'configuring' } : control, credential, now)) {
    await consumeInstanceRate(db, instanceId, 'bootstrap', 'bootstrap', now);
    throw new Error('instance_setup_unauthorized');
  }
  if (control.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox) throw new Error('instance_unavailable');

  const sessions = db.collection<InstanceSetupSession>('instance_setup_sessions');
  try {
    await sessions.createIndex({ instanceId: 1, expiresAt: 1 });
    await sessions.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  } catch { throw new Error('instance_unavailable'); }

  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Math.min(now.getTime() + LIMITS.instanceSetupSessionMs, control.bootstrap.expiresAt.getTime()));
  const session = InstanceSetupSessionSchema.parse({
    _id: tokenHash, instanceId, setupEpoch: control.bootstrap.epoch, recoveryEpoch: control.recoveryEpoch,
    createdAt: now, expiresAt, purgeAt: new Date(expiresAt.getTime() + LIMITS.instanceSetupPurgeMs),
    csrfHash: createHash('sha256').update(csrfToken).digest('hex'), candidateVersion: control.candidate?.version ?? 0, lastNonceHash: null, purpose,
  });
  const liveSlots = { $filter: { input: '$bootstrap.sessionSlots', as: 'slot', cond: { $gt: ['$$slot.expiresAt', now] } } };
  const reserved = await db.collection<InstanceControl>('instance_configuration').updateOne({
    _id: 'instance', instanceId, schemaVersion: 2, lifecycle: { $in: recovery ? ['maintenance'] : enrollment ? ['legacy_migrating'] : ['configuring', 'awaiting_owner'] },
    'bootstrap.epoch': control.bootstrap.epoch, 'bootstrap.verifierHash': control.bootstrap.verifierHash,
    'bootstrap.consumedAt': recovery ? control.bootstrap.consumedAt : null, 'bootstrap.expiresAt': { $gt: now },
    $expr: { $and: [{ $lt: [{ $size: liveSlots }, LIMITS.maxInstanceSetupSessions] }, { $lt: [{ $size: '$auditOutbox' }, LIMITS.maxInstanceAuditOutbox] },
      { $lt: ['$revision', Number.MAX_SAFE_INTEGER] }] },
  }, [{ $set: {
    'bootstrap.sessionSlots': { $concatArrays: [liveSlots, [{ $literal: { id: tokenHash, expiresAt } }]] },
    revision: { $add: ['$revision', 1] }, updatedAt: { $max: ['$updatedAt', { $literal: now }] },
  } }], { writeConcern: { w: 1, j: true } });
  if (reserved.matchedCount !== 1) {
    const latest = await readInstance(db, instanceId);
    if (latest && latest.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox) throw new Error('instance_unavailable');
    if (!latest || !recovery && (latest.lifecycle === 'ready' || latest.bootstrap.consumedAt)) throw new Error('instance_setup_closed');
    if (latest.bootstrap.sessionSlots.filter(slot => slot.expiresAt > now).length >= LIMITS.maxInstanceSetupSessions) throw new Error('instance_rate_limited');
    throw new Error('instance_busy');
  }
  try { await sessions.insertOne(session, { writeConcern: { w: 1, j: true } }); }
  catch {
    await db.collection<InstanceControl>('instance_configuration').updateOne({ _id: 'instance', instanceId, 'bootstrap.sessionSlots.id': tokenHash, revision: { $lt: Number.MAX_SAFE_INTEGER } },
      { $pull: { 'bootstrap.sessionSlots': { id: tokenHash } }, $inc: { revision: 1 }, $max: { updatedAt: now } }, { writeConcern: { w: 1, j: true } }).catch(() => undefined);
    throw new Error('instance_unavailable');
  }
  return { token, csrfToken, expiresAt };
}

export async function readInstanceSetupSession(db: Db, instanceId: string, token: string, csrfToken?: string, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('instance_invalid');
  const control = await readInstance(db, instanceId);
  if (!control) throw new Error('instance_setup_unauthorized');
  if (control.lifecycle === 'ready') throw new Error('instance_setup_closed');
  if (!['configuring', 'awaiting_owner', 'legacy_migrating', 'maintenance'].includes(control.lifecycle) || now >= control.bootstrap.expiresAt) throw new Error('instance_setup_unauthorized');
  const tokenBytes = Buffer.from(token, 'base64url');
  if (tokenBytes.length < 32 || tokenBytes.toString('base64url') !== token) throw new Error('instance_setup_unauthorized');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const stored = await db.collection<InstanceSetupSession>('instance_setup_sessions').findOne({ _id: tokenHash, instanceId });
  if (!stored) throw new Error('instance_setup_unauthorized');
  const parsed = InstanceSetupSessionSchema.safeParse(stored);
  if (!parsed.success) throw new Error('instance_unavailable');
  const session = parsed.data;
  const recovery = session.purpose === 'recovery' && control.lifecycle === 'maintenance' && control.initializedAt && control.bootstrap.consumedAt && control.gate.state === 'maintenance';
  if (!recovery && control.bootstrap.consumedAt) throw new Error('instance_setup_closed');
  if (session.createdAt > now || session.expiresAt <= now || session.setupEpoch !== control.bootstrap.epoch || session.recoveryEpoch !== control.recoveryEpoch ||
      (!recovery && session.purpose !== 'bootstrap' && !(session.purpose === 'legacy_enrollment' && control.migration && !control.initializedAt)) ||
      (control.lifecycle === 'legacy_migrating' && session.purpose !== 'legacy_enrollment')) throw new Error('instance_setup_unauthorized');
  if (csrfToken !== undefined) {
    const csrfBytes = Buffer.from(csrfToken, 'base64url');
    if (csrfBytes.length < 32 || csrfBytes.toString('base64url') !== csrfToken ||
        !timingSafeEqual(Buffer.from(session.csrfHash, 'hex'), createHash('sha256').update(csrfToken).digest())) throw new Error('instance_csrf');
  }
  return { instanceId: session.instanceId, setupEpoch: session.setupEpoch, recoveryEpoch: session.recoveryEpoch, createdAt: session.createdAt,
    expiresAt: session.expiresAt, purgeAt: session.purgeAt, candidateVersion: session.candidateVersion, purpose: session.purpose };
}
