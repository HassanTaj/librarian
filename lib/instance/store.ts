import { BSON, type Db, type MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LIMITS } from '../limits';
import type { InstanceKeyring } from './secrets';
import { InstanceDatabaseSchema } from './database';

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(200).regex(/^[\w.:-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.date();
export const INSTANCE_CHECK_CODES = ['not_run', 'database_ok', 'provider_ok', 'provider_unavailable', 'request_timeout', 'invalid_configuration', 'authentication_failed', 'permission_denied', 'installation_missing', 'delivery_unverified', 'response_invalid', 'rate_limited'] as const;
export const INSTANCE_CHECK_TYPES = ['database', 'zitadel_discovery', 'zitadel_owner_login', 'github_structure', 'github_authentication', 'github_permissions', 'github_installation', 'github_webhook'] as const;
function isOrigin(value: string) {
  try {
    const url = new URL(value);
    return value === url.origin && (url.protocol === 'https:' || (['development', 'test'].includes(process.env.NODE_ENV ?? '') && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }
  catch { return false; }
}
const origin = z.string().refine(isOrigin);
function isWebhookUrl(value: string) {
  try {
    const url = new URL(value);
    return isOrigin(url.origin) && url.href === value && !url.username && !url.password && !url.search && !url.hash && !/[\\\s\p{Cc}]/u.test(value);
  } catch { return false; }
}
const webhookUrl = z.string().max(2048).refine(isWebhookUrl).optional();
const text = (max: number) => z.string().refine(value => [...value].length <= max && !/[\p{Cc}<>]/u.test(value));
const folder = z.string().max(1024).refine(value => Buffer.byteLength(value) <= 1024 && value.split('/').length <= 32 && !/[\\\p{Cc}<>]/u.test(value) && value.split('/').every(segment => !!segment && segment !== '.' && segment !== '..'));
const binary = z.string().min(1).refine(value => Buffer.from(value, 'base64').toString('base64') === value);
const sessionSlot = z.strictObject({ id: hash, expiresAt: date });
export const InstanceEnvelopeSchema = z.strictObject({
  formatVersion: z.literal(1), algorithm: z.literal('aes-256-gcm'), keyId: identifier,
  credentialVersion: z.uuid(), nonce: binary.refine(value => Buffer.from(value, 'base64').length === 12),
  tag: binary.refine(value => Buffer.from(value, 'base64').length === 16), ciphertext: binary.max(24 * 1024), updatedAt: date,
});
export const InstanceBundleEnvelopeSchema = z.strictObject({
  formatVersion: z.literal(2), algorithm: z.literal('aes-256-gcm'), keyId: identifier,
  bundleVersion: counter, nonce: binary.refine(value => Buffer.from(value, 'base64').length === 12),
  tag: binary.refine(value => Buffer.from(value, 'base64').length === 16), ciphertext: binary.max(176 * 1024), updatedAt: date,
});
const binding = z.strictObject({ bindingId: z.uuid(), issuer: origin, subject: z.string().min(1).max(200).refine(value => !/\p{Cc}/u.test(value)), projectId: identifier,
  kind: z.enum(['owner', 'administrator']), status: z.enum(['active', 'retired']), boundAt: date, boundByActionId: z.uuid() });
const proof = z.strictObject({ instanceId: z.uuid(), candidateVersion: counter, issuer: origin, subject: z.string().min(1).max(200), projectId: identifier,
  securityEpoch: counter, nonce: z.uuid(), expiresAt: date });
const check = z.strictObject({ type: z.enum(INSTANCE_CHECK_TYPES),
  candidateVersion: counter, at: date, status: z.enum(['not_run', 'passed', 'failed', 'warning']), code: z.enum(INSTANCE_CHECK_CODES) });
export type InstanceCheck = z.infer<typeof check>;
export const InstanceRuntimeSchema = z.strictObject({
  authSecret: z.string().max(64 * 1024).refine(value => Buffer.byteLength(value) >= 32 && Buffer.byteLength(value) <= 64 * 1024),
  oauthTokenEncryptionKey: z.string().refine(value => Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value),
  mongodbUri: z.string().min(1).max(64 * 1024), mongodbDatabase: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/),
  trustHost: z.boolean(), workerEnabled: z.boolean(),
});
export const InstanceBundleSchema = z.strictObject({
  version: counter, createdAt: date, createdBy: identifier,
  preferences: z.strictObject({ displayName: text(120).refine(value => value.trim().length > 0), description: text(500), docsFolder: folder }),
  publicOrigin: origin,
  runtime: InstanceRuntimeSchema,
  zitadel: z.strictObject({ issuer: origin, clientId: z.string().min(1).max(200).regex(/^[\w.:@-]+$/), projectId: identifier, audience: identifier }),
  github: z.strictObject({ provider: z.literal('github'), appId: z.string().regex(/^[1-9]\d*$/).max(200), webhookUrl }),
  secrets: z.strictObject({ zitadelClientSecret: InstanceEnvelopeSchema, githubPrivateKey: InstanceEnvelopeSchema, githubWebhookSecret: InstanceEnvelopeSchema,
    previousWebhook: z.strictObject({ envelope: InstanceEnvelopeSchema, acceptUntil: date }).nullable() }),
  checks: z.array(check).max(12), ownerProof: proof.nullable(),
  impact: z.strictObject({ categories: z.array(z.enum(['preferences', 'origin', 'identity', 'github', 'webhook', 'database'])).max(6), securityEpochIncrement: z.boolean(), revalidateSources: z.boolean(), confirmationNonce: z.uuid() }).nullable(),
  previousUntil: date.nullable(),
});
export const InstanceCandidateSchema = InstanceBundleSchema.extend({
  runtime: InstanceRuntimeSchema.optional(),
  zitadel: z.strictObject({ issuer: z.string().refine(value => value === '' || isOrigin(value)), clientId: z.string().max(200), projectId: z.string().max(200), audience: z.string().max(200) }),
  github: z.strictObject({ provider: z.literal('github'), appId: z.string().max(200), webhookUrl }),
  secrets: z.strictObject({ zitadelClientSecret: InstanceEnvelopeSchema.nullable(), githubPrivateKey: InstanceEnvelopeSchema.nullable(), githubWebhookSecret: InstanceEnvelopeSchema.nullable(),
    previousWebhook: z.strictObject({ envelope: InstanceEnvelopeSchema, acceptUntil: date }).nullable() }),
});
const pin = z.strictObject({ id: z.uuid(), bundleVersion: counter, securityEpoch: counter, recoveryEpoch: counter, purpose: z.enum(['request', 'worker']), createdAt: date, expiresAt: date });
const audit = z.strictObject({ _id: z.uuid(), instanceId: z.uuid(), at: date, actor: identifier,
  operation: z.enum(['candidate_saved', 'setup_finalized', 'activated', 'rollback', 'owner_enrolled', 'owner_transferred', 'recovered', 'key_rotated']),
  fromVersion: counter.nullable(), toVersion: counter.nullable(), resultCode: identifier, requestId: z.uuid() });
export const InstanceControlSchema = z.strictObject({
  _id: z.literal('instance'), instanceId: z.uuid(), schemaVersion: z.literal(2), revision: counter, editRevision: counter, nextBundleVersion: counter,
  lifecycle: z.enum(['configuring', 'awaiting_owner', 'ready', 'maintenance', 'legacy_migrating']), createdAt: date, updatedAt: date, initializedAt: date.nullable(),
  bootstrap: z.strictObject({ epoch: counter, verifierHash: hash, expiresAt: date, consumedAt: date.nullable(), sessionSlots: z.array(sessionSlot).max(LIMITS.maxInstanceSetupSessions) }),
  securityEpoch: counter, recoveryEpoch: counter,
  active: InstanceBundleSchema.nullable(), previous: InstanceBundleSchema.nullable(), candidate: InstanceCandidateSchema.nullable(),
  administrators: z.array(binding).max(20),
  gate: z.strictObject({ state: z.enum(['open', 'closing', 'maintenance']), activationId: z.uuid().nullable(), deadline: date.nullable() }),
  admissions: z.array(pin).max(65),
  activation: z.strictObject({ id: z.uuid(), from: counter, to: counter, phase: z.enum(['draining', 'fencing', 'committed', 'adopting', 'maintenance']), actor: identifier,
    deadline: date, fencedCatalogIds: z.array(z.uuid()).max(20), result: identifier.nullable() }).nullable(),
  auditOutbox: z.array(audit).max(LIMITS.maxInstanceAuditOutbox),
  migration: z.strictObject({ sourceDigest: hash, mode: z.enum(['import', 'recover']), at: date, verificationSummary: z.array(identifier).max(12) }).nullable(),
}).superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: 'custom', message: 'Invalid instance state' });
  if (value.updatedAt < value.createdAt || value.bootstrap.expiresAt < value.createdAt || (value.initializedAt && (value.initializedAt < value.createdAt || value.initializedAt > value.updatedAt))) invalid();
  if (value.bootstrap.consumedAt && (value.bootstrap.consumedAt < value.createdAt || value.bootstrap.consumedAt > value.updatedAt || value.bootstrap.consumedAt > value.bootstrap.expiresAt)) invalid();
  if (new Set(value.bootstrap.sessionSlots.map(slot => slot.id)).size !== value.bootstrap.sessionSlots.length || value.bootstrap.sessionSlots.some(slot => slot.expiresAt <= value.createdAt || slot.expiresAt > value.bootstrap.expiresAt)) invalid();
  if (value.lifecycle === 'awaiting_owner' && !value.candidate?.ownerProof) invalid();
  const active = value.administrators.filter(item => item.status === 'active');
  if (new Set(active.map(item => JSON.stringify([item.issuer, item.subject, item.projectId]))).size !== active.length) invalid();
  for (const binding of value.administrators) if (binding.boundAt < value.createdAt || binding.boundAt > value.updatedAt) invalid();
  if (value.initializedAt || value.lifecycle === 'ready') {
    if (!value.initializedAt || !value.active || !value.bootstrap.consumedAt || active.filter(item => item.kind === 'owner').length !== 1) invalid();
  }
  for (const bundle of [value.active, value.previous, value.candidate]) {
    if (!bundle) continue;
    if (bundle.version >= value.nextBundleVersion || bundle.createdAt < value.createdAt || bundle.createdAt > value.updatedAt) invalid();
    if (bundle.checks.some(item => item.candidateVersion !== bundle.version || item.at < bundle.createdAt || item.at > value.updatedAt)) invalid();
    if (new Set(bundle.impact?.categories ?? []).size !== (bundle.impact?.categories.length ?? 0)) invalid();
    if (bundle.ownerProof && (bundle.ownerProof.instanceId !== value.instanceId || bundle.ownerProof.candidateVersion !== bundle.version ||
        bundle.ownerProof.issuer !== bundle.zitadel.issuer || bundle.ownerProof.projectId !== bundle.zitadel.projectId || bundle.ownerProof.expiresAt <= bundle.createdAt)) invalid();
  }
    if (value.previous && (!value.previous.previousUntil || value.previous.previousUntil.getTime() > value.updatedAt.getTime() + 24 * 60 * 60_000)) invalid();
  if (!value.previous && [value.active, value.candidate].some(bundle => bundle !== null && bundle.previousUntil !== null)) invalid();
  if (value.gate.state === 'open' && (value.gate.activationId !== null || value.gate.deadline !== null)) invalid();
  if (value.gate.state === 'closing' && (!value.activation || value.gate.activationId !== value.activation.id || value.gate.deadline?.getTime() !== value.activation.deadline.getTime())) invalid();
  if (value.activation && (value.activation.deadline < value.createdAt || value.activation.deadline.getTime() > value.updatedAt.getTime() + LIMITS.instanceActivationMs ||
      value.gate.activationId !== value.activation.id || value.activation.to >= value.nextBundleVersion)) invalid();
  if (value.admissions.filter(item => item.purpose === 'request').length > 64 || value.admissions.filter(item => item.purpose === 'worker').length > 1) invalid();
  if (new Set(value.admissions.map(item => item.id)).size !== value.admissions.length) invalid();
  for (const item of value.admissions) if (item.createdAt < value.createdAt || item.createdAt > value.updatedAt || item.expiresAt <= item.createdAt || item.expiresAt.getTime() - item.createdAt.getTime() > (item.purpose === 'request' ? LIMITS.instanceRequestPinMs : LIMITS.instanceWorkerPinMs)) invalid();
  for (const item of value.auditOutbox) if (item.instanceId !== value.instanceId || item.at < value.createdAt || item.at > value.updatedAt || BSON.calculateObjectSize(item) > 1024) invalid();
  if (value.migration && (value.migration.at < value.createdAt || value.migration.at > value.updatedAt)) invalid();
});
export type InstanceControl = z.infer<typeof InstanceControlSchema>;

