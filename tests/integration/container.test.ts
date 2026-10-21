import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { seedRuntimeCatalog } from './runtime-fixtures';

const image = process.env.LIBRARIAN_TEST_IMAGE;
const previousImage = process.env.LIBRARIAN_PREVIOUS_TEST_IMAGE;
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true }).trim();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function ready(origin: string, name: string, db: Awaited<ReturnType<typeof seedRuntimeCatalog>>['db']) {
  const deadline = Date.now() + 45_000;
  let last = 'no_response';
  while (Date.now() < deadline) {
    const state = JSON.parse(docker(['container', 'inspect', '--format', '{{json .State}}', name])) as { Running: boolean };
    if (!state.Running) throw new Error('Container exited before health became ready');
    try {
      const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) });
      const body = await response.json() as { status?: string };
      last = 'http_' + response.status + '_' + (body.status ?? 'unknown');
      if (response.status === 200 && body.status === 'ok') return;
    } catch (error) { last = error instanceof Error ? error.name : 'network_error'; }
    await wait(250);
  }
  const logs = docker(['logs', name]);
  const cause = logs.includes('Invalid server configuration') ? 'invalid_config'
    : logs.includes('MongoServerSelectionError') || logs.includes('MongoNetworkError') ? 'mongo_unavailable'
      : logs.includes('storage_unavailable') ? 'storage_unavailable'
        : logs.includes('EACCES') ? 'permission_denied'
          : logs.includes('ENOENT') ? 'missing_runtime_file' : 'unknown';
  const workers = await db.collection('syncWorkerStatus').find({}, { projection: { _id: 0 } }).toArray();
  const heartbeat = workers.map(({ enabled, healthy, active, updatedAt }) => ({ enabled, healthy, active,
    ageMs: updatedAt instanceof Date ? Date.now() - updatedAt.getTime() : null }));
  const mappedPort = docker(['port', name, '3000/tcp']).split(':').at(-1);
  let internal = 'unreachable';
  try {
    internal = docker(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(2000)}).then(async r=>console.log(r.status+':'+(await r.text()).slice(0,40))).catch(()=>console.log('unreachable'))"]);
  } catch { internal = 'probe_error'; }
  throw new Error('Container did not reach worker-backed health readiness (' + last + ', ' + cause + ', port=' + mappedPort + ', original_port=' + new URL(origin).port + ', internal=' + internal + ', heartbeat=' + JSON.stringify(heartbeat) + ')');
}

