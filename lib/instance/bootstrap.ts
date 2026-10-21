import { z } from 'zod';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadHostConfig } from '../config';
import { LIMITS } from '../limits';
import { parseInstanceControl, type InstanceControl } from './store';

const markerSchema = z.strictObject({ instanceId: z.uuid(), phase: z.enum(['prepared', 'sealed', 'initialized']), recoveryEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
const keyId = z.string().min(1).max(200).regex(/^[\w.:-]+$/);
const keyringSchema = z.strictObject({ activeKeyId: keyId, keys: z.record(keyId, z.string().max(44).refine(value => Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value)),
  rotation: z.strictObject({ id: z.uuid(), baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), fromKeyId: keyId, toKeyId: keyId, startedAt: z.iso.datetime() }).optional() });
const operatorSchema = z.strictObject({ instanceId: z.uuid(), purpose: z.enum(['bootstrap', 'enroll', 'transfer', 'recover', 'rotate-key']), epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  credential: z.string().min(43).max(128).refine(value => Buffer.from(value, 'base64url').length >= 32 && Buffer.from(value, 'base64url').toString('base64url') === value), expiresAt: z.iso.datetime() });

export function issueBootstrapCredential(instanceId: string, epoch: number, now = new Date()) {
  if (!z.uuid().safeParse(instanceId).success || !Number.isSafeInteger(epoch) || epoch < 1 || !Number.isFinite(now.getTime())) throw new Error('instance_invalid');
  const credential = randomBytes(32).toString('base64url');
  return { credential, verifierHash: createHash('sha256').update(credential).digest('hex'), expiresAt: new Date(now.getTime() + LIMITS.instanceBootstrapMs) };
}

export function verifyBootstrapCredential(control: InstanceControl, credential: string, now = new Date()) {
  if (!Number.isFinite(now.getTime()) || now < control.createdAt || !['configuring', 'awaiting_owner'].includes(control.lifecycle) || control.bootstrap.consumedAt || now >= control.bootstrap.expiresAt) return false;
  const bytes = Buffer.from(credential, 'base64url');
  if (bytes.length < 32 || bytes.toString('base64url') !== credential) return false;
  const supplied = createHash('sha256').update(credential).digest();
  const expected = Buffer.from(control.bootstrap.verifierHash, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function readInstanceHost(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), now = new Date()) {
  try {
    const instanceId = z.uuid().parse(env.INSTANCE_ID);
    const config = await loadHostConfig(env, cwd);
    const setupOrigin = new URL(env.INSTANCE_SETUP_ORIGIN!);
    if (setupOrigin.origin !== env.INSTANCE_SETUP_ORIGIN || (setupOrigin.protocol !== 'https:' && !(['development', 'test'].includes(env.NODE_ENV ?? '') && setupOrigin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(setupOrigin.hostname)))) throw new Error();
    const publicRoot = await realpath(resolve(cwd, 'public')).catch(() => resolve(cwd, 'public'));
    async function protectedJson(setting: string) {
      if (!env[setting]) throw new Error();
      const file = resolve(cwd, env[setting]!);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error();
      const actual = await realpath(file);
      for (const root of [publicRoot, config.contentRoot]) {
        const child = relative(root, actual);
        if (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)) throw new Error();
      }
      return JSON.parse(await readFile(actual, 'utf8'));
    }
    const marker = markerSchema.parse(await protectedJson('INSTANCE_STATE_FILE'));
    const storedKeys = keyringSchema.parse(await protectedJson('INSTANCE_KEYRING_FILE'));
    const keys = Object.fromEntries(Object.entries(storedKeys.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')]));
    const encodedAuthKey = Buffer.from(config.authSecret, 'base64url');
    const authKeys = [Buffer.from(config.authSecret), ...(encodedAuthKey.toString('base64url') === config.authSecret ? [encodedAuthKey] : [])];
    if (!Object.hasOwn(keys, storedKeys.activeKeyId) || Object.keys(keys).length > LIMITS.maxInstanceKeyringKeys || new Set(Object.values(keys).map(key => key.toString('base64'))).size !== Object.keys(keys).length ||
        Object.values(keys).some(key => key.equals(config.oauthTokenEncryptionKey) || authKeys.some(authKey => key.equals(authKey))) ||
        (storedKeys.rotation && (storedKeys.rotation.toKeyId !== storedKeys.activeKeyId || storedKeys.rotation.fromKeyId === storedKeys.rotation.toKeyId ||
          !Object.hasOwn(keys, storedKeys.rotation.fromKeyId) || !Object.hasOwn(keys, storedKeys.rotation.toKeyId)))) throw new Error();
    const operator = operatorSchema.parse(await protectedJson('INSTANCE_OPERATOR_AUTH_FILE'));
    if (marker.instanceId !== instanceId || operator.instanceId !== instanceId || operator.epoch !== marker.recoveryEpoch ||
        marker.phase !== 'initialized' && (Date.parse(operator.expiresAt) <= now.getTime() || Date.parse(operator.expiresAt) > now.getTime() + 86_400_000)) throw new Error();
    const originRule = z.strictObject({ origin: z.string().refine(value => {
      try {
        const url = new URL(value);
        return url.origin === value && (url.protocol === 'https:' || (['development', 'test'].includes(env.NODE_ENV ?? '') && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
      } catch { return false; }
    }), addresses: z.array(z.string().refine(value => isIP(value) !== 0)).min(1).max(8) });
    const policy = env.INSTANCE_OUTBOUND_POLICY_FILE ? z.strictObject({ origins: z.array(originRule).max(8) }).parse(await protectedJson('INSTANCE_OUTBOUND_POLICY_FILE')) : { origins: [] };
    return { instanceId, config, setupOrigin: setupOrigin.origin, marker, keyring: { activeKeyId: storedKeys.activeKeyId, keys, ...(storedKeys.rotation ? { rotation: { ...storedKeys.rotation, startedAt: new Date(storedKeys.rotation.startedAt) } } : {}) }, operator, policy };
  } catch { throw new Error('instance_host_unavailable'); }
}

/** Classification consumes validated host/storage evidence; it never creates authority. */
export function classifyInstance(input: { marker: unknown; record: unknown; legacyValid: boolean; empty: boolean }) {
  if (input.marker === null) return input.record === null && input.legacyValid ? 'legacy' : 'maintenance';
  const marker = markerSchema.safeParse(input.marker);
  if (!marker.success) return 'maintenance';
  if (input.record === null) {
    if (marker.data.phase !== 'prepared') return 'maintenance';
    if (input.legacyValid) return 'legacy';
    return input.empty ? 'prepared' : 'maintenance';
  }
  try {
    const control = parseInstanceControl(input.record, marker.data.instanceId);
    if (control.recoveryEpoch !== marker.data.recoveryEpoch || marker.data.phase === 'prepared' || (marker.data.phase === 'initialized' && !control.initializedAt)) return 'maintenance';
    return control.lifecycle;
  } catch { return 'maintenance'; }
}

async function isEmpty(db: import('mongodb').Db) {
  let count = 0;
  for await (const { name } of db.listCollections({}, { nameOnly: true, maxTimeMS: 1000 })) {
    if (++count > 64) return false;
    if (name.startsWith('system.')) continue;
    if (await db.collection(name).countDocuments({}, { limit: 1, maxTimeMS: 1000 })) return false;
  }
  return true;
}

export async function readInstanceSetupStatus(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), now = new Date()) {
  let namespaceAvailable: boolean | null = null;
  try {
    const host = await readInstanceHost(env, cwd, now).catch(() => null);
    const config = host?.config ?? await loadHostConfig(env, cwd);
    const { connectMongo } = await import('../mongo');
    const storage = await connectMongo(config, { initializeLegacy: false });
    try {
      const collision = await storage.db.collection('catalogs').findOne({ slug: 'instance' }, { projection: { _id: 1 } });
      namespaceAvailable = !collision;
      if (!namespaceAvailable || !host) return { state: 'maintenance' as const, prerequisitesAvailable: true, namespaceAvailable };
      const control = await (await import('./store')).readInstance(storage.db, host.instanceId);
      const classification = classifyInstance({ marker: host.marker, record: control,
        legacyValid: false, empty: control === null && await isEmpty(storage.db) });
      const state = ['prepared', 'configuring', 'awaiting_owner'].includes(classification) ? 'setup_required'
        : classification === 'ready' && control?.gate.state === 'open' && host.marker.phase === 'initialized' ? 'ready' : 'maintenance';
      return { state, prerequisitesAvailable: true, namespaceAvailable };
    } finally { await storage.client.close(); }
  } catch {
    return { state: 'maintenance' as const, prerequisitesAvailable: false, namespaceAvailable };
  }
}

export async function readInstancePreferences() {
  if (!process.env.INSTANCE_ID && !process.env.INSTANCE_STATE_FILE) return null;
  const host = await readInstanceHost();
  if (host.marker.phase !== 'initialized') return null;
  const { getMongo } = await import('../mongo');
  const { db } = await getMongo(host.config);
  const control = await (await import('./store')).readInstance(db, host.instanceId);
  if (classifyInstance({ marker: host.marker, record: control, legacyValid: false, empty: false }) !== 'ready' || control?.gate.state !== 'open') return null;
  return control.active?.preferences ?? null;
}

export function legacyInstanceDigest(config: Awaited<ReturnType<typeof import('../config').loadConfig>>) {
  return createHmac('sha256', config.authSecret).update(JSON.stringify([config.authUrl, config.zitadelIssuer, config.zitadelClientId,
    config.zitadelProjectId, config.zitadelApiAudience, config.zitadelSecret, config.githubAppId, config.githubPrivateKey, config.githubWebhookSecret])).digest('hex');
}

export async function hasLegacyEnrollment() {
  const host = await readInstanceHost();
  const { connectMongo } = await import('../mongo');
  const storage = await connectMongo(host.config, { initializeLegacy: false });
  try {
    const control = await (await import('./store')).readInstance(storage.db, host.instanceId);
    return !!control?.migration && !control.initializedAt && host.operator.purpose === 'enroll';
  } finally { await storage.client.close(); }
}

export async function hasInstanceRecovery() {
  const host = await readInstanceHost();
  if (host.operator.purpose !== 'recover' || Date.parse(host.operator.expiresAt) <= Date.now()) return false;
  const { connectMongo } = await import('../mongo');
  const storage = await connectMongo(host.config, { initializeLegacy: false });
  try {
    const control = await (await import('./store')).readInstance(storage.db, host.instanceId);
    return !!control?.initializedAt && !!control.bootstrap.consumedAt && control.lifecycle === 'maintenance' &&
      control.gate.state === 'maintenance' && control.recoveryEpoch === host.marker.recoveryEpoch;
  } finally { await storage.client.close(); }
}