const StoredBundleSchema = z.strictObject({ version: counter, configuration: InstanceBundleEnvelopeSchema });
export const StoredInstanceControlSchema = z.strictObject({ ...InstanceControlSchema.shape,
  active: StoredBundleSchema.nullable(), previous: StoredBundleSchema.nullable(), candidate: StoredBundleSchema.nullable() });
type StoredBundle = z.infer<typeof StoredBundleSchema>;
export type StoredInstanceControl = z.infer<typeof StoredInstanceControlSchema>;

const instanceKeyrings = new WeakMap<MongoClient, InstanceKeyring>();

export function attachInstanceKeyring(db: Db, keyring?: InstanceKeyring) {
  if (keyring) instanceKeyrings.set(db.client, keyring);
}

function keyringFor(db: Db) {
  const keyring = instanceKeyrings.get(db.client);
  if (!keyring) throw new Error('instance_unavailable');
  return keyring;
}

export function parseInstanceControl(input: unknown, instanceId: string): InstanceControl {
  const parsed = InstanceControlSchema.safeParse(input);
  if (!parsed.success || parsed.data.instanceId !== instanceId || BSON.calculateObjectSize(parsed.data) > LIMITS.maxInstanceControlBytes) throw new Error('instance_invalid');
  return parsed.data;
}

