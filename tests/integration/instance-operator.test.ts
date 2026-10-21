import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MongoClient } from 'mongodb';
import { expect, it } from 'vitest';

it('prepares one protected fresh installation and stores only the bootstrap verifier in Mongo', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'librarian-operator-success-'));
  const workspace = resolve(process.cwd());
  const localRoot = resolve(workspace, '.local');
  const instanceRoot = join(localRoot, `instance-operator-success-${randomBytes(8).toString('hex')}`);
  const database = `librarian_test_operator_${randomBytes(6).toString('hex')}`;
  const enrollmentDatabase = `${database}_enroll`;
  const uri = `mongodb://127.0.0.1:27018/${database}`;
  let cleanupClient: MongoClient | undefined;
  try {
    const contentRoot = join(temp, 'content');
    const prereqRoot = join(temp, 'prerequisites');
    await Promise.all([mkdir(contentRoot, { mode: 0o700 }), mkdir(prereqRoot, { mode: 0o700 })]);
    const mongoFile = join(prereqRoot, 'mongo.uri');
    const authFile = join(prereqRoot, 'auth.key');
    const oauthFile = join(prereqRoot, 'oauth.key');
    const authSecret = randomBytes(32).toString('base64url');
    await Promise.all([
      writeFile(mongoFile, uri, { mode: 0o600 }),
      writeFile(authFile, authSecret, { mode: 0o600 }),
      writeFile(oauthFile, randomBytes(32).toString('base64'), { mode: 0o600 }),
    ]);
    const env = { ...process.env, NODE_ENV: 'test', CONTENT_ROOT: contentRoot, MONGODB_DATABASE: database,
      MONGODB_URI_FILE: mongoFile, AUTH_SECRET_FILE: authFile, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: oauthFile };
    const script = resolve(workspace, 'scripts/instance-operator.mjs');
    const coverage = process.env.LIBRARIAN_COVERAGE_PROCESS_DIR
      ? [`--import=${pathToFileURL(resolve('tests/integration/native-coverage-register.mjs')).href}`] : [];
    const invoke = (command: string, root: string, extra: string[] = [], overrides: Partial<NodeJS.ProcessEnv> = {}) => spawnSync(process.execPath,
      [...coverage, script, command, '--root', root, '--origin', 'https://setup.example.test', ...extra], {
        cwd: workspace, env: { ...env, ...overrides } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', windowsHide: true,
      });
    const result = invoke('prepare', instanceRoot);
    expect(result.status, result.stderr).toBe(0);
    const action = JSON.parse(result.stdout) as { actionId?: string };
    expect(action.actionId).toMatch(/^[0-9a-f-]{36}$/);

    const operator = JSON.parse(await readFile(join(instanceRoot, 'instance-operator-auth.json'), 'utf8')) as { instanceId: string; credential: string; expiresAt: string };
    const marker = JSON.parse(await readFile(join(instanceRoot, 'instance-state.json'), 'utf8'));
    const keyring = JSON.parse(await readFile(join(instanceRoot, 'instance-keyring.json'), 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
    const envText = await readFile(join(instanceRoot, 'instance.env'), 'utf8');
    expect(marker).toMatchObject({ instanceId: operator.instanceId, phase: 'sealed', recoveryEpoch: 1 });
    expect(Buffer.from(operator.credential, 'base64url')).toHaveLength(32);
    expect(Date.parse(operator.expiresAt)).toBeGreaterThan(Date.now());
    expect(keyring.keys[keyring.activeKeyId]).toBeTruthy();
    expect(envText).toContain('INSTANCE_ID=' + JSON.stringify(operator.instanceId));
    expect(envText).not.toContain(authSecret);
    expect(envText).not.toContain(operator.credential);
    if (process.platform !== 'win32') {
      expect((await stat(instanceRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(join(instanceRoot, 'instance-operator-auth.json'))).mode & 0o777).toBe(0o600);
    }

    cleanupClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await cleanupClient.connect();
    const control = await cleanupClient.db(database).collection<{ _id: string; instanceId: string; lifecycle: string;
      bootstrap: { verifierHash: string; consumedAt: Date | null } }>('instance_configuration').findOne({ _id: 'instance' });
    expect(control).toMatchObject({ instanceId: operator.instanceId, lifecycle: 'configuring', bootstrap: {
      verifierHash: createHash('sha256').update(operator.credential).digest('hex'), consumedAt: null,
    } });
    expect(JSON.stringify(control)).not.toContain(operator.credential);
    expect(invoke('prepare', instanceRoot).stderr).toContain('operator_storage_not_private');
    expect(invoke('prepare', join(temp, 'second-install')).stderr).toContain('operator_database_not_empty');
    const enrollEnv = { MONGODB_DATABASE: enrollmentDatabase, AUTH_URL: 'https://setup.example.test', AUTH_ZITADEL_ISSUER: 'https://identity.example.test',
      AUTH_ZITADEL_ID: 'synthetic-client', ZITADEL_PROJECT_ID: 'project', ZITADEL_API_AUDIENCE: 'audience', GITHUB_APP_ID: '123' };
    await writeFile(mongoFile, `mongodb://127.0.0.1:27018/${enrollmentDatabase}`);
    const enrollRoot = join(temp, 'enrolled-authority');
    expect(invoke('enroll', enrollRoot, [], enrollEnv).stderr).toContain('operator_invalid_arguments');
    expect(invoke('enroll', enrollRoot, ['--legacy-drained'], { ...enrollEnv, GITHUB_APP_ID: '' }).stderr).toContain('operator_invalid_arguments');
    const legacy = cleanupClient.db(enrollmentDatabase);
    await legacy.collection('catalogs').insertOne({ slug: 'instance' });
    expect(invoke('enroll', enrollRoot, ['--legacy-drained'], enrollEnv).stderr).toContain('operator_invalid_arguments');
    await legacy.collection('catalogs').deleteMany({ slug: 'instance' });
    await mkdir(enrollRoot, { mode: 0o700 });
    const enrolled = invoke('enroll', enrollRoot, ['--legacy-drained'], enrollEnv);
    expect(enrolled.status, enrolled.stderr).toBe(0);
    expect(await legacy.collection<{ _id: string }>('instance_configuration').findOne({ _id: 'instance' })).toMatchObject({
      lifecycle: 'legacy_migrating', migration: { mode: 'import', verificationSummary: ['legacy_drained'] }, bootstrap: { consumedAt: null },
    });
    expect(JSON.parse(await readFile(join(enrollRoot, 'instance-operator-auth.json'), 'utf8')).purpose).toBe('enroll');
    expect(invoke('enroll', join(temp, 'duplicate-enrollment'), ['--legacy-drained'], enrollEnv).stderr).toContain('operator_invalid_arguments');
  } finally {
    try { await cleanupClient?.db(database).dropDatabase(); await cleanupClient?.db(enrollmentDatabase).dropDatabase(); }
    finally {
      await cleanupClient?.close();
      const fromLocal = relative(localRoot, resolve(instanceRoot));
      if (fromLocal && !isAbsolute(fromLocal) && fromLocal !== '..' && !fromLocal.startsWith('..' + sep)) {
        await rm(instanceRoot, { recursive: true, force: true });
      }
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 30_000);
