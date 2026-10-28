import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { prepareInstance } from '../../scripts/instance-operator.mjs';

it('rejects untrusted origins and remote databases before creating host authority', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'librarian-operator-unit-'));
  try {
    const contentRoot = join(temp, 'content');
    const prereqRoot = join(temp, 'prerequisites');
    await Promise.all([mkdir(contentRoot, { mode: 0o700 }), mkdir(prereqRoot, { mode: 0o700 })]);
    const mongoFile = join(prereqRoot, 'mongo.uri');
    const authFile = join(prereqRoot, 'auth.key');
    const oauthFile = join(prereqRoot, 'oauth.key');
    const authSecret = randomBytes(32).toString('base64url');
    await Promise.all([
      writeFile(mongoFile, 'mongodb://127.0.0.1:27018/', { mode: 0o600 }),
      writeFile(authFile, authSecret, { mode: 0o600 }),
      writeFile(oauthFile, randomBytes(32).toString('base64'), { mode: 0o600 }),
    ]);
    const env = {
      ...process.env, NODE_ENV: 'test' as const, AUTH_TRUST_HOST: 'true',
      CONTENT_ROOT: contentRoot, MONGODB_DATABASE: 'librarian_test_operator',
      MONGODB_URI_FILE: mongoFile, AUTH_SECRET_FILE: authFile, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: oauthFile,
    };
    const script = resolve(process.cwd(), 'scripts/instance-operator.mjs');
    const coverage = process.env.LIBRARIAN_COVERAGE_PROCESS_DIR
      ? [`--import=${pathToFileURL(resolve('tests/integration/native-coverage-register.mjs')).href}`] : [];
    const run = (root: string, origin: string, nodeEnv: string = env.NODE_ENV, overrides: Partial<NodeJS.ProcessEnv> = {}) => spawnSync(process.execPath, [...coverage, script, 'prepare', '--root', root, '--origin', origin], {
      cwd: process.cwd(), env: { ...env, NODE_ENV: nodeEnv, ...overrides } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    const originRoot = join(temp, 'bad-origin');
    const originResult = run(originRoot, 'http://setup.example.test');
    expect(originResult.status).not.toBe(0);
    expect(originResult.stderr).toContain('operator_invalid_origin');
    await expect(readdir(originRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    const stagingRoot = join(temp, 'staging-loopback');
    const stagingResult = run(stagingRoot, 'http://127.0.0.1:3200', 'staging');
    expect(stagingResult.stderr).toContain('operator_invalid_origin');
    await expect(readdir(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(mongoFile, 'mongodb://example.invalid:27017/', { mode: 0o600 });
    const databaseRoot = join(temp, 'remote-database');
    const databaseResult = run(databaseRoot, 'https://setup.example.test');
    expect(databaseResult.status).not.toBe(0);
    expect(databaseResult.stderr).toContain('operator_database_not_loopback');
    expect(`${databaseResult.stdout}${databaseResult.stderr}`).not.toContain(authSecret);
    await expect(readdir(databaseRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(authFile, 'utf8')).toBe(authSecret);

    const unignoredRoot = join(process.cwd(), `.operator-unignored-${randomBytes(6).toString('hex')}`);
    const unignoredResult = run(unignoredRoot, 'https://setup.example.test');
    expect(unignoredResult.stderr).toContain('operator_storage_not_ignored');
    await expect(readdir(unignoredRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    const ignoredRoot = join(process.cwd(), '.local', `instance-unit-${randomBytes(6).toString('hex')}`);
    const ignoredResult = run(ignoredRoot, 'https://setup.example.test');
    expect(ignoredResult.stderr).toContain('operator_database_not_loopback');
    await expect(readdir(ignoredRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    for (const origin of ['not-a-url', 'https://user:password@setup.example.test', 'https://setup.example.test/path',
      'https://setup.example.test?query=1', 'https://setup.example.test#fragment', 'https://setup.example.test/']) {
      expect(run(join(temp, 'invalid-origin'), origin).stderr).toContain('operator_invalid_origin');
    }
    await expect(prepareInstance({ root: join(temp, 'invalid-clock'), origin: 'https://setup.example.test', env, now: new Date(NaN) }))
      .rejects.toThrow('operator_invalid_arguments');
    for (const args of [[], ['unknown'], ['prepare'], ['prepare', 'unexpected', '--origin', 'https://setup.example.test'],
      ['prepare', '--unknown'], ['transfer'], ['transfer', '--instance-id', 'synthetic', '--revision', '-1'],
      ['recover', '--instance-id', 'synthetic', '--revision', '9007199254740992'],
      ['rotate-key', '--instance-id', 'synthetic', '--revision', '0', 'unexpected']]) {
      const result = spawnSync(process.execPath, [...coverage, script, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      expect(result.status).toBe(1); expect(result.stderr).toContain('operator_invalid_arguments');
    }
    await writeFile(mongoFile, 'mongodb://127.0.0.1:27018/');
    for (const database of ['', undefined, 'admin', 'local', 'config', 'librarian_dev', 'bad/name']) {
      expect(run(join(temp, 'invalid-database'), 'https://setup.example.test', 'test', { MONGODB_DATABASE: database }).stderr).toContain('operator_invalid_database');
    }
    expect(run(join(contentRoot, 'nested-authority'), 'https://setup.example.test').stderr).toContain('operator_storage_not_private');
    expect(run(join(temp, 'missing-content'), 'https://setup.example.test', 'test', { CONTENT_ROOT: join(temp, 'absent') }).stderr).toContain('operator_host_prerequisite_missing');
    expect(run(join(temp, 'missing-auth'), 'https://setup.example.test', 'test', { AUTH_SECRET_FILE: '' }).stderr).toContain('operator_host_prerequisite_missing');
    expect(run(join(temp, 'directory-auth'), 'https://setup.example.test', 'test', { AUTH_SECRET_FILE: prereqRoot }).stderr).toContain('operator_host_prerequisite_missing');
    expect(run(join(temp, 'file-content'), 'https://setup.example.test', 'test', { CONTENT_ROOT: authFile }).stderr).toContain('operator_host_prerequisite_missing');
    const misplacedKey = join(contentRoot, 'synthetic-auth.key'); await writeFile(misplacedKey, authSecret, { mode: 0o600 });
    expect(run(join(temp, 'misplaced-auth'), 'https://setup.example.test', 'test', { AUTH_SECRET_FILE: misplacedKey }).stderr).toContain('operator_storage_not_private');
    const destinationFile = join(temp, 'destination-file'); await writeFile(destinationFile, 'synthetic');
    for (const destination of [destinationFile, join(destinationFile, 'child'), join(process.cwd(), '.next', 'operator-unit')]) {
      expect(run(destination, 'https://setup.example.test').stderr, destination).toContain('operator_storage_not_private');
    }
    const linkedRoot = join(temp, 'linked-root'); await symlink(contentRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    expect(run(linkedRoot, 'https://setup.example.test').stderr).toContain('operator_storage_not_private');
    for (const value of ['', 'short', 'x'.repeat(65537)]) {
      await writeFile(authFile, value);
      expect(run(join(temp, 'invalid-auth'), 'https://setup.example.test').stderr).toContain('operator_host_prerequisite_missing');
    }
    await writeFile(authFile, authSecret);
    await writeFile(oauthFile, 'not-a-key');
    expect(run(join(temp, 'invalid-oauth'), 'https://setup.example.test').stderr).toContain('operator_host_prerequisite_missing');
    await writeFile(oauthFile, randomBytes(32).toString('base64'));
    for (const [uri, code] of [['not-a-uri', 'operator_host_prerequisite_missing'],
      ['mongodb://127.0.0.1:27018/different_database', 'operator_invalid_database'],
      ['mongodb://127.0.0.1:27018,127.0.0.1:27019/', 'operator_database_not_loopback']]) {
      await writeFile(mongoFile, uri);
      expect(run(join(temp, 'invalid-uri'), 'https://setup.example.test').stderr).toContain(code);
    }
    await writeFile(mongoFile, 'mongodb://127.0.0.1:1/');
    expect(run(join(temp, 'unavailable-database'), 'https://setup.example.test').stderr).toContain('operator_storage_unavailable');

    if (process.platform !== 'win32') {
      await chmod(authFile, 0o644);
      const privateFileRoot = join(temp, 'insecure-prerequisite');
      const privateFileResult = run(privateFileRoot, 'https://setup.example.test');
      expect(privateFileResult.stderr).toContain('operator_host_prerequisite_missing');
      await expect(readdir(privateFileRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await chmod(authFile, 0o600);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 120_000);

it('keeps named DEV enrollment opt-in, exact-target-gated and development-only before connecting', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'librarian-operator-dev-'));
  try {
    const contentRoot = join(temp, 'content');
    const prereqRoot = join(temp, 'prerequisites');
    await Promise.all([mkdir(contentRoot), mkdir(prereqRoot)]);
    const mongoFile = join(prereqRoot, 'mongo.uri');
    const authFile = join(prereqRoot, 'auth.key');
    const oauthFile = join(prereqRoot, 'oauth.key');
    await Promise.all([
      writeFile(mongoFile, 'mongodb://127.0.0.1:27018/librarian_dev', { mode: 0o600 }),
      writeFile(authFile, randomBytes(32).toString('base64url'), { mode: 0o600 }),
      writeFile(oauthFile, randomBytes(32).toString('base64'), { mode: 0o600 }),
    ]);
    const env = { NODE_ENV: 'development', CONTENT_ROOT: contentRoot, MONGODB_DATABASE: 'librarian_dev',
      MONGODB_URI_FILE: mongoFile, AUTH_SECRET_FILE: authFile, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: oauthFile } as NodeJS.ProcessEnv;
    const target = { host: '127.0.0.1', database: 'librarian_dev' };
    const attempt = (name: string, overrides: Partial<NodeJS.ProcessEnv>, mode: 'prepare' | 'enroll' = 'enroll', devTarget = target) =>
      prepareInstance({ root: join(temp, name), origin: 'https://setup.example.test', env: { ...env, ...overrides }, mode,
        legacyDrained: true, devTarget });

    await expect(attempt('wrong-host', {}, 'enroll', { ...target, host: 'other.example.test' })).rejects.toThrow('operator_invalid_database');
    await expect(attempt('wrong-mode', {}, 'prepare')).rejects.toThrow('operator_invalid_arguments');
    await expect(attempt('wrong-environment', { NODE_ENV: 'test' })).rejects.toThrow('operator_invalid_database');
    await expect(attempt('wrong-database', { MONGODB_DATABASE: 'other_database' })).rejects.toThrow('operator_invalid_database');
    await writeFile(mongoFile, 'mongodb+srv://cluster.example.test/librarian_dev');
    await expect(attempt('srv-target', {}, 'enroll', { ...target, host: 'cluster.example.test' })).rejects.toThrow('operator_invalid_database');
    await writeFile(mongoFile, 'mongodb://127.0.0.1:27018,127.0.0.1:27019/librarian_dev');
    await expect(attempt('multi-host-target', {})).rejects.toThrow('operator_invalid_database');
    for (const name of ['wrong-host', 'wrong-mode', 'wrong-environment', 'wrong-database', 'srv-target', 'multi-host-target']) {
      await expect(readdir(join(temp, name))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
}, 30_000);