it('runs the traced application as non-root with runtime dependencies and persistent storage', async () => {
  if (!image) throw new Error('Set LIBRARIAN_TEST_IMAGE to the local image built for container acceptance.');
  if (!previousImage || previousImage === image) throw new Error('Set LIBRARIAN_PREVIOUS_TEST_IMAGE to a distinct image built from the parent revision.');
  const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0] as { Config: { User: string } };
  expect(imageInfo.Config.User).toBe('nextjs');
  docker(['run', '--rm', '--entrypoint', 'sh', image, '-ec',
    'test \"$(id -u)\" = \"1001\"; test -f /app/server.js; test -d /app/node_modules/@fumadocs/local-md; test -d /app/node_modules/shiki; test -f /app/public/logos/dark.svg; for d in /app/docs /app/specs /app/tests /app/snapshots /app/.local /app/coverage; do test ! -e \"$d\" || exit 2; done']);

  const storage = await seedRuntimeCatalog();
  const token = randomUUID();
  const base = 'librarian-container-test-' + token.replaceAll('-', '');
  const volume = base;
  const names = [base + '-one', base + '-two'];
  const created: string[] = [];
  let volumeCreated = false;
  let contentCopied = false;
  try {
    const secrets = join(storage.root, 'secrets');
    await mkdir(secrets);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const secretValues = {
      auth: randomBytes(32).toString('base64url'),
      oidc: 'synthetic-client-secret',
      mongo: 'mongodb://host.docker.internal:27018/' + storage.db.databaseName,
      github: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      webhook: randomBytes(32).toString('hex'),
      encryption: randomBytes(32).toString('base64'),
    };
    await Promise.all(Object.entries(secretValues).map(([key, value]) =>
      writeFile(join(secrets, key + '.secret'), value, { mode: 0o600 })));

    docker(['volume', 'create', '--label', 'io.librarian.codex-test=' + token, volume]);
    volumeCreated = true;
    docker(['run', '--rm', '--user', '0:0', '--entrypoint', 'sh', '--mount',
      'type=volume,source=' + volume + ',target=/data/content', image, '-ec', 'chown 1001:1001 /data/content']);

    const start = async (name: string, appImage = image) => {
      docker(['run', '--detach', '--name', name, '--label', 'io.librarian.codex-test=' + token,
        '--add-host=host.docker.internal:host-gateway', '--cpus=0.5', '--memory=512m', '--publish=127.0.0.1::3000',
        '--mount', 'type=volume,source=' + volume + ',target=/data/content',
        '--mount', 'type=bind,source=' + secrets + ',target=/run/secrets,readonly',
        '--env', 'AUTH_URL=https://portal.synthetic.invalid', '--env', 'AUTH_TRUST_HOST=true',
        '--env', 'AUTH_ZITADEL_ID=synthetic-client', '--env', 'AUTH_ZITADEL_ISSUER=https://identity.synthetic.invalid',
        '--env', 'ZITADEL_PROJECT_ID=synthetic-project', '--env', 'ZITADEL_API_AUDIENCE=synthetic-api',
        '--env', 'MONGODB_DATABASE=' + storage.db.databaseName, '--env', 'GITHUB_APP_ID=12345',
        '--env', 'CONTENT_ROOT=/data/content/content', '--env', 'AUTH_SECRET_FILE=/run/secrets/auth.secret',
        '--env', 'AUTH_ZITADEL_SECRET_FILE=/run/secrets/oidc.secret', '--env', 'MONGODB_URI_FILE=/run/secrets/mongo.secret',
        '--env', 'GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github.secret', '--env', 'GITHUB_WEBHOOK_SECRET_FILE=/run/secrets/webhook.secret',
        '--env', 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE=/run/secrets/encryption.secret', '--env', 'LIBRARIAN_WORKER_ENABLED=1', appImage]);
      created.push(name);
      if (!contentCopied) {
        docker(['cp', storage.contentRoot, name + ':/data/content']);
        docker(['exec', '--user', '0:0', name, 'chown', '-R', '1001:1001', '/data/content/content']);
        contentCopied = true;
      }
      const port = Number(docker(['port', name, '3000/tcp']).split(':').at(-1));
      if (!Number.isInteger(port) || port < 1) throw new Error('Container port mapping is unavailable');
      const origin = 'http://127.0.0.1:' + port;
      await ready(origin, name, storage.db);
      const limits = docker(['inspect', '--format', '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}', name]);
      expect(limits).toBe('500000000 536870912');
      return { name, origin };
    };

    const first = await start(names[0]);
    expect(await docker(['exec', first.name, 'id', '-u'])).toBe('1001');
    await docker(['exec', first.name, 'touch', '/data/content/.runtime-persist-probe']);
    const firstPage = await fetch(first.origin + '/' + storage.catalog.slug);
    expect(firstPage.status).toBe(200);
    expect(await firstPage.text()).toContain('Synthetic Portal');
    const second = await start(names[1]);
    expect((await fetch(second.origin + '/api/health')).status).toBe(200);
    docker(['stop', second.name]);
    docker(['rm', second.name]);
    created.splice(created.indexOf(second.name), 1);

    docker(['stop', '--time', '10', first.name]);
    docker(['rm', first.name]);
    created.splice(created.indexOf(first.name), 1);
    const rollback = await start(names[0], previousImage);
    const rollbackPage = await fetch(rollback.origin + '/' + storage.catalog.slug);
    expect(rollbackPage.status).toBe(200);
    expect(await rollbackPage.text()).toContain('Synthetic Portal');
    await docker(['exec', rollback.name, 'test', '-f', '/data/content/.runtime-persist-probe']);

    docker(['stop', '--time', '10', rollback.name]);
    docker(['rm', rollback.name]);
    created.splice(created.indexOf(rollback.name), 1);
    const restored = await start(names[0]);
    const restoredPage = await fetch(restored.origin + '/' + storage.catalog.slug);
    expect(restoredPage.status).toBe(200);
    expect(await restoredPage.text()).toContain('Synthetic Portal');
    docker(['restart', '--time', '10', restored.name]);
    const restartedPort = docker(['port', restored.name, '3000/tcp']).split(':').at(-1);
    await ready('http://127.0.0.1:' + restartedPort, restored.name, storage.db);
    docker(['exec', restored.name, 'test', '-f', '/data/content/.runtime-persist-probe']);
  } finally {
    for (const name of created) {
      try { docker(['rm', '--force', name]); } catch { /* Remove only containers created above. */ }
    }
    if (volumeCreated) {
      try { docker(['volume', 'rm', volume]); } catch { /* Remove only the uniquely named test volume. */ }
    }
    await storage.close();
  }
});