type PriorControl = { control: InstanceControl; stored: StoredInstanceControl };

export async function serializeInstanceControl(input: unknown, instanceId: string, keyring: InstanceKeyring, prior?: PriorControl): Promise<StoredInstanceControl> {
  const control = parseInstanceControl(input, instanceId);
  const { encryptInstanceBundle } = await import('./secrets');
  const storeBundle = (bundle: InstanceControl['active'] | InstanceControl['candidate'] | InstanceControl['previous'], previous: PriorControl['control']['active'] | PriorControl['control']['candidate'] | PriorControl['control']['previous'], stored: StoredBundle | null): StoredBundle | null => bundle
    ? previous && stored && BSON.EJSON.stringify(bundle) === BSON.EJSON.stringify(previous) ? stored
      : { version: bundle.version, configuration: encryptInstanceBundle(bundle, { instanceId, bundleVersion: bundle.version }, keyring, control.updatedAt) }
    : null;
  const result = StoredInstanceControlSchema.parse({ ...control,
    active: storeBundle(control.active, prior?.control.active ?? null, prior?.stored.active ?? null),
    previous: storeBundle(control.previous, prior?.control.previous ?? null, prior?.stored.previous ?? null),
    candidate: storeBundle(control.candidate, prior?.control.candidate ?? null, prior?.stored.candidate ?? null) });
  if (BSON.calculateObjectSize(result) > LIMITS.maxInstanceControlBytes) throw new Error('instance_invalid');
  return result;
}

