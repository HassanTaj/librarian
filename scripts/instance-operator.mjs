import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';

const run = promisify(execFile);
const hour = 60 * 60 * 1000;
const safeErrors = new Set([
  'operator_invalid_arguments', 'operator_invalid_origin', 'operator_invalid_database', 'operator_database_not_loopback',
  'operator_database_not_empty', 'operator_host_prerequisite_missing', 'operator_storage_not_ignored',
  'operator_storage_not_private', 'operator_storage_unavailable', 'operator_prepare_interrupted',
  'operator_revision_conflict', 'operator_verified_proof_required', 'operator_maintenance_pending', 'operator_keyring_limit',
]);

function fail(code) { throw new Error(code); }

function inside(path, parent) {
  const child = relative(parent, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function samePath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function canonicalDestination(path) {
  const missing = [];
  let current = resolve(path);
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || missing.length > 0 && !info.isDirectory()) fail('operator_storage_not_private');
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        const parent = dirname(current);
        if (parent === current) fail('operator_storage_not_private');
        missing.unshift(basename(current));
        current = parent;
      } else if (error instanceof Error && safeErrors.has(error.message)) throw error;
      else fail('operator_storage_not_private');
    }
  }
}

function validateSetupOrigin(value, nodeEnv = process.env.NODE_ENV) {
  try {
    const url = new URL(value);
    const loopbackHttp = ['development', 'test'].includes(nodeEnv) && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (url.protocol !== 'https:' && !loopbackHttp)) fail('operator_invalid_origin');
    return url.origin;
  } catch { fail('operator_invalid_origin'); }
}

async function protectedValue(env, setting, cwd, forbiddenRoots) {
  try {
    if (!env[setting]) fail('operator_host_prerequisite_missing');
    const file = resolve(cwd, env[setting]);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || (process.platform !== 'win32' && (info.mode & 0o077))) fail('operator_host_prerequisite_missing');
    const actual = await realpath(file);
    if (forbiddenRoots.some(root => inside(actual, root))) fail('operator_storage_not_private');
    const value = (await readFile(actual, 'utf8')).trim();
    if (!value || Buffer.byteLength(value) > 64 * 1024) fail('operator_host_prerequisite_missing');
    return value;
  } catch (error) {
    if (error instanceof Error && safeErrors.has(error.message)) throw error;
    fail('operator_host_prerequisite_missing');
  }
}

async function hostPrerequisites(env, cwd, root) {
  const database = env.MONGODB_DATABASE;
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(database ?? '') || ['admin', 'local', 'config', 'librarian_dev'].includes(database)) fail('operator_invalid_database');
  let contentRoot;
  let publicRoot;
  try {
    contentRoot = await realpath(resolve(cwd, env.CONTENT_ROOT ?? ''));
    if (!(await stat(contentRoot)).isDirectory()) fail('operator_host_prerequisite_missing');
    publicRoot = await realpath(resolve(cwd, 'public')).catch(() => resolve(cwd, 'public'));
  } catch { fail('operator_host_prerequisite_missing'); }
  if (inside(root, contentRoot) || inside(contentRoot, root) || inside(root, publicRoot) || inside(publicRoot, root) || inside(resolve(cwd), root)) fail('operator_storage_not_private');
  const forbidden = [contentRoot, publicRoot, root];
  const [uri, authSecret, oauthSecret] = await Promise.all([
    protectedValue(env, 'MONGODB_URI_FILE', cwd, forbidden),
    protectedValue(env, 'AUTH_SECRET_FILE', cwd, forbidden),
    protectedValue(env, 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE', cwd, forbidden),
  ]);
  if (Buffer.byteLength(authSecret) < 32) fail('operator_host_prerequisite_missing');
  const oauthKey = Buffer.from(oauthSecret, 'base64');
  if (oauthKey.length !== 32 || oauthKey.toString('base64') !== oauthSecret) fail('operator_host_prerequisite_missing');
  let client;
  try { client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 5000 }); }
  catch { fail('operator_host_prerequisite_missing'); }
  const uriPath = uri.replace(/^mongodb(?:\+srv)?:\/\/[^/]+/, '').split('?')[0];
  if (uriPath && uriPath !== '/' && client.options.dbName !== database) fail('operator_invalid_database');
  const hosts = client.options.hosts;
  if (client.options.srvHost || hosts.length !== 1 || !['127.0.0.1', '::1'].includes(hosts[0].host)) fail('operator_database_not_loopback');
  return { client, database, contentRoot, publicRoot, authSecret, oauthKey };
}

