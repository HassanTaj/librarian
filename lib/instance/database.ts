import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { z } from 'zod';
import type { InstanceControl } from './store';
import type { InstanceKeyring } from './secrets';

export const InstanceDatabaseSchema = z.strictObject({
  mongodbUri: z.string().min(1).max(16 * 1024),
  mongodbDatabase: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/).refine(value => !['admin', 'local', 'config'].includes(value)),
}).superRefine((value, context) => {
  try {
    const client = new MongoClient(value.mongodbUri);
    const path = value.mongodbUri.replace(/^mongodb(?:\+srv)?:\/\/[^/]+/, '').split('?')[0];
    if (value.mongodbUri.includes('#') || path && path !== '/' && client.options.dbName !== value.mongodbDatabase ||
        client.options.tlsInsecure || client.options.rejectUnauthorized === false || client.options.checkServerIdentity !== undefined) throw new Error();
  } catch { context.addIssue({ code: 'custom', message: 'Invalid database connection' }); }
});
export type InstanceDatabase = z.infer<typeof InstanceDatabaseSchema>;

function inside(path: string, root: string) {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

async function locatorPath(env: NodeJS.ProcessEnv, cwd: string) {
  if (!env.INSTANCE_DATABASE_FILE || !env.INSTANCE_STATE_FILE) throw new Error('instance_operator_required');
  const file = resolve(cwd, env.INSTANCE_DATABASE_FILE);
  const root = await realpath(dirname(resolve(cwd, env.INSTANCE_STATE_FILE)));
  const parent = await realpath(dirname(file));
  const sameRoot = process.platform === 'win32' ? parent.toLowerCase() === root.toLowerCase() : parent === root;
  if (!sameRoot || basename(file) !== 'instance-database.json') throw new Error('instance_operator_required');
  const content = await realpath(resolve(cwd, env.CONTENT_ROOT ?? ''));
  if (inside(file, resolve(cwd, 'public')) || inside(file, content)) throw new Error('instance_operator_required');
  return resolve(parent, 'instance-database.json');
}

/** The root key and this minimum startup locator stay outside encrypted MongoDB. */
export async function readInstanceDatabase(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  try {
    const file = await locatorPath(env, cwd);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error();
    return InstanceDatabaseSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch { throw new Error('instance_host_unavailable'); }
}

export async function writeInstanceDatabase(value: InstanceDatabase, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const locator = InstanceDatabaseSchema.safeParse({ mongodbUri: value.mongodbUri, mongodbDatabase: value.mongodbDatabase });
  if (!locator.success) throw new Error('instance_invalid');
  const file = await locatorPath(env, cwd);
  const existing = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('instance_host_unavailable');
  await writeProtectedJson(file, locator.data);
}

async function writeProtectedJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, file);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new Error('instance_host_unavailable');
  }
}

/** A connection edit must reach the current instance, not an empty or stale copy. */
export async function checkInstanceDatabase(value: InstanceDatabase, control: InstanceControl, keyring: InstanceKeyring, source: Db) {
  const parsed = InstanceDatabaseSchema.safeParse({ mongodbUri: value.mongodbUri, mongodbDatabase: value.mongodbDatabase });
  if (!parsed.success) throw new Error('instance_invalid');
  const { connectMongo } = await import('../mongo');
  const { readInstance } = await import('./store');
  let storage;
  const probeId = 'database:' + control.instanceId;
  const owner = randomUUID();
  const probes = source.collection<{ _id: string; owner: string; expiresAt: Date }>('instance_check_leases');
  try {
    const now = new Date();
    const claimed = await probes.updateOne({ _id: probeId, expiresAt: { $lte: now } },
      { $set: { owner, expiresAt: new Date(now.getTime() + 30_000) } }, { upsert: true });
    if (!claimed.matchedCount && !claimed.upsertedCount) throw new Error();
    storage = await connectMongo({ ...parsed.data, instanceKeyring: keyring }, { initializeLegacy: false });
    const target = await readInstance(storage.db, control.instanceId);
    if (!target || target.editRevision !== control.editRevision || target.active?.version !== control.active?.version ||
        target.candidate?.version !== control.candidate?.version || target.securityEpoch !== control.securityEpoch || target.recoveryEpoch !== control.recoveryEpoch) throw new Error();
    // The fresh source-side nonce also rejects a cloned or stale instance database.
    if (!await storage.db.collection<{ _id: string; owner: string }>('instance_check_leases').findOne({ _id: probeId, owner })) throw new Error();
  } catch { throw new Error('instance_database_mismatch'); }
  finally { try { await probes.deleteOne({ _id: probeId, owner }); } finally { await storage?.client.close(); } }
}

export async function sealInstanceDatabaseSetup(instanceId: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const file = resolve(cwd, env.INSTANCE_STATE_FILE!);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('instance_host_unavailable');
  const marker = JSON.parse(await readFile(file, 'utf8'));
  if (marker.instanceId !== instanceId || marker.phase !== 'prepared') throw new Error('instance_conflict');
  await writeProtectedJson(file, { ...marker, phase: 'sealed' });
}
