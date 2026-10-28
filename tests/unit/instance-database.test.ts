import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareInstance } from '../../scripts/instance-operator.mjs';
import { InstanceDatabaseSchema, checkInstanceDatabase, readInstanceDatabase, sealInstanceDatabaseSetup, writeInstanceDatabase } from '../../lib/instance/database';
import { instanceControl, readyInstance } from '../fixtures/instance';
import { InstanceControlSchema } from '../../lib/instance/store';
import type { InstanceControl } from '../../lib/instance/store';

const state = vi.hoisted(() => ({ connect: vi.fn(), read: vi.fn(), initialize: vi.fn(), close: vi.fn(), nonempty: false, names: [] as string[],
  existing: null as { _id: string; instanceId: string } | null, probe: '', probeVisible: true, probeClaimed: true }));
vi.mock('../../lib/mongo', () => ({ connectMongo: state.connect }));
vi.mock('../../lib/instance/store', async original => ({ ...await original<typeof import('../../lib/instance/store')>(), readInstance: state.read, initializeInstance: state.initialize }));

let root: string;
let env: NodeJS.ProcessEnv;
let credential: string;
const locator = { mongodbUri: 'mongodb://127.0.0.1:27018/librarian_new', mongodbDatabase: 'librarian_new' };

beforeEach(async () => {
  vi.resetAllMocks(); state.nonempty = false; state.names = []; state.existing = null; state.probe = ''; state.probeVisible = true; state.probeClaimed = true;
  root = await mkdtemp(join(tmpdir(), 'librarian-database-'));
  const content = join(root, 'content'); await mkdir(content);
  env = { NODE_ENV: 'test', CONTENT_ROOT: content };
  const hostRoot = join(root, 'instance');
  await prepareInstance({ root: hostRoot, origin: 'http://localhost:3002', env, deferDatabase: true });
  for (const line of (await readFile(join(hostRoot, 'instance.env'), 'utf8')).split('\n')) {
    const index = line.indexOf('='); if (index > 0) env[line.slice(0, index)] = JSON.parse(line.slice(index + 1));
  }
  credential = JSON.parse(await readFile(env.INSTANCE_OPERATOR_AUTH_FILE!, 'utf8')).credential;
  for (const key of ['MONGODB_URI', 'MONGODB_URI_FILE', 'AUTH_SECRET', 'AUTH_SECRET_FILE', 'OAUTH_TOKEN_ENCRYPTION_KEY', 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE', 'PUBLIC_CATALOG_APPROVALS_FILE', 'INSTANCE_OUTBOUND_POLICY_FILE']) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  state.read.mockResolvedValue(null);
  state.connect.mockResolvedValue({ client: { close: state.close }, db: {
    async *listCollections() { for (const name of state.names) yield { name }; if (state.nonempty && !state.names.length) yield { name: 'existing_documents' }; },
    collection(name: string) { return { updateOne: vi.fn(async (_filter, update) => { state.probe = update.$set.owner; return state.probeClaimed ? { matchedCount: 1 } : { matchedCount: 0, upsertedCount: 0 }; }),
      deleteOne: vi.fn(async () => { state.probe = ''; }),
      findOne: vi.fn(async (_filter) => name === 'instance_configuration' ? state.existing : name === 'instance_check_leases' && state.probeVisible && state.probe === _filter.owner ? { owner: state.probe } : null),
      countDocuments: vi.fn(async () => 1) }; },
  } });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function configure(body: unknown = { ...locator, credential }, origin = 'http://localhost:3002', contentType = 'application/json') {
  const { POST } = await import('../../app/api/instance/database/route');
  return POST(new Request('http://localhost:3002/api/instance/database', { method: 'POST', headers: { origin, 'content-type': contentType }, body: JSON.stringify(body) }));
}

it('prepares the host without needing or connecting to MongoDB', async () => {
  expect(JSON.parse(await readFile(env.INSTANCE_STATE_FILE!, 'utf8')).phase).toBe('prepared');
  expect(state.connect).not.toHaveBeenCalled();
  await expect(readInstanceDatabase()).rejects.toThrow('instance_host_unavailable');
});

it('validates database names, matching URI paths and certificate verification', () => {
  expect(InstanceDatabaseSchema.safeParse(locator).success).toBe(true);
  for (const value of [
    { ...locator, mongodbDatabase: 'admin' }, { ...locator, mongodbDatabase: 'other_database' },
    { ...locator, mongodbUri: locator.mongodbUri + '?tlsInsecure=true' },
    { ...locator, mongodbUri: locator.mongodbUri + '?tlsAllowInvalidCertificates=true' },
    { ...locator, mongodbUri: locator.mongodbUri + '?tlsAllowInvalidHostnames=true' },
    { ...locator, mongodbUri: 'not-a-mongodb-uri' },
  ]) expect(InstanceDatabaseSchema.safeParse(value).success).toBe(false);
});

it('durably stores only the required host locator and rejects a path outside the protected instance root', async () => {
  await writeInstanceDatabase(locator);
  expect(await readInstanceDatabase()).toEqual(locator);
  await expect(writeInstanceDatabase(locator, { ...env, INSTANCE_DATABASE_FILE: join(root, 'elsewhere.json') })).rejects.toThrow('instance_operator_required');
  expect(await readInstanceDatabase()).toEqual(locator);
  await writeFile(env.INSTANCE_DATABASE_FILE!, 'invalid');
  await expect(readInstanceDatabase()).rejects.toThrow('instance_host_unavailable');
});

it('rejects missing, misplaced, oversized, non-file and invalid host locators', async () => {
  await expect(readInstanceDatabase({ ...env, INSTANCE_DATABASE_FILE: '' })).rejects.toThrow('instance_host_unavailable');
  const hostRoot = join(env.INSTANCE_STATE_FILE!, '..');
  await expect(writeInstanceDatabase(locator, { ...env, INSTANCE_DATABASE_FILE: join(hostRoot, 'wrong-name.json') })).rejects.toThrow('instance_operator_required');
  await expect(readInstanceDatabase({ ...env, CONTENT_ROOT: hostRoot })).rejects.toThrow('instance_host_unavailable');

  const publicRoot = join(root, 'public'); await mkdir(publicRoot);
  await expect(readInstanceDatabase({ ...env, INSTANCE_STATE_FILE: 'public/state.json', INSTANCE_DATABASE_FILE: 'public/instance-database.json', CONTENT_ROOT: 'content' }, root))
    .rejects.toThrow('instance_host_unavailable');

  await writeFile(env.INSTANCE_DATABASE_FILE!, 'x'.repeat(20 * 1024 + 1));
  await expect(readInstanceDatabase()).rejects.toThrow('instance_host_unavailable');
  await rm(env.INSTANCE_DATABASE_FILE!, { force: true }); await mkdir(env.INSTANCE_DATABASE_FILE!);
  await expect(readInstanceDatabase()).rejects.toThrow('instance_host_unavailable');
  await expect(writeInstanceDatabase({ ...locator, mongodbDatabase: 'admin' })).rejects.toThrow('instance_invalid');
  await expect(writeInstanceDatabase(locator)).rejects.toThrow('instance_host_unavailable');
});

it('initializes an empty database only after operator authorization and never returns credentials', async () => {
  const response = await configure();
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain(credential); expect(body).not.toContain(locator.mongodbUri);
  const control = state.initialize.mock.calls[0][1] as InstanceControl;
  expect(InstanceControlSchema.safeParse(control).success).toBe(true);
  expect(control.instanceId).toBe(env.INSTANCE_ID);
  expect(control.bootstrap.verifierHash).toBe(createHash('sha256').update(credential).digest('hex'));
  expect(await readInstanceDatabase()).toEqual(locator);
  expect(JSON.parse(await readFile(env.INSTANCE_STATE_FILE!, 'utf8')).phase).toBe('sealed');
  expect((await configure()).status).toBe(409);
}, 15_000);

it('seals only the matching prepared host marker', async () => {
  await expect(sealInstanceDatabaseSetup('different-instance')).rejects.toThrow('instance_conflict');
  await sealInstanceDatabaseSetup(env.INSTANCE_ID!);
  expect(JSON.parse(await readFile(env.INSTANCE_STATE_FILE!, 'utf8')).phase).toBe('sealed');
  await expect(sealInstanceDatabaseSetup(env.INSTANCE_ID!)).rejects.toThrow('instance_conflict');
});

it('rejects wrong credentials and cross-origin requests before a database connection', async () => {
  expect((await configure({ ...locator, credential: 'x'.repeat(43) })).status).toBe(401);
  expect((await configure({ ...locator, credential }, 'https://foreign.example.test')).status).toBe(403);
  expect(state.connect).not.toHaveBeenCalled(); expect(state.initialize).not.toHaveBeenCalled();
});

it('rejects malformed payloads and non-JSON requests before connecting', async () => {
  expect((await configure({})).status).toBe(400);
  expect((await configure({ ...locator, credential }, 'http://localhost:3002', 'text/plain')).status).toBe(403);
  expect(state.connect).not.toHaveBeenCalled();
});

it('resumes a matching configuring record and ignores only system collections', async () => {
  const control = instanceControl(env.INSTANCE_ID);
  control.bootstrap.verifierHash = createHash('sha256').update(credential).digest('hex');
  state.read.mockResolvedValue(control);
  state.existing = { _id: 'instance', instanceId: env.INSTANCE_ID! };
  state.names = ['system.profile', 'instance_configuration'];
  expect((await configure()).status).toBe(200);
  expect(state.initialize).not.toHaveBeenCalled();
});

it('rejects a database owned by another instance before initialization', async () => {
  state.existing = { _id: 'instance', instanceId: 'different-instance' };
  expect((await configure()).status).toBe(409);
  expect(state.initialize).not.toHaveBeenCalled();
});

it('retains a nonempty database and does not advance its prepared host marker', async () => {
  state.nonempty = true;
  expect((await configure()).status).toBe(409);
  expect(state.initialize).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(env.INSTANCE_STATE_FILE!, 'utf8')).phase).toBe('prepared');
  await expect(readInstanceDatabase()).rejects.toThrow();
});

it('resumes an interrupted initial connection only for the same prepared instance and credential', async () => {
  const control = instanceControl(env.INSTANCE_ID);
  control.bootstrap.verifierHash = createHash('sha256').update(credential).digest('hex');
  state.read.mockResolvedValue(control);
  expect((await configure()).status).toBe(200);
  expect(state.initialize).not.toHaveBeenCalled();
});

it('accepts connection edits only when the target holds the same current instance', async () => {
  const control = readyInstance();
  state.read.mockResolvedValue(control);
  const source = (await state.connect()).db;
  const keyring = { activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 3) } };
  await expect(checkInstanceDatabase({ ...locator, ...control.active!.runtime! }, control, keyring, source)).resolves.toBeUndefined();
  state.probeVisible = false;
  await expect(checkInstanceDatabase(locator, control, keyring, source)).rejects.toThrow('instance_database_mismatch');
  state.probeVisible = true;
  state.read.mockResolvedValue({ ...control, editRevision: control.editRevision + 1 });
  await expect(checkInstanceDatabase(locator, control, keyring, source)).rejects.toThrow('instance_database_mismatch');
  state.read.mockResolvedValue(null);
  await expect(checkInstanceDatabase(locator, control, keyring, source)).rejects.toThrow('instance_database_mismatch');
  state.read.mockResolvedValue({ ...control, active: { ...control.active!, version: control.active!.version + 1 } });
  await expect(checkInstanceDatabase(locator, control, keyring, source)).rejects.toThrow('instance_database_mismatch');
  state.read.mockResolvedValue({ ...control, candidate: { ...control.active!, version: control.nextBundleVersion } });
  await expect(checkInstanceDatabase(locator, control, keyring, source)).rejects.toThrow('instance_database_mismatch');
  state.read.mockResolvedValue({ ...control, securityEpoch: control.securityEpoch + 1 });
  await expect(checkInstanceDatabase(locator, control, keyring, source)).rejects.toThrow('instance_database_mismatch');
  state.read.mockResolvedValue({ ...control, recoveryEpoch: control.recoveryEpoch + 1 });
  await expect(checkInstanceDatabase(locator, control, keyring, source)).rejects.toThrow('instance_database_mismatch');
  await expect(checkInstanceDatabase({ ...locator, mongodbDatabase: 'admin' }, control, keyring, source)).rejects.toThrow('instance_invalid');
  state.probeClaimed = false;
  await expect(checkInstanceDatabase(locator, control, keyring, source)).rejects.toThrow('instance_database_mismatch');
});