async function deserializeInstanceControl(input: unknown, instanceId: string, keyring: InstanceKeyring): Promise<InstanceControl> {
  const stored = StoredInstanceControlSchema.safeParse(input);
  if (!stored.success || stored.data.instanceId !== instanceId || BSON.calculateObjectSize(stored.data) > LIMITS.maxInstanceControlBytes) throw new Error('instance_invalid');
  const { decryptInstanceBundle } = await import('./secrets');
  const load = (bundle: StoredBundle | null) => {
    if (!bundle) return null;
    try {
      const value = decryptInstanceBundle(bundle.configuration, { instanceId, bundleVersion: bundle.version }, keyring);
      if (value.version !== bundle.version) throw new Error();
      return value;
    } catch { throw new Error('instance_unavailable'); }
  };
  return parseInstanceControl({ ...stored.data, active: load(stored.data.active), previous: load(stored.data.previous), candidate: load(stored.data.candidate) }, instanceId);
}

async function loadStoredInstance(db: Db, instanceId: string): Promise<PriorControl | null> {
  const stored = await db.collection<StoredInstanceControl>('instance_configuration').findOne({ _id: 'instance', instanceId });
  if (!stored) {
    if (await db.collection<StoredInstanceControl>('instance_configuration').findOne({ _id: 'instance' })) throw new Error('instance_mismatch');
    return null;
  }
  const control = await deserializeInstanceControl(stored, instanceId, keyringFor(db));
  return { control, stored };
}

export async function initializeInstance(db: Db, input: unknown) {
  const identity = z.uuid().safeParse((input as { instanceId?: unknown })?.instanceId);
  if (!identity.success) throw new Error('instance_invalid');
  const instanceId = identity.data;
  const control = parseInstanceControl(input, instanceId);
  if (control.lifecycle !== 'configuring' || control.revision !== 0 || control.editRevision !== 0 || control.initializedAt !== null || control.active || control.previous || control.administrators.length || control.bootstrap.consumedAt || control.bootstrap.sessionSlots.length) throw new Error('instance_invalid');
  const stored = await serializeInstanceControl(control, instanceId, keyringFor(db));
  await db.collection<StoredInstanceControl>('instance_configuration').insertOne(stored, { writeConcern: { w: 1, j: true } });
  return control;
}

