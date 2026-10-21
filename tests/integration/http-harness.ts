import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { attachInstanceKeyring, serializeInstanceControl, type InstanceControl, type StoredInstanceControl } from '../../lib/instance/store';
import type { InstanceKeyring } from '../../lib/instance/secrets';

export const instanceTestKeyring: InstanceKeyring = { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } };

export async function insertInstanceControl(db: import('mongodb').Db, control: InstanceControl, keyring: InstanceKeyring = instanceTestKeyring) {
  await db.collection<StoredInstanceControl>('instance_configuration').insertOne(await serializeInstanceControl(control, control.instanceId, keyring));
}

/** This harness only accepts a loopback disposable Mongo server, never a live URI. */
export async function createStorageHarness(uri = 'mongodb://127.0.0.1:27018') {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/?$/.test(uri)) throw new Error('Disposable loopback Mongo URI required');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10, minPoolSize: 0 });
  const name = `librarian_test_${randomUUID().replaceAll('-', '')}`;
  const root = await mkdtemp(join(tmpdir(), 'librarian-http-test-'));
  try {
    await client.connect();
    const db = client.db(name);
    await db.command({ ping: 1 });
    attachInstanceKeyring(db, instanceTestKeyring);
    await mkdir(join(root, 'content'));
    return {
      client, db, root, contentRoot: join(root, 'content'),
      async close() {
        try { await db.dropDatabase(); }
        finally { await client.close(); await rm(root, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await client.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function startNextHarness(options: {
  appRoot: string;
  port: number;
  env?: Partial<NodeJS.ProcessEnv>;
  coverageDirectory?: string;
}) {
  if (options.port < 1024 || options.port > 65535) throw new Error('Invalid test port');
  const appRoot = resolve(options.appRoot);
  const origin = `http://127.0.0.1:${options.port}`;
  const capture = process.env.LIBRARIAN_COVERAGE_PROCESS_DIR && appRoot === process.cwd()
    ? join(process.env.LIBRARIAN_COVERAGE_PROCESS_DIR, `server-${randomUUID()}.json`) : undefined;
  // The real checkout may now hold DEV bootstrap inputs; tests use only their explicit synthetic environment.
  const child = spawn(process.execPath, [join(appRoot, 'tests/integration/next-process.mjs'), appRoot, String(options.port)], {
    cwd: appRoot,
    env: { ...process.env, __NEXT_PROCESSED_ENV: 'true', INSTANCE_DATABASE_FILE: '', LIBRARIAN_WORKER_ENABLED: '0', ...(capture ? { LIBRARIAN_INSTRUMENTED_CAPTURE: capture } : {}), ...options.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', ...(options.coverageDirectory ? { NODE_V8_COVERAGE: options.coverageDirectory } : {}) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  // Consume output without printing provider values or document bodies.
  child.stdout?.resume();
  child.stderr?.resume();
  let exited = false;
  child.once('exit', () => { exited = true; });
  let startupError: Error | undefined;
  child.once('error', error => { startupError = error; });
  async function close() {
    if (exited) return;
    const exit = once(child, 'exit');
    child.send('shutdown');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      const [code, signal] = await exit;
      if (code !== 143 || signal !== null) throw new Error('Test Next server did not complete SIGTERM cleanup');
    } finally { clearTimeout(timer); }
  }
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (startupError || exited) throw new Error('Test Next server failed to start');
      try {
        await fetch(origin, { signal: AbortSignal.timeout(1000), redirect: 'manual' });
        return { origin, process: child, close };
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw new Error('Test Next server readiness deadline exceeded');
  } catch (error) { await close(); throw error; }
}
