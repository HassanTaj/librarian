import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareInstance } from '../../scripts/instance-operator.mjs';

const state = vi.hoisted(() => ({ random: vi.fn(), command: vi.fn(), collections: vi.fn(), insert: vi.fn() }));
vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(), randomBytes: state.random }));
let root: string; let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  vi.resetAllMocks();
  state.random.mockImplementation((await vi.importActual<typeof import('node:crypto')>('node:crypto')).randomBytes);
  root = await mkdtemp(join(tmpdir(), 'librarian-operator-storage-'));
  const content = join(root, 'content'); const prerequisites = join(root, 'prerequisites');
  await mkdir(content); await mkdir(prerequisites);
  const mongo = join(prerequisites, 'mongo'); const auth = join(prerequisites, 'auth'); const oauth = join(prerequisites, 'oauth');
  await writeFile(mongo, 'mongodb://127.0.0.1:1/', { mode: 0o600 });
  await writeFile(auth, Buffer.alloc(32, 4).toString('base64url'), { mode: 0o600 });
  await writeFile(oauth, Buffer.alloc(32, 5).toString('base64'), { mode: 0o600 });
  env = { NODE_ENV: 'test', CONTENT_ROOT: content, MONGODB_DATABASE: 'librarian_test_operator_storage', MONGODB_URI_FILE: mongo,
    AUTH_SECRET_FILE: auth, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: oauth };
  state.command.mockResolvedValue({ isWritablePrimary: true, maxWireVersion: 13 }); state.collections.mockResolvedValue([]); state.insert.mockResolvedValue({ acknowledged: true });
  const db = { command: state.command, listCollections: () => ({ toArray: state.collections }), collection: () => ({ insertOne: state.insert }) } as unknown as Db;
  vi.spyOn(MongoClient.prototype, 'connect').mockImplementation(async function (this: MongoClient) { return this; });
  vi.spyOn(MongoClient.prototype, 'db').mockReturnValue(db); vi.spyOn(MongoClient.prototype, 'close').mockResolvedValue(undefined);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it.each(['connection', 'hello', 'read-only', 'wire-version', 'collections', 'too-many-collections', 'mode', 'insert'] as const)
  ('preserves interrupted installation evidence and fails safely on %s', async condition => {
    let expected = 'operator_storage_unavailable';
    if (condition === 'connection') vi.mocked(MongoClient.prototype.connect).mockRejectedValue(new Error('SYNTHETIC_DATABASE_URI'));
    if (condition === 'hello') state.command.mockRejectedValue(new Error('SYNTHETIC_DATABASE_URI'));
    if (condition === 'read-only') state.command.mockResolvedValue({ isWritablePrimary: false, maxWireVersion: 13 });
    if (condition === 'wire-version') state.command.mockResolvedValue({ isWritablePrimary: true, maxWireVersion: 12 });
    if (condition === 'collections') state.collections.mockRejectedValue(new Error('SYNTHETIC_DATABASE_URI'));
    if (condition === 'too-many-collections') { state.collections.mockResolvedValue(Array.from({ length: 65 }, (_, index) => ({ name: `system.synthetic_${index}` }))); expected = 'operator_database_not_empty'; }
    if (condition === 'mode') expected = 'operator_invalid_arguments';
    if (condition === 'insert') { state.insert.mockRejectedValue(new Error('SYNTHETIC_DATABASE_URI')); expected = 'operator_prepare_interrupted'; }
    const destination = join(root, 'authority');
    await expect(prepareInstance({ root: destination, origin: 'https://setup.example.test', env, mode: condition === 'mode' ? 'unsupported' : 'prepare' })).rejects.toThrow(expected);
    expect(MongoClient.prototype.close).toHaveBeenCalledOnce();
    if (condition === 'insert') {
      expect(JSON.parse(await readFile(join(destination, 'instance-state.json'), 'utf8')).phase).toBe('sealed');
      await expect(prepareInstance({ root: destination, origin: 'https://setup.example.test', env })).rejects.toThrow('operator_storage_not_private');
    } else { await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' }); expect(state.insert).not.toHaveBeenCalled(); }
  });

it('regenerates a colliding root key and permits only system metadata in a fresh database', async () => {
  const authKey = Buffer.alloc(32, 4); const oauthKey = Buffer.alloc(32, 5);
  state.random.mockReturnValueOnce(oauthKey).mockReturnValueOnce(authKey);
  state.collections.mockResolvedValue([{ name: 'system.profile' }]);
  const destination = join(root, 'authority');
  await prepareInstance({ root: destination, origin: 'https://setup.example.test', env });
  const ring = JSON.parse(await readFile(join(destination, 'instance-keyring.json'), 'utf8'));
  const key = Buffer.from(ring.keys[ring.activeKeyId], 'base64');
  expect(key.equals(authKey)).toBe(false); expect(key.equals(oauthKey)).toBe(false);
  expect(state.insert).toHaveBeenCalledOnce();
});

it('uses valid direct host prerequisites and rejects empty or oversized direct values before creating authority', async () => {
  const direct = { MONGODB_URI: 'mongodb://127.0.0.1:27018/librarian_test_operator_storage',
    AUTH_SECRET: Buffer.alloc(32, 8).toString('base64url'), OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
  const destination = join(root, 'direct-authority');
  await prepareInstance({ root: destination, origin: 'https://setup.example.test', env: { ...env, ...direct } });
  expect(JSON.parse(await readFile(join(destination, 'instance-state.json'), 'utf8')).phase).toBe('sealed');

  for (const name of Object.keys(direct) as (keyof typeof direct)[]) {
    for (const value of ['', 'x'.repeat(65 * 1024)]) {
      const invalidRoot = join(root, `invalid-${name}-${value.length}`);
      await expect(prepareInstance({ root: invalidRoot, origin: 'https://setup.example.test', env: { ...env, ...direct, [name]: value } }))
        .rejects.toThrow('operator_host_prerequisite_missing');
      await expect(access(invalidRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }
});