export async function readInstance(db: Db, instanceId: string) {
  if (!z.uuid().safeParse(instanceId).success) throw new Error('instance_invalid');
  return (await loadStoredInstance(db, instanceId))?.control ?? null;
}

export async function updateInstance(db: Db, instanceId: string, revision: number, mutate: (control: InstanceControl) => unknown, now = new Date(), options: { allowFullAuditOutbox?: boolean } = {}) {
  const prior = await loadStoredInstance(db, instanceId);
  const current = prior?.control ?? null;
  if (!current || current.revision !== revision) throw new Error('instance_conflict');
  if (!Number.isFinite(now.getTime()) || now < current.updatedAt) throw new Error('instance_invalid');
  if (current.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox && !options.allowFullAuditOutbox) throw new Error('instance_unavailable');
  const changes = mutate(structuredClone(current));
  if (current.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox && options.allowFullAuditOutbox) {
    const priorIds = new Set(current.auditOutbox.map(event => event._id));
    const events = (changes as Partial<InstanceControl>).auditOutbox ?? current.auditOutbox;
    if (events.some(event => !priorIds.has(event._id))) throw new Error('instance_unavailable');
  }
  const next = parseInstanceControl({ ...(changes as object), _id: 'instance', instanceId, revision: revision + 1, editRevision: current.editRevision + 1, createdAt: current.createdAt, updatedAt: now }, instanceId);
  const priorBindings = new Map(current.administrators.map(item => [item.bindingId, item]));
  for (const prior of priorBindings.values()) {
    const retained = next.administrators.find(item => item.bindingId === prior.bindingId);
    if (!retained || retained.issuer !== prior.issuer || retained.subject !== prior.subject || retained.projectId !== prior.projectId ||
        retained.kind !== prior.kind || retained.boundAt.getTime() !== prior.boundAt.getTime() || retained.boundByActionId !== prior.boundByActionId ||
        (prior.status === 'retired' && retained.status !== 'retired')) throw new Error('instance_invalid');
  }
  if ((current.initializedAt && (next.initializedAt?.getTime() !== current.initializedAt.getTime() || !next.bootstrap.consumedAt || ['configuring', 'awaiting_owner'].includes(next.lifecycle))) ||
      next.securityEpoch < current.securityEpoch || next.recoveryEpoch < current.recoveryEpoch || next.bootstrap.epoch < current.bootstrap.epoch ||
      next.nextBundleVersion < current.nextBundleVersion || (current.bootstrap.consumedAt && (!next.bootstrap.consumedAt || next.bootstrap.consumedAt.getTime() !== current.bootstrap.consumedAt.getTime()))) throw new Error('instance_invalid');
  const stored = await serializeInstanceControl(next, instanceId, keyringFor(db), prior!);
  const result = await db.collection<StoredInstanceControl>('instance_configuration').replaceOne({ _id: 'instance', instanceId, revision }, stored, { writeConcern: { w: 1, j: true } });
  if (result.matchedCount !== 1) throw new Error('instance_conflict');
  return next;
}

