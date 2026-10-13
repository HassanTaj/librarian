import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { MongoServerError, type Db, type IndexDescription } from 'mongodb';
import { LIMITS } from './limits';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const uuid = z.uuidv4();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const controls = /\p{Cc}/u;
const display = (max: number, required = false) => z.string().transform(value => value.replace(/\p{Cc}/gu, ''))
  .refine(value => [...value].length <= max && (!required || value.trim().length > 0));
const role = z.string().refine(value => value.length > 0 && [...value].length <= 200 && !controls.test(value));
const approval = z.string().min(1).max(200).regex(/^[\w.:-]+$/).nullable();
const reservedSlugs = new Set(['admin', 'api', 'auth', 'health', 'repositories']);
export function isCatalogSlug(value: string) {
  return /^[a-z][a-z0-9-]{0,62}$/.test(value) && !reservedSlugs.has(value);
}
const slug = z.string().refine(isCatalogSlug);
const branch = z.string().min(1).refine(value => !/[\x00-\x20\x7f~^:?*[\\]/.test(value) &&
  !value.includes('..') && !value.includes('@{') && !value.startsWith('-') && value !== '@' &&
  value.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')));
const docsPath = z.string().refine(value => value.length > 0 && Buffer.byteLength(value) <= LIMITS.maxPathBytes &&
  value.split('/').length <= LIMITS.maxPathSegments && !controls.test(value) && !value.includes('\\') &&
  !posix.isAbsolute(value) && posix.normalize(value) === value && !value.split('/').includes('..'));
const github = z.object({ repositoryId: positive, installationId: positive,
  owner: z.string().min(1).regex(/^[A-Za-z0-9-]+$/), name: z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/).refine(value => value !== '.' && value !== '..'),
  branch, docsPath,
}).strict();
const configShape = { github, slug, title: display(120, true), publicDescription: display(500),
  visibility: z.enum(['public', 'private']), readerRole: role, enabled: z.boolean(), approvalRef: approval };
export const CatalogDefinitionSchema = z.object({ ...configShape,
  publicDescription: display(500).default(''), visibility: z.enum(['public', 'private']).default('private'),
  readerRole: role.optional(), enabled: z.boolean().default(true), approvalRef: approval.default(null),
}).strict();
const changesSchema = z.object(configShape).partial().strict();
const jobId = z.string().max(200).regex(/^(?:manual:[a-f0-9-]{36}:[a-f0-9-]{36}|github:[1-9]\d{0,15}:[a-f0-9-]{36}:[a-f0-9-]{36})$/);
const publication = z.object({ generationId: uuid, commitSha: sha, jobId, fence: positive,
  configRevision: positive, manifestDigest: z.string().regex(/^[a-f0-9]{64}$/), publishedAt: z.date() }).strict();
const lease = z.object({ owner: uuid, fence: positive, expiresAt: z.date(), heartbeatAt: z.date() }).strict()
  .refine(value => value.expiresAt > value.heartbeatAt);
const status = { at: z.date(), jobId };
export const CatalogSchema = z.object({ _id: uuid, ...configShape,
  accessState: z.enum(['unverified', 'ready', 'blocked']), configRevision: positive, authEpoch: positive,
  published: publication.nullable(), publicationRevision: integer,
  retained: z.array(publication.extend({ retiredAt: z.date() })).max(LIMITS.maxRetainedGenerations), lease: lease.nullable(), leaseFence: integer,
  readPins: z.array(z.object({ requestId: uuid, generationId: uuid, expiresAt: z.date() }).strict()).max(LIMITS.maxReadPins),
  admissionReservations: integer.max(LIMITS.maxAdmissionReservations),
  rateWindow: z.object({ window: z.date(), count: integer.max(LIMITS.admissionRate) }).strict(),
  lastSuccess: z.object({ ...status, commitSha: sha }).strict().nullable(),
  lastFailure: z.object({ ...status, code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict().nullable(),
  createdAt: z.date(), updatedAt: z.date(),
}).strict().superRefine((value, context) => {
  const generations = [value.published, ...value.retained].filter(pointer => pointer !== null);
  if (value.updatedAt < value.createdAt || (value.visibility === 'private' && value.approvalRef !== null) ||
      (value.visibility === 'public' && value.enabled && value.approvalRef === null) ||
      generations.some(pointer => pointer.configRevision !== value.configRevision || pointer.fence > value.leaseFence) ||
      new Set(generations.map(pointer => pointer.generationId)).size !== generations.length ||
      (value.lease !== null && value.lease.fence !== value.leaseFence)) {
    context.addIssue({ code: 'custom', message: 'Invalid catalog state relationships' });
  }
});
export type Catalog = z.infer<typeof CatalogSchema>;

export const CATALOG_INDEXES: IndexDescription[] = [
  { key: { slug: 1 }, unique: true, name: 'catalog_slug' },
  { key: { 'github.repositoryId': 1, 'github.branch': 1, 'github.docsPath': 1 }, unique: true, name: 'catalog_source' },
  { key: { enabled: 1, accessState: 1 }, name: 'catalog_directory' },
];

export function newCatalogRecord(input: unknown, now = new Date()): Catalog {
  const config = CatalogDefinitionSchema.parse(input);
  return CatalogSchema.parse({ _id: randomUUID(), ...config, readerRole: config.readerRole ?? `docs:${config.slug}:reader`,
    accessState: 'unverified', configRevision: 1, authEpoch: 1, published: null, publicationRevision: 0,
    retained: [], lease: null, leaseFence: 0, readPins: [], admissionReservations: 0,
    rateWindow: { window: now, count: 0 }, lastSuccess: null, lastFailure: null, createdAt: now, updatedAt: now,
  });
}

export function toDirectoryCard(input: unknown) {
  const catalog = CatalogSchema.parse(input);
  if (!catalog.enabled) return null;
  const { _id, slug, title, publicDescription, visibility } = catalog;
  return { id: _id, slug, title, publicDescription, visibility, canOpen: catalog.lastSuccess !== null, url: `/${slug}` };
}

export async function listDirectoryCards(db: Db) {
  const records = await db.collection<Catalog>('catalogs')
    .find({ enabled: true, accessState: 'ready' }).sort({ title: 1 }).limit(LIMITS.maxCatalogs).toArray();
  return records.map(toDirectoryCard).filter((card): card is NonNullable<typeof card> => card !== null);
}

export function applyCatalogChanges(input: unknown, patch: unknown, expectedRevision: number, now = new Date()): Catalog {
  const current = CatalogSchema.parse(input);
  if (current.configRevision !== expectedRevision) throw new Error('catalog_conflict');
  const changes = changesSchema.parse(patch);
  const next = { ...current, ...changes };
  const blockedRecovery = current.accessState === 'blocked' && !current.enabled && next.enabled;
  const incompatible = (Object.keys(current.github) as Array<keyof Catalog['github']>).some(key => next.github[key] !== current.github[key]) ||
    next.slug !== current.slug || next.readerRole !== current.readerRole || next.visibility !== current.visibility ||
    next.approvalRef !== current.approvalRef || blockedRecovery;
  const enablementChanged = next.enabled !== current.enabled;
  if (next.visibility === 'private') next.approvalRef = null;
  if (incompatible) {
    next.configRevision++; next.authEpoch++; next.leaseFence++;
    next.published = null; next.retained = []; next.lease = null; next.accessState = 'unverified';
    next.lastSuccess = null; next.lastFailure = null;
  } else if (enablementChanged) {
    next.authEpoch++; next.leaseFence++; next.lease = null;
  }
  // updatedAt is the storage CAS version for metadata edits that preserve configRevision.
  next.updatedAt = new Date(Math.max(now.getTime(), current.updatedAt.getTime() + 1));
  return CatalogSchema.parse(next);
}

type CatalogQuota = { _id: string; reservations: number };

export async function ensureCatalogStorage(db: Db) {
  await db.collection<Catalog>('catalogs').createIndexes(CATALOG_INDEXES);
  const count = await db.collection('catalogs').countDocuments();
  if (count > LIMITS.maxCatalogs) throw new Error('catalog_quota');
  const quota = db.collection<CatalogQuota>('quotas');
  const existing = await quota.findOne({ _id: 'catalogs' });
  if (existing) {
    integer.max(LIMITS.maxCatalogs).parse(existing.reservations);
    if (existing.reservations < count) throw new Error('catalog_quota');
    return;
  }
  try { await quota.updateOne({ _id: 'catalogs' }, { $setOnInsert: { reservations: count } }, { upsert: true }); }
  catch (error) {
    // Concurrent initialization may win the unique singleton insertion; never reset its counter.
    if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
  }
}

export async function insertCatalog(db: Db, input: unknown, now = new Date()) {
  const catalog = newCatalogRecord(input, now);
  const quota = await db.collection<CatalogQuota>('quotas').findOneAndUpdate({ _id: 'catalogs', reservations: { $gte: 0, $lt: LIMITS.maxCatalogs } }, { $inc: { reservations: 1 } }, { returnDocument: 'after' });
  if (!quota) throw new Error('catalog_quota');
  integer.max(LIMITS.maxCatalogs).parse(quota.reservations);
  // Reservation is never decremented after a failed insert: safe overcount prevents under-admission accounting.
  await db.collection<Catalog>('catalogs').insertOne(catalog);
  return catalog;
}

const accessLoss = z.object({ catalogId: uuid, installationId: positive, repositoryId: positive }).strict();

/** A signed removal event fences readers and workers before its durable receipt is written. */
export async function blockCatalogForAccessLoss(db: Db, inputValue: unknown) {
  const input = accessLoss.parse(inputValue);
  const catalogs = db.collection<Catalog>('catalogs');
  const identity = { _id: input.catalogId, 'github.installationId': input.installationId, 'github.repositoryId': input.repositoryId };
  const current = await catalogs.findOne(identity);
  if (!current) return 'missing' as const;
  const catalog = CatalogSchema.parse(current);
  if (!catalog.enabled && catalog.accessState === 'blocked') return 'already_blocked' as const;
  const blocked = await catalogs.findOneAndUpdate({ ...identity, leaseFence: { $lt: Number.MAX_SAFE_INTEGER },
    authEpoch: { $lt: Number.MAX_SAFE_INTEGER } }, [{ $set: {
    enabled: false, accessState: 'blocked', authEpoch: { $add: ['$authEpoch', 1] },
    leaseFence: { $add: ['$leaseFence', 1] }, lease: null, updatedAt: { $max: ['$updatedAt', '$$NOW'] },
  } }], { returnDocument: 'after', writeConcern: { w: 1, j: true } });
  if (blocked) { CatalogSchema.parse(blocked); return 'blocked' as const; }
  const latest = await catalogs.findOne(identity);
  if (!latest) return 'missing' as const;
  const parsed = CatalogSchema.parse(latest);
  return !parsed.enabled && parsed.accessState === 'blocked' ? 'already_blocked' as const : 'unavailable' as const;
}
