import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { closeMongo } from '../../lib/mongo';
import { newCatalogRecord, type Catalog } from '../../lib/catalog';
import { getSyncWorkerStatus, hasHealthySyncWorker, startSyncWorker } from '../../lib/sync/worker';
import { register } from '../../instrumentation';
import { stopConfiguredWorker } from '../../lib/sync/worker-startup';
import { createStorageHarness } from './http-harness';

const runtimeKeys = ['NEXT_RUNTIME', 'NEXT_PHASE', 'NODE_ENV', 'LIBRARIAN_WORKER_ENABLED', 'AUTH_URL', 'AUTH_TRUST_HOST',
  'AUTH_ZITADEL_ID', 'AUTH_ZITADEL_ISSUER', 'ZITADEL_PROJECT_ID', 'ZITADEL_API_AUDIENCE', 'MONGODB_DATABASE',
  'GITHUB_APP_ID', 'CONTENT_ROOT', 'AUTH_SECRET_FILE', 'AUTH_ZITADEL_SECRET_FILE', 'MONGODB_URI_FILE',
  'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET_FILE', 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE'] as const;

it('does not start the synchronization worker outside the Node runtime', async () => {
  const previous = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = 'edge';
  try {
    await expect(register()).resolves.toBeUndefined();
    expect(getSyncWorkerStatus().enabled).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.NEXT_RUNTIME; else process.env.NEXT_RUNTIME = previous;
  }
});

it('runs one bounded worker loop and stops its idle wait promptly', async () => {
  const storage = await createStorageHarness();
  const catalog = newCatalogRecord({ github: { repositoryId: 714, installationId: 815, owner: 'synthetic', name: 'startup', branch: 'main', docsPath: 'docs' },
    slug: 'worker-startup', title: 'Worker startup', visibility: 'private' });
  catalog.accessState = 'ready';
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
  let reads = 0;
  const worker = startSyncWorker({ db: storage.db, contentRoot: storage.contentRoot,
    readCandidate: async () => { reads++; throw new Error('No queued work expected'); } });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(worker.healthy).toBe(true);
    expect(worker.active).toBe(false);
    expect(reads).toBe(0);
    expect(getSyncWorkerStatus()).toEqual({ enabled: true, healthy: true, active: false });
    expect(await hasHealthySyncWorker(storage.db)).toBe(true);
  } finally {
    await worker.stop();
    try { expect(await hasHealthySyncWorker(storage.db)).toBe(false); } finally { await storage.close(); }
  }
  expect(worker.finished).toBe(true);
});

it('fails closed when the persisted worker heartbeat is stale', async () => {
  const storage = await createStorageHarness();
  try {
    await storage.db.collection<{ _id: string; enabled: boolean; healthy: boolean; active: boolean; updatedAt: Date }>('syncWorkerStatus').insertOne({ _id: 'stale-worker', enabled: true,
      healthy: true, active: false, updatedAt: new Date(Date.now() - 60_000) });
    expect(await hasHealthySyncWorker(storage.db)).toBe(false);
  } finally { await storage.close(); }
});

it('boots the worker only through the configured production Node instrumentation path', async () => {
  const storage = await createStorageHarness();
  const prior = new Map(runtimeKeys.map(key => [key, process.env[key]]));
  const files = new Map<string, string>();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const secrets = {
    AUTH_SECRET_FILE: randomBytes(32).toString('base64url'), AUTH_ZITADEL_SECRET_FILE: 'synthetic-client-secret',
    MONGODB_URI_FILE: `mongodb://127.0.0.1:27018/${storage.db.databaseName}`,
    GITHUB_APP_PRIVATE_KEY_FILE: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    GITHUB_WEBHOOK_SECRET_FILE: randomBytes(32).toString('hex'),
    OAUTH_TOKEN_ENCRYPTION_KEY_FILE: randomBytes(32).toString('base64'),
  };
  try {
    for (const [key, value] of Object.entries(secrets)) {
      const path = join(storage.root, `${key}.secret`);
      await writeFile(path, value, { mode: 0o600 });
      files.set(key, path);
    }
    Object.assign(process.env, {
      NEXT_RUNTIME: 'nodejs', NODE_ENV: 'production', LIBRARIAN_WORKER_ENABLED: '1', AUTH_URL: 'https://portal.synthetic.invalid',
      AUTH_TRUST_HOST: 'true', AUTH_ZITADEL_ID: 'synthetic-client', AUTH_ZITADEL_ISSUER: 'https://identity.synthetic.invalid',
      ZITADEL_PROJECT_ID: 'synthetic-project', ZITADEL_API_AUDIENCE: 'synthetic-api', MONGODB_DATABASE: storage.db.databaseName,
      GITHUB_APP_ID: '12345', CONTENT_ROOT: storage.contentRoot, ...Object.fromEntries(files),
    });
    delete process.env.NEXT_PHASE;
    await register();
    expect(getSyncWorkerStatus()).toEqual({ enabled: true, healthy: true, active: false });
  } finally {
    await stopConfiguredWorker();
    await closeMongo();
    for (const key of runtimeKeys) {
      const value = prior.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key); else Reflect.set(process.env, key, value);
    }
    await storage.close();
  }
});