export async function recordInstanceCheck(db: Db, instanceId: string, result: InstanceCheck) {
  const parsed = check.parse(result);
  if (parsed.at > new Date()) throw new Error('instance_invalid');
  for (let attempt = 0; attempt < 3; attempt++) {
    const prior = await loadStoredInstance(db, instanceId);
    const current = prior?.control ?? null;
    if (current && current.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox) throw new Error('instance_unavailable');
    const candidate = current?.candidate;
    if (!current || !candidate || !['configuring', 'awaiting_owner', 'ready'].includes(current.lifecycle) || current.gate.state !== 'open' ||
        (current.lifecycle !== 'ready' && current.bootstrap.consumedAt) ||
        result.candidateVersion !== candidate.version || result.at < candidate.createdAt || current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('instance_conflict');
    const existing = candidate.checks.find(item => item.type === result.type);
    if (existing && existing.at > result.at) return current;
    const checks = [...candidate.checks.filter(item => item.type !== result.type), parsed];
    const next = parseInstanceControl({ ...current, revision: current.revision + 1, updatedAt: current.updatedAt > result.at ? current.updatedAt : result.at,
      candidate: { ...candidate, checks } }, instanceId);
    const stored = await serializeInstanceControl(next, instanceId, keyringFor(db), prior!);
    const saved = await db.collection<StoredInstanceControl>('instance_configuration').replaceOne({ _id: 'instance', instanceId, revision: current.revision }, stored,
      { writeConcern: { w: 1, j: true } });
    if (saved.matchedCount === 1) return next;
  }
  throw new Error('instance_conflict');
}

export async function drainInstanceAudit(db: Db, instanceId: string) {
  const current = await readInstance(db, instanceId);
  if (!current) throw new Error('instance_unavailable');
  const events = db.collection<z.infer<typeof audit>>('instance_audit_events');
  const leases = db.collection<{ _id: string; owner: string; expiresAt: Date }>('instance_audit_drain_leases');
  const leaseOwner = randomUUID();
  const now = new Date();
  try {
    const claim = await leases.updateOne({ _id: instanceId, $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }] },
      { $set: { owner: leaseOwner, expiresAt: new Date(now.getTime() + LIMITS.instanceActivationMs) } }, { upsert: true, writeConcern: { w: 1, j: true } });
    if (!claim.matchedCount && !claim.upsertedCount) throw new Error('instance_busy');
  } catch { throw new Error('instance_busy'); }
  try {
    await events.createIndex({ instanceId: 1, at: 1 });
    await events.createIndex({ at: 1 }, { expireAfterSeconds: LIMITS.instanceAuditDays * 24 * 60 * 60 });
    const ids = current.auditOutbox.map(event => event._id);
    const existing = ids.length ? await events.find({ instanceId, _id: { $in: ids } }).project({ _id: 1 }).toArray() : [];
    const missing = current.auditOutbox.length - existing.length;
    const count = await events.countDocuments({ instanceId });
    const trimCount = Math.max(0, count + missing - LIMITS.maxInstanceAuditEvents);
    if (trimCount) {
      const victims = await events.find({ instanceId, _id: { $nin: ids } }).sort({ at: 1, _id: 1 }).limit(trimCount).project({ _id: 1 }).toArray();
      if (victims.length) await events.deleteMany({ instanceId, _id: { $in: victims.map(event => event._id) } });
    }
    for (const event of current.auditOutbox) await events.updateOne({ _id: event._id, instanceId }, { $setOnInsert: event }, { upsert: true, writeConcern: { w: 1, j: true } });
    if (ids.length) {
  const ack = await db.collection<StoredInstanceControl>('instance_configuration').updateOne({ _id: 'instance', instanceId, revision: { $lt: Number.MAX_SAFE_INTEGER } },
        { $pull: { auditOutbox: { _id: { $in: ids } } }, $inc: { revision: 1 } }, { writeConcern: { w: 1, j: true } });
      if (ack.matchedCount !== 1) throw new Error('instance_busy');
    }
  } finally { await leases.deleteOne({ _id: instanceId, owner: leaseOwner }); }
}

export function instanceSnapshot(control: InstanceControl) {
  function bundle(value: InstanceControl['active'] | InstanceControl['candidate']) {
    if (!value) return null;
    const secret = (envelope: NonNullable<typeof value.secrets.zitadelClientSecret> | null) => envelope
      ? { configured: true, updatedAt: envelope.updatedAt } : { configured: false, updatedAt: null };
    return { version: value.version, preferences: value.preferences, publicOrigin: value.publicOrigin, zitadel: value.zitadel, github: value.github,
      checks: value.checks, runtime: value.runtime ? { mongodbDatabase: value.runtime.mongodbDatabase, trustHost: value.runtime.trustHost,
        workerEnabled: value.runtime.workerEnabled, authSecretConfigured: true, oauthTokenEncryptionKeyConfigured: true, mongodbUriConfigured: true } : null, secrets: {
        zitadelClientSecret: secret(value.secrets.zitadelClientSecret),
        githubPrivateKey: secret(value.secrets.githubPrivateKey),
        githubWebhookSecret: secret(value.secrets.githubWebhookSecret),
      } };
  }
  return { state: control.lifecycle, editRevision: control.editRevision, activeVersion: control.active?.version ?? null,
    candidateVersion: control.candidate?.version ?? null, active: bundle(control.active), candidate: bundle(control.candidate) };
}