async function assertSafeDestination(root, cwd) {
  try {
    const repo = (await run('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true })).stdout.trim();
    if (!repo || !inside(root, repo)) return;
    const path = relative(repo, root).split(sep).join('/');
    await run('git', ['check-ignore', '--quiet', '--no-index', '--', path], { cwd: repo, windowsHide: true });
    if (!path.startsWith('.local/')) fail('operator_storage_not_private');
    const dockerIgnore = await readFile(resolve(repo, '.dockerignore'), 'utf8');
    if (!dockerIgnore.split(/\r?\n/).some(line => line.trim() === '**/.local/**' || line.trim() === '/.local/')) fail('operator_storage_not_private');
  } catch (error) {
    if (error instanceof Error && safeErrors.has(error.message)) throw error;
    fail('operator_storage_not_ignored');
  }
}

async function inspectEmptyDirectory(root) {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(root)).length) fail('operator_storage_not_private');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    if (error instanceof Error && safeErrors.has(error.message)) throw error;
    fail('operator_storage_not_private');
  }
}

async function protectDirectory(root) {
  try {
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    const parent = await realpath(dirname(root));
    if (!samePath(parent, dirname(root))) fail('operator_storage_not_private');
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(root)).length) fail('operator_storage_not_private');
    } else if (error instanceof Error && safeErrors.has(error.message)) throw error;
    else fail('operator_storage_not_private');
  }
  try {
    if (process.platform === 'win32') {
      const user = (await run('whoami', [], { windowsHide: true })).stdout.trim();
      await run('icacls', [root, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
    } else await chmod(root, 0o700);
  } catch { fail('operator_storage_not_private'); }
}

async function writeProtected(root, name, value) {
  const handle = await open(resolve(root, name), 'wx', 0o600);
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

async function syncDirectory(root) {
  if (process.platform === 'win32') return;
  const handle = await open(root, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function databaseIsEmpty(db) {
  try {
    const collections = await db.listCollections({}, { nameOnly: true, maxTimeMS: 1000 }).toArray();
    return collections.length <= 64 && collections.every(({ name }) => name.startsWith('system.'));
  } catch { fail('operator_storage_unavailable'); }
}

export async function prepareInstance({ root = '.local/instance', origin, env = process.env, cwd = process.cwd(), now = new Date(), mode = 'prepare', legacyDrained = false }) {
  const absoluteRoot = await canonicalDestination(resolve(cwd, root));
  const setupOrigin = validateSetupOrigin(origin, env.NODE_ENV);
  if (!Number.isFinite(now.getTime())) fail('operator_invalid_arguments');
  await assertSafeDestination(absoluteRoot, cwd);
  await inspectEmptyDirectory(absoluteRoot);
  const host = await hostPrerequisites(env, cwd, absoluteRoot);
  const client = host.client;
  try {
    await client.connect();
    const db = client.db(host.database, { writeConcern: { w: 1, j: true } });
    const hello = await db.command({ hello: 1, maxTimeMS: 1000 }).catch(() => null);
    if (!hello?.isWritablePrimary || hello.maxWireVersion < 13) fail('operator_storage_unavailable');
    if (!['prepare', 'enroll'].includes(mode)) fail('operator_invalid_arguments');
    if (mode === 'prepare' && !(await databaseIsEmpty(db))) fail('operator_database_not_empty');
    if (mode === 'enroll' && (!legacyDrained || await db.collection('instance_configuration').findOne({ _id: 'instance' }) || !['AUTH_URL', 'AUTH_ZITADEL_ISSUER', 'AUTH_ZITADEL_ID', 'ZITADEL_PROJECT_ID', 'ZITADEL_API_AUDIENCE', 'GITHUB_APP_ID'].every(key => typeof env[key] === 'string' && env[key].length > 0))) fail('operator_invalid_arguments');
    if (mode === 'enroll' && await db.collection('catalogs').findOne({ slug: 'instance' })) fail('operator_invalid_arguments');

    await protectDirectory(absoluteRoot);
    const instanceId = randomUUID();
    const keyId = randomUUID();
    let rootKey = randomBytes(32);
    while (rootKey.equals(host.oauthKey) || rootKey.equals(Buffer.from(host.authSecret)) || rootKey.toString('base64url') === host.authSecret) rootKey = randomBytes(32);
    const issuedAt = new Date(now);
    const expiresAt = new Date(issuedAt.getTime() + 24 * hour);
    const credential = randomBytes(32).toString('base64url');
    const verifierHash = createHash('sha256').update(credential).digest('hex');
    await writeProtected(absoluteRoot, 'instance-keyring.json', JSON.stringify({ activeKeyId: keyId, keys: { [keyId]: rootKey.toString('base64') } }));
    await writeProtected(absoluteRoot, 'instance-operator-auth.json', JSON.stringify({ instanceId, purpose: mode === 'enroll' ? 'enroll' : 'bootstrap', epoch: 1, credential, expiresAt: expiresAt.toISOString() }));
    const envFile = {
      INSTANCE_ID: instanceId,
      INSTANCE_SETUP_ORIGIN: setupOrigin,
      INSTANCE_STATE_FILE: resolve(absoluteRoot, 'instance-state.json'),
      INSTANCE_KEYRING_FILE: resolve(absoluteRoot, 'instance-keyring.json'),
      INSTANCE_OPERATOR_AUTH_FILE: resolve(absoluteRoot, 'instance-operator-auth.json'),
    };
    await writeProtected(absoluteRoot, 'instance.env', Object.entries(envFile).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
    await syncDirectory(absoluteRoot);
    await writeProtected(absoluteRoot, 'instance-state.json', JSON.stringify({ instanceId, phase: 'sealed', recoveryEpoch: 1 }));
    await syncDirectory(absoluteRoot);

    const control = {
      _id: 'instance', instanceId, schemaVersion: 1, revision: 0, editRevision: 0, nextBundleVersion: 1,
      lifecycle: mode === 'enroll' ? 'legacy_migrating' : 'configuring', createdAt: issuedAt, updatedAt: issuedAt, initializedAt: null,
      bootstrap: { epoch: 1, verifierHash, expiresAt, consumedAt: null, sessionSlots: [] },
      securityEpoch: 1, recoveryEpoch: 1, active: null, previous: null, candidate: null, administrators: [],
      gate: { state: 'open', activationId: null, deadline: null }, admissions: [], activation: null, auditOutbox: [], migration: mode === 'enroll' ? { sourceDigest: createHash('sha256').update(instanceId).digest('hex'), mode: 'import', at: issuedAt, verificationSummary: ['legacy_drained'] } : null,
    };
    try { await db.collection('instance_configuration').insertOne(control); }
    catch { fail('operator_prepare_interrupted'); }
    return { actionId: randomUUID() };
  } catch (error) {
    if (error instanceof Error && safeErrors.has(error.message)) throw error;
    fail('operator_storage_unavailable');
  } finally { await client.close(); }
}

async function main() {
  try {
    const command = process.argv[2];
    if (!['prepare', 'enroll', 'transfer', 'recover', 'rotate-key'].includes(command)) fail('operator_invalid_arguments');
    if (['transfer', 'recover', 'rotate-key'].includes(command)) {
      const { values, positionals } = parseArgs({ args: process.argv.slice(3), options: {
        'instance-id': { type: 'string' }, revision: { type: 'string' }, 'proof-id': { type: 'string' }, 'processes-stopped': { type: 'boolean' }, authorize: { type: 'boolean' },
      }, strict: true, allowPositionals: true });
      if (positionals.length || !values['instance-id'] || !/^(0|[1-9]\d*)$/.test(values.revision ?? '') || !Number.isSafeInteger(Number(values.revision))) fail('operator_invalid_arguments');
      const result = await maintainInstance({ command, instanceId: values['instance-id'], revision: Number(values.revision), proofId: values['proof-id'], processesStopped: values['processes-stopped'], authorize: values.authorize });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const { values, positionals } = parseArgs({ args: process.argv.slice(3), options: { root: { type: 'string' }, origin: { type: 'string' }, 'legacy-drained': { type: 'boolean' } }, strict: true, allowPositionals: true });
    if (positionals.length || !values.origin) fail('operator_invalid_arguments');
    const result = await prepareInstance({ root: values.root, origin: values.origin, mode: command, legacyDrained: values['legacy-drained'] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof Error && safeErrors.has(error.message) ? error.message : 'operator_invalid_arguments';
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  }
}

export async function maintainInstance({ command, instanceId, revision, proofId, processesStopped, authorize = false, env = process.env, cwd = process.cwd() }) {
  // Native TypeScript stripping needs extension resolution only for this checkout's server modules.
  const libRoot = new URL('../lib/', import.meta.url).href;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(libRoot) && /^\.{1,2}\//.test(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  } });
  let storage;
  try {
    const [{ readInstanceHost }, { connectMongo }, { readInstance, updateInstance }, { beginInstanceKeyRotation, rotateInstanceBundles, serializeInstanceKeyring, verifyInstanceBundles }, { LIMITS }] = await Promise.all([
      import('../lib/instance/bootstrap.ts'), import('../lib/mongo.ts'), import('../lib/instance/store.ts'), import('../lib/instance/secrets.ts'), import('../lib/limits.ts'),
    ]);
    const host = await readInstanceHost(env, cwd);
    if (host.instanceId !== instanceId || host.operator.purpose !== command || !processesStopped) fail('operator_invalid_arguments');
    storage = await connectMongo(host.config, { initializeLegacy: false });
    let current = await readInstance(storage.db, instanceId);
    if (!current || !current.initializedAt || !current.bootstrap.consumedAt || !current.active || current.activation && !(command === 'recover' && authorize)) fail('operator_revision_conflict');
    const rotationResume = command === 'rotate-key' && host.keyring.rotation?.baseRevision === revision && current.revision >= revision &&
      ((current.lifecycle === 'ready' && current.gate.state === 'open') || (current.lifecycle === 'maintenance' && current.gate.state === 'maintenance'));
    if (current.revision !== revision && !rotationResume) fail('operator_revision_conflict');
    if (Date.parse(host.operator.expiresAt) <= Date.now() && !rotationResume) fail('operator_invalid_arguments');
    if (current.recoveryEpoch !== host.marker.recoveryEpoch && !(command === 'recover' && host.marker.recoveryEpoch === current.recoveryEpoch + 1)) fail('operator_revision_conflict');
    if (host.keyring.rotation && command !== 'rotate-key') fail('operator_maintenance_pending');
    const now = new Date();
    const actionId = randomUUID();
    async function replaceProtected(path, value) {
      const target = resolve(cwd, path);
      const temporary = `${target}.${actionId}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      await syncDirectory(dirname(target));
    }
    if (command === 'recover' && authorize) {
      if (current.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox) fail('operator_maintenance_pending');
      const recoveryEpoch = host.marker.recoveryEpoch === current.recoveryEpoch ? current.recoveryEpoch + 1 : host.marker.recoveryEpoch;
      if (!Number.isSafeInteger(recoveryEpoch)) fail('operator_invalid_arguments');
      const credential = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + hour);
      await replaceProtected(env.INSTANCE_OPERATOR_AUTH_FILE, { instanceId, purpose: 'recover', epoch: recoveryEpoch, credential, expiresAt: expiresAt.toISOString() });
      await replaceProtected(env.INSTANCE_STATE_FILE, { instanceId, phase: 'initialized', recoveryEpoch });
      const candidate = { ...structuredClone(current.active), version: current.nextBundleVersion, createdAt: now, createdBy: actionId,
        checks: [], ownerProof: null, previousUntil: null, impact: { categories: [], securityEpochIncrement: false, revalidateSources: false, confirmationNonce: randomUUID() } };
      const next = await updateInstance(storage.db, instanceId, current.revision, value => ({ ...value,
        lifecycle: 'maintenance', gate: { state: 'maintenance', activationId: null, deadline: null }, activation: null, admissions: [],
        recoveryEpoch, securityEpoch: value.securityEpoch + 1, candidate, nextBundleVersion: value.nextBundleVersion + 1,
        bootstrap: { ...value.bootstrap, epoch: value.bootstrap.epoch + 1, verifierHash: createHash('sha256').update(credential).digest('hex'), expiresAt, sessionSlots: [] },
        auditOutbox: [...value.auditOutbox, { _id: randomUUID(), instanceId, at: now, actor: actionId, operation: 'recovered',
          fromVersion: value.active.version, toVersion: value.active.version, resultCode: 'target_verification_pending', requestId: actionId }],
      }), now);
      return { actionId, revision: next.revision, result: 'target_verification_pending' };
    }
    if (command === 'rotate-key') {
      const rotationCommitted = host.keyring.rotation && current.lifecycle === 'ready' &&
        (current.auditOutbox.some(event => event.requestId === host.keyring.rotation.id && event.operation === 'key_rotated' && event.resultCode === 'accepted') ||
          await storage.db.collection('instance_audit_events').findOne({ instanceId, requestId: host.keyring.rotation.id, operation: 'key_rotated', resultCode: 'accepted' }, { projection: { _id: 1 }, maxTimeMS: 1000 }));
      if (rotationCommitted) {
        verifyInstanceBundles(current, host.keyring);
        await replaceProtected(env.INSTANCE_KEYRING_FILE, serializeInstanceKeyring(host.keyring, false));
        const verifiedHost = await readInstanceHost(env, cwd, now);
        verifyInstanceBundles(current, verifiedHost.keyring);
        return { actionId, revision: current.revision, result: 'key_rotated' };
      }
      if (host.keyring.rotation && host.keyring.rotation.baseRevision !== revision) fail('operator_revision_conflict');
      if (current.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox) fail('operator_maintenance_pending');
      let keyring = host.keyring;
      if (!keyring.rotation) {
        const encodedAuthKey = Buffer.from(host.config.authSecret, 'base64url');
        const excludedKeys = [host.config.oauthTokenEncryptionKey, Buffer.from(host.config.authSecret),
          ...(encodedAuthKey.toString('base64url') === host.config.authSecret ? [encodedAuthKey] : [])];
        try { keyring = beginInstanceKeyRotation(keyring, current.revision, excludedKeys, now); }
        catch (error) { if (error instanceof Error && error.message === 'instance_keyring_full') fail('operator_keyring_limit'); throw error; }
        await replaceProtected(env.INSTANCE_KEYRING_FILE, serializeInstanceKeyring(keyring));
      }
      if (current.lifecycle !== 'maintenance') {
        if (current.lifecycle !== 'ready' || current.gate.state !== 'open') fail('operator_maintenance_pending');
        current = await updateInstance(storage.db, instanceId, current.revision, value => ({ ...value, lifecycle: 'maintenance',
          gate: { state: 'maintenance', activationId: null, deadline: null }, admissions: [] }), now);
      } else if (current.gate.state !== 'maintenance') fail('operator_maintenance_pending');
      const durableHost = await readInstanceHost(env, cwd, now);
      if (!durableHost.keyring.rotation || durableHost.keyring.rotation.id !== keyring.rotation?.id || durableHost.keyring.rotation.baseRevision !== revision ||
          durableHost.keyring.activeKeyId !== keyring.activeKeyId) fail('operator_storage_unavailable');
      const bundles = rotateInstanceBundles(current, durableHost.keyring, now);
      current = await updateInstance(storage.db, instanceId, current.revision, value => ({ ...value, ...bundles }), now);
      const persisted = await readInstance(storage.db, instanceId);
      if (!persisted || persisted.lifecycle !== 'maintenance' || persisted.gate.state !== 'maintenance' || persisted.revision !== current.revision) fail('operator_storage_unavailable');
      verifyInstanceBundles(persisted, durableHost.keyring);
      const next = await updateInstance(storage.db, instanceId, current.revision, value => ({ ...value,
        lifecycle: 'ready', gate: { state: 'open', activationId: null, deadline: null },
        auditOutbox: [...value.auditOutbox, { _id: randomUUID(), instanceId, at: now, actor: actionId, operation: 'key_rotated',
          fromVersion: value.active.version, toVersion: value.active.version, resultCode: 'accepted', requestId: durableHost.keyring.rotation.id }],
      }), now);
      verifyInstanceBundles(next, durableHost.keyring);
      await replaceProtected(env.INSTANCE_KEYRING_FILE, serializeInstanceKeyring(durableHost.keyring, false));
      const verifiedHost = await readInstanceHost(env, cwd, now);
      verifyInstanceBundles(next, verifiedHost.keyring);
      return { actionId, revision: next.revision, result: 'key_rotated' };
    }
    const proof = current.candidate?.ownerProof;
    if (!proof || proof.nonce !== proofId || proof.instanceId !== instanceId || proof.expiresAt <= now || proof.securityEpoch !== current.securityEpoch ||
        proof.issuer !== current.active.zitadel.issuer || proof.projectId !== current.active.zitadel.projectId) fail('operator_verified_proof_required');
    async function verifiedRole(identity) {
      const role = await storage.db.collection('identity_authorizations').findOne({ issuer: identity.issuer, subject: identity.subject, projectId: identity.projectId });
      return role?.verifiedAt instanceof Date && role.verifiedAt <= now && now - role.verifiedAt < 15 * 60_000 && Array.isArray(role.roles) && role.roles.includes('librarian-instance-admin');
    }
    if (!await verifiedRole(proof)) fail('operator_verified_proof_required');
    const owner = current.administrators.find(item => item.kind === 'owner' && item.status === 'active');
    if (!owner || command === 'transfer' && !await verifiedRole(owner)) fail('operator_verified_proof_required');
    if (current.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox) fail('operator_maintenance_pending');
    const recoveryEpoch = current.recoveryEpoch;
    if (command === 'recover' && (current.lifecycle !== 'maintenance' || current.gate.state !== 'maintenance')) fail('operator_invalid_arguments');
    const next = await updateInstance(storage.db, instanceId, current.revision, value => ({ ...value,
      securityEpoch: value.securityEpoch + 1, recoveryEpoch, lifecycle: 'ready', candidate: null, admissions: [],
      gate: { state: 'open', activationId: null, deadline: null },
      administrators: [...value.administrators.map(item => item.status === 'active' ? { ...item, status: 'retired' } : item),
        { bindingId: randomUUID(), issuer: proof.issuer, subject: proof.subject, projectId: proof.projectId, kind: 'owner', status: 'active', boundAt: now, boundByActionId: actionId }],
      auditOutbox: [...value.auditOutbox, { _id: randomUUID(), instanceId, at: now, actor: actionId, operation: command === 'transfer' ? 'owner_transferred' : 'recovered',
        fromVersion: value.active.version, toVersion: value.active.version, resultCode: 'accepted', requestId: actionId }],
    }), now);
    return { actionId, revision: next.revision, result: command === 'transfer' ? 'owner_transferred' : 'recovered' };
  } catch (error) {
    if (error instanceof Error && safeErrors.has(error.message)) throw error;
    fail('operator_storage_unavailable');
  } finally { hooks.deregister(); await storage?.client.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