export async function cleanupInstanceState(db: Db, instanceId: string, now = new Date()) {
  const prior = await loadStoredInstance(db, instanceId);
  const control = prior?.control ?? null;
  if (!control || control.gate.state !== 'open' || control.activation) return;
  const previousExpired = control.previous?.previousUntil !== null && control.previous?.previousUntil !== undefined && control.previous.previousUntil <= now;
  const webhookExpired = control.active?.secrets.previousWebhook && control.active.secrets.previousWebhook.acceptUntil <= now;
  if (!previousExpired && !webhookExpired) return;
  const next = parseInstanceControl({ ...control, revision: control.revision + 1, updatedAt: now,
    previous: previousExpired ? null : control.previous,
    active: webhookExpired ? { ...control.active!, secrets: { ...control.active!.secrets, previousWebhook: null } } : control.active,
  }, instanceId);
  const stored = await serializeInstanceControl(next, instanceId, keyringFor(db), prior!);
  await db.collection<StoredInstanceControl>('instance_configuration').replaceOne({ _id: 'instance', instanceId, revision: control.revision }, stored, { writeConcern: { w: 1, j: true } });
}

function validOrigin(value: string) {
  try {
    const url = new URL(value);
    return value === url.origin && (url.protocol === 'https:' || (['development', 'test'].includes(process.env.NODE_ENV ?? '') && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}
const changesSchema = z.strictObject({
  displayName: text(120).refine(value => value.trim().length > 0).optional(),
  description: text(500).optional(),
  defaultDocsFolder: z.string().max(1024).refine(value => Buffer.byteLength(value) <= 1024 && value.split('/').length <= 32 && !/[\\\p{Cc}<>]/u.test(value) && value.split('/').every(segment => !!segment && segment !== '.' && segment !== '..')).optional(),
  publicOrigin: z.string().refine(validOrigin).optional(),
  zitadel: z.strictObject({
    issuer: z.string().refine(validOrigin).optional(),
    clientId: z.string().min(1).max(200).regex(/^[\w.:@-]+$/).optional(),
    projectId: z.string().min(1).max(200).regex(/^[\w.:-]+$/).optional(),
    apiAudience: z.string().min(1).max(200).regex(/^[\w.:-]+$/).optional(),
  }).partial().optional(),
  database: z.strictObject({ mongodbUri: z.string().min(1).max(16 * 1024).optional(), mongodbDatabase: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/).optional() }).optional(),
  github: z.strictObject({ appId: z.string().regex(/^[1-9]\d*$/).max(200).optional(), webhookUrl }).partial().optional(),
}).refine(value => Object.values(value).every(item => !item || typeof item !== 'object' || Object.keys(item).length > 0));
const replacement = (max: number) => z.strictObject({ action: z.literal('replace'), value: z.string().min(1).max(max) });
export const InstanceDraftPatchSchema = z.strictObject({
  candidateVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  changes: changesSchema,
  secretReplacements: z.strictObject({
    zitadelClientSecret: replacement(LIMITS.maxInstanceClientSecretBytes).optional(),
    githubPrivateKey: replacement(LIMITS.maxInstanceAppKeyBytes).optional(),
    githubWebhookSecret: replacement(LIMITS.maxInstanceWebhookSecretBytes).optional(),
  }).optional(),
}).refine(value => !!value.secretReplacements && Object.values(value.secretReplacements).some(Boolean) || Object.keys(value.changes).length > 0);

type Candidate = NonNullable<InstanceControl['candidate']>;

export function initialInstanceCandidate(control: InstanceControl, setupOrigin: string, now: Date): Candidate {
  return InstanceCandidateSchema.parse({
    version: 0, createdAt: now, createdBy: 'bootstrap',
    preferences: { displayName: 'Librarian', description: '', docsFolder: 'docs' }, publicOrigin: setupOrigin,
    zitadel: { issuer: '', clientId: '', projectId: '', audience: '' }, github: { provider: 'github', appId: '' },
    secrets: { zitadelClientSecret: null, githubPrivateKey: null, githubWebhookSecret: null, previousWebhook: null },
    checks: [], ownerProof: null, impact: null, previousUntil: null,
  });
}


export async function buildInstanceDraft(control: InstanceControl, setupOrigin: string, input: z.infer<typeof InstanceDraftPatchSchema>, keyring: Parameters<typeof import('./secrets').encryptInstanceSecret>[2], actor: string, now = new Date()) {
  const { encryptInstanceSecret } = await import('./secrets');
  const host = { instanceId: control.instanceId, keyring };
      const candidate = control.candidate ? structuredClone(control.candidate) : control.active ? structuredClone(control.active) : initialInstanceCandidate(control, setupOrigin, now);
      const { changes, secretReplacements } = input;
      if (changes.displayName !== undefined) candidate.preferences.displayName = changes.displayName;
      if (changes.description !== undefined) candidate.preferences.description = changes.description;
      if (changes.defaultDocsFolder !== undefined) candidate.preferences.docsFolder = changes.defaultDocsFolder;
      if (changes.publicOrigin !== undefined) candidate.publicOrigin = changes.publicOrigin;
      if (changes.zitadel?.issuer !== undefined) candidate.zitadel.issuer = changes.zitadel.issuer;
      if (changes.zitadel?.clientId !== undefined) candidate.zitadel.clientId = changes.zitadel.clientId;
      if (changes.zitadel?.projectId !== undefined) candidate.zitadel.projectId = changes.zitadel.projectId;
      if (changes.zitadel?.apiAudience !== undefined) candidate.zitadel.audience = changes.zitadel.apiAudience;
      if (changes.database) {
        if (!candidate.runtime) throw new Error('instance_invalid');
        const locator = InstanceDatabaseSchema.safeParse({ mongodbUri: changes.database.mongodbUri ?? candidate.runtime.mongodbUri,
          mongodbDatabase: changes.database.mongodbDatabase ?? candidate.runtime.mongodbDatabase });
        if (!locator.success) throw new Error('instance_invalid');
        Object.assign(candidate.runtime, locator.data);
      }
      if (changes.github?.appId !== undefined) candidate.github.appId = changes.github.appId;
      if (changes.github?.webhookUrl !== undefined) candidate.github.webhookUrl = changes.github.webhookUrl;
      for (const purpose of ['zitadelClientSecret', 'githubPrivateKey', 'githubWebhookSecret'] as const) {
        const replacement = secretReplacements?.[purpose];
        if (replacement) candidate.secrets[purpose] = encryptInstanceSecret(replacement.value, {
          instanceId: host.instanceId, purpose, credentialVersion: randomUUID(),
        }, host.keyring, now);
      }

      const active = control.active;
      const categories = active ? [
        ...(candidate.runtime?.mongodbUri !== active.runtime?.mongodbUri || candidate.runtime?.mongodbDatabase !== active.runtime?.mongodbDatabase ? ['database' as const] : []),
        ...(candidate.preferences.displayName !== active.preferences.displayName || candidate.preferences.description !== active.preferences.description || candidate.preferences.docsFolder !== active.preferences.docsFolder ? ['preferences' as const] : []),
        ...(candidate.publicOrigin !== active.publicOrigin ? ['origin' as const] : []),
        ...(candidate.zitadel.issuer !== active.zitadel.issuer || candidate.zitadel.clientId !== active.zitadel.clientId || candidate.zitadel.projectId !== active.zitadel.projectId || candidate.zitadel.audience !== active.zitadel.audience || candidate.secrets.zitadelClientSecret?.credentialVersion !== active.secrets.zitadelClientSecret.credentialVersion ? ['identity' as const] : []),
        ...(candidate.github.appId !== active.github.appId || candidate.secrets.githubPrivateKey?.credentialVersion !== active.secrets.githubPrivateKey.credentialVersion ? ['github' as const] : []),
        ...(candidate.secrets.githubWebhookSecret?.credentialVersion !== active.secrets.githubWebhookSecret.credentialVersion || (candidate.github.webhookUrl ?? new URL('/api/webhooks/github', candidate.publicOrigin).href) !== (active.github.webhookUrl ?? new URL('/api/webhooks/github', active.publicOrigin).href) ? ['webhook' as const] : []),
      ] : ['preferences', 'origin', 'identity', 'github', 'webhook'] as const;
      candidate.version = control.nextBundleVersion;
      candidate.createdAt = now;
      candidate.createdBy = actor;
      candidate.checks = [];
      candidate.ownerProof = null;
      candidate.previousUntil = null;
      const identityChanged = !active || candidate.publicOrigin !== active.publicOrigin || candidate.zitadel.issuer !== active.zitadel.issuer ||
        candidate.zitadel.clientId !== active.zitadel.clientId || candidate.zitadel.projectId !== active.zitadel.projectId || candidate.zitadel.audience !== active.zitadel.audience;
      if (!active && candidate.publicOrigin !== setupOrigin) throw new Error('instance_invalid');
      candidate.impact = { categories: [...new Set(categories)], securityEpochIncrement: identityChanged,
        revalidateSources: categories.includes('github'), confirmationNonce: randomUUID() };
      const validatedCandidate = InstanceCandidateSchema.parse(candidate);
  return validatedCandidate;
}
