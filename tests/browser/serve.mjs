import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdir, rm, writeFile, readFile, chmod, access } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { promisify } from 'node:util';
import mongodb from 'mongodb';

const { BSON, MongoClient, ObjectId } = mongodb;
const { EJSON } = BSON;

const uri = 'mongodb://127.0.0.1:27018';
if (new URL(uri).hostname !== '127.0.0.1') throw new Error('Browser fixture Mongo must be loopback-only');
const id = randomUUID();
const dbName = `librarian_browser_${id.replaceAll('-', '')}`;
const setupDbName = `librarian_browser_setup_${id.replaceAll('-', '')}`;
const root = resolve('.local', `browser-${id}`);
const secrets = join(root, 'secrets');
const contentRoot = join(root, 'content');
const setupRoot = resolve('.local', `browser-setup-${id}`);
const setupSecrets = join(setupRoot, 'secrets');
const setupContentRoot = join(setupRoot, 'content');
const setupOrigin = 'https://localhost:3200';
const browserState = resolve('.local/browser-state.json');
const browsers = ['chromium', 'firefox', 'webkit'];
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10, minPoolSize: 0 });
const run = promisify(execFile);
let server;
let setupServer;
let controlServer;
let setupProvider;
let cleaning;
let stateWritten = false;
let fixtureDb;
let setupDb;
let directoryCatalogs = [];
let setupFixture;

const providerClientId = 'synthetic-instance-client';
const replacementClientId = 'synthetic-instance-client-replacement';
const providerClientSecret = 'SYNTHETIC_ZITADEL_SECRET_SENTINEL';
const providerProjectId = 'synthetic-instance-project';
const providerSubject = 'synthetic-browser-owner';
const providerRole = 'librarian-instance-admin';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = () => randomUUID();

function sealInstanceBundle(bundle, instanceId, keyId, rootKey, now) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', rootKey, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([2, instanceId, 'configuration_bundle', keyId, bundle.version])));
  const ciphertext = Buffer.concat([cipher.update(EJSON.stringify(bundle), 'utf8'), cipher.final()]);
  return { formatVersion: 2, algorithm: 'aes-256-gcm', keyId, bundleVersion: bundle.version, nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), updatedAt: now };
}

function openInstanceBundle(envelope, instanceId, rootKey) {
  const decipher = createDecipheriv('aes-256-gcm', rootKey, Buffer.from(envelope.nonce, 'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify([2, instanceId, 'configuration_bundle', envelope.keyId, envelope.bundleVersion])));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  return EJSON.parse(plaintext.toString('utf8'));
}

async function addProject(db, { slug, title, visibility, repoId, files, links = {}, metadata = [] }, projectRoot = contentRoot) {
  const catalogId = uuid();
  const generationId = uuid();
  const generationRoot = join(projectRoot, catalogId, 'generations', generationId);
  const now = new Date();
  const documents = [];
  const assets = [];
  for (const [path, bytes, type] of files) {
    const target = join(generationRoot, ...path.split('/'));
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, bytes);
    if (type === 'markdown') {
      const frontmatter = /^---\n\{"title":"([^"]+)"(?:,"description":"([^"]*)")?\}\n---\n/.exec(bytes.toString());
      if (!frontmatter) throw new Error('Browser Markdown fixture requires canonical frontmatter');
      documents.push({ path, route: path === 'index.md' ? '' : path.slice(0, -3), title: frontmatter[1], description: frontmatter[2] ?? '', headings: [], links: (links[path] ?? []).map(href => ({ href, image: href.endsWith('.png') })), size: bytes.length, sha256: digest(bytes) });
    } else {
      assets.push({ path, size: bytes.length, sha256: digest(bytes), mime: 'image/png', inline: true });
    }
  }
  const metadataFiles = [];
  for (const [path, bytes] of metadata) {
    const target = join(generationRoot, ...path.split('/'));
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, bytes);
    metadataFiles.push({ path, size: bytes.length, sha256: digest(bytes) });
  }
  const manifest = { formatVersion: 1, complete: true, catalogId, configRevision: 1, generationId,
    commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), fence: 1, completedAt: now.toISOString(), normalizedBytes: 50_000,
    documents, assets, metadata: metadataFiles };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(generationRoot, 'manifest.json'), manifestBytes);
  const syncJobId = `manual:${catalogId}:${uuid()}`;
  await db.collection('catalogs').insertOne({
    _id: catalogId, slug, title, visibility, github: { repositoryId: repoId, installationId: 456, owner: 'synthetic', name: slug, branch: 'main', docsPath: 'docs' },
    publicDescription: `Configured synthetic description for ${title}.`, readerRole: `docs:${slug}:reader`, enabled: true,
    approvalRef: visibility === 'public' ? 'synthetic-owner-approval' : null, accessState: 'ready', configRevision: 1, authEpoch: 1,
    published: { generationId, commitSha: manifest.commitSha, jobId: syncJobId, fence: 1, configRevision: 1,
      manifestDigest: digest(manifestBytes), publishedAt: now }, publicationRevision: 1, retained: [], lease: null, leaseFence: 1,
    readPins: [], admissionReservations: 0, rateWindow: { window: now, count: 0 },
    lastSuccess: { at: now, jobId: syncJobId, commitSha: manifest.commitSha }, lastFailure: null,
    createdAt: now, updatedAt: now,
  });
  return { catalogId, generationId };
}

async function addFailedFirstSyncProject(db) {
  const catalogId = uuid();
  const attemptId = uuid();
  const jobId = `manual:${catalogId}:${attemptId}`;
  const now = new Date();
  const code = 'github_invalid_content';
  await db.collection('catalogs').insertOne({
    _id: catalogId, slug: 'failed-first-sync', title: 'Failed First Sync', visibility: 'public',
    github: { repositoryId: 7, installationId: 456, owner: 'synthetic', name: 'failed-first-sync', branch: 'main', docsPath: 'docs' },
    publicDescription: 'A synthetic documentation source whose first sync failed.', readerRole: 'docs:failed-first-sync:reader',
    enabled: true, approvalRef: 'synthetic-owner-approval', accessState: 'ready', configRevision: 1, authEpoch: 1,
    published: null, publicationRevision: 0, retained: [], lease: null, leaseFence: 0, readPins: [],
    admissionReservations: 0, rateWindow: { window: now, count: 0 }, lastSuccess: null, lastFailure: { at: now, jobId, code },
    createdAt: now, updatedAt: now,
  });
  await db.collection('syncJobs').insertOne({
    _id: jobId, catalogId, configRevision: 1, origin: 'manual', event: 'manual', payloadDigest: createHash('sha256').update('{}').digest('hex'),
    admissionSequence: 1, state: 'failed', requestedAt: now, availableAt: now, attempts: 1, owner: null, fence: 1,
    targetCommit: null, generationId: null, result: { kind: 'failure', code }, completedAt: now, detailExpiresAt: new Date(now.getTime() + 60_000),
  });
}

async function setDirectoryMode(mode) {
  const drop = async name => {
    try { await fixtureDb.dropCollection(name); }
    catch (error) { if (error.code !== 26) throw error; }
  };
  if (!['normal', 'empty', 'storage-error'].includes(mode)) throw new Error('Unknown directory fixture mode');
  await drop('catalogs');
  await drop('directory_storage_error');
  if (mode === 'storage-error') {
    await fixtureDb.collection('directory_storage_error').insertOne({ _id: 'synthetic-storage-error' });
    await fixtureDb.createCollection('catalogs', { viewOn: 'directory_storage_error', pipeline: [
      { $project: { enabled: { $divide: [1, 0] }, accessState: { $literal: 'ready' } } },
    ] });
    return;
  }
  if (mode === 'normal') {
    if (directoryCatalogs.length) await fixtureDb.collection('catalogs').insertMany(directoryCatalogs);
    await fixtureDb.collection('catalogs').createIndexes([
      { key: { slug: 1 }, unique: true, name: 'catalog_slug' },
      { key: { 'github.repositoryId': 1, 'github.branch': 1, 'github.docsPath': 1 }, unique: true, name: 'catalog_source' },
      { key: { enabled: 1, accessState: 1 }, name: 'catalog_directory' },
    ]);
  }
}

function startControlServer() {
  controlServer = createHttpServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/shutdown') {
      response.writeHead(204).end();
      setImmediate(() => void cleanup().then(() => process.exit(0), () => process.exit(1)));
      return;
    }
    if (request.method === 'GET' && request.url === '/setup/bootstrap') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ credential: setupFixture.credential }));
      return;
    }
    if (request.method === 'GET' && request.url === '/setup/state') {
      const control = await setupDb.collection('instance_configuration').findOne({ _id: 'instance' });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({
        lifecycle: control?.lifecycle ?? 'fresh', ownerCount: control?.administrators?.filter(item => item.kind === 'owner' && item.status === 'active').length ?? 0,
        candidateVersion: control?.candidate?.version ?? null,
      }));
      return;
    }
    if (request.method === 'GET' && request.url === '/setup/provider') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ origin: setupProvider.origin }));
      return;
    }
    if (request.method === 'POST' && request.url === '/setup/reset') {
      try {
        await resetSetupFixture();
        response.writeHead(204).end();
      } catch { response.writeHead(500).end(); }
      return;
    }
    if (request.method === 'POST' && request.url === '/migration/prepare-collision') {
      try {
        await resetSetupFixture();
        const now = new Date();
        await setupDb.collection('instance_configuration').updateOne({ _id: 'instance' }, { $set: {
          lifecycle: 'legacy_migrating', updatedAt: now,
          migration: { sourceDigest: 'a'.repeat(64), mode: 'import', at: now, verificationSummary: ['legacy_drained'] },
        } });
        await Promise.all([
          writeFile(setupFixture.files.marker, JSON.stringify({ instanceId: setupFixture.instanceId, phase: 'sealed', recoveryEpoch: 1 }), { mode: 0o600 }),
          writeFile(setupFixture.files.operator, JSON.stringify({ instanceId: setupFixture.instanceId, purpose: 'enroll', epoch: 1,
            credential: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }), { mode: 0o600 }),
        ]);
        const markdown = (title, body) => Buffer.from(`---\n{"title":"${title}"}\n---\n${body}`);
        await addProject(setupDb, { slug: 'instance', title: 'Legacy Instance Catalog', visibility: 'public', repoId: 901,
          files: [['index.md', markdown('Legacy Instance Catalog', '# Existing instance catalog'), 'markdown'],
            ['setup.md', markdown('Legacy Setup Route', '# Preserved setup document'), 'markdown'],
            ['settings.md', markdown('Legacy Settings Route', '# Preserved settings document'), 'markdown']],
        }, setupContentRoot);
        await restartSetupServer();
        response.writeHead(204).end();
      } catch { response.writeHead(500).end(); }
      return;
    }
    if (request.method === 'POST' && request.url === '/settings/ready') {
      try {
        const tokens = await seedReadySettingsFixture();
        await restartSetupServer();
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(tokens));
      } catch { response.writeHead(500).end(); }
      return;
    }
    if (request.method === 'POST' && request.url === '/recovery/prepare') {
      try {
        const recoveryCredential = randomBytes(32).toString('base64url');
        await seedReadySettingsFixture();
        const current = await setupDb.collection('instance_configuration').findOne({ _id: 'instance' });
        const now = new Date();
        const keyring = JSON.parse(await readFile(setupFixture.files.keyring, 'utf8'));
        const rootKey = Buffer.from(keyring.keys[keyring.activeKeyId], 'base64');
        const candidate = openInstanceBundle(current.active.configuration, setupFixture.instanceId, rootKey);
        candidate.version = current.nextBundleVersion;
        candidate.createdAt = now;
        candidate.createdBy = 'synthetic-recovery';
        candidate.ownerProof = null;
        candidate.checks = [];
        candidate.impact = null;
        const recoveryEpoch = current.recoveryEpoch + 1;
        await setupDb.collection('instance_configuration').updateOne({ _id: 'instance', revision: current.revision }, { $set: {
          lifecycle: 'maintenance', updatedAt: now, securityEpoch: current.securityEpoch + 1, recoveryEpoch,
          bootstrap: { ...current.bootstrap, verifierHash: digest(recoveryCredential) },
          gate: { state: 'maintenance', activationId: null, deadline: null }, candidate: { version: candidate.version,
            configuration: sealInstanceBundle(candidate, setupFixture.instanceId, keyring.activeKeyId, rootKey, now) },
          nextBundleVersion: candidate.version + 1,
        } });
        await Promise.all([
          writeFile(setupFixture.files.marker, JSON.stringify({ instanceId: setupFixture.instanceId, phase: 'initialized', recoveryEpoch }), { mode: 0o600 }),
          writeFile(setupFixture.files.operator, JSON.stringify({ instanceId: setupFixture.instanceId, purpose: 'recover', epoch: recoveryEpoch,
            credential: recoveryCredential, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }), { mode: 0o600 }),
        ]);
        await restartSetupServer();
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ recoveryCredential }));
      } catch { response.writeHead(500).end(); }
      return;
    }
    if (request.method === 'GET' && request.url === '/settings/state') {
      try {
        const control = await setupDb.collection('instance_configuration').findOne({ _id: 'instance' });
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({
          state: control?.lifecycle, activeVersion: control?.active?.version ?? null, candidateVersion: control?.candidate?.version ?? null,
          activationPhase: control?.activation?.phase ?? null, securityEpoch: control?.securityEpoch, gate: control?.gate?.state ?? null,
        }));
      } catch { response.writeHead(500).end(); }
      return;
    }
    if (request.method === 'POST' && request.url === '/settings/add-request-pin') {
      try {
        const control = await setupDb.collection('instance_configuration').findOne({ _id: 'instance' });
        const now = new Date();
        const pin = { id: uuid(), bundleVersion: control.active.version, securityEpoch: control.securityEpoch, recoveryEpoch: control.recoveryEpoch,
          purpose: 'request', createdAt: now, expiresAt: new Date(now.getTime() + 20_000) };
        const updated = await setupDb.collection('instance_configuration').updateOne({ _id: 'instance', revision: control.revision }, {
          $set: { admissions: [...control.admissions, pin], updatedAt: now }, $inc: { revision: 1 },
        }, { writeConcern: { w: 1, j: true } });
        if (updated.modifiedCount !== 1) throw new Error('Fixture state changed');
        response.writeHead(204).end();
      } catch { response.writeHead(500).end(); }
      return;
    }
    if (request.method === 'POST' && request.url === '/settings/reset-check-limits') {
      try {
        await setupDb.collection('instance_rate_buckets').deleteMany({});
        response.writeHead(204).end();
      } catch { response.writeHead(500).end(); }
      return;
    }
    if (request.method === 'POST' && request.url === '/setup/expire-sessions') {
      try {
        const expiredAt = new Date(Date.now() - 1000);
        const result = await setupDb.collection('instance_setup_sessions').updateMany({}, {
          $set: { expiresAt: expiredAt, purgeAt: new Date(expiredAt.getTime() + 60 * 60_000) },
        });
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ expired: result.modifiedCount }));
      } catch { response.writeHead(500).end(); }
      return;
    }
    if (request.method === 'POST' && request.url === '/setup/restart') {
      try {
        await restartSetupServer();
        response.writeHead(204).end();
      } catch { response.writeHead(500).end(); }
      return;
    }
    const mode = /^\/directory\/(normal|empty|storage-error)$/.exec(request.url ?? '')?.[1];
    if (request.method !== 'POST' || !mode) {
      response.writeHead(404).end();
      return;
    }
    try {
      await setDirectoryMode(mode);
      response.writeHead(204).end();
    } catch {
      response.writeHead(500).end();
    }
  });
  controlServer.listen(3101, '127.0.0.1');
}

async function opensslCommand() {
  if (process.platform !== 'win32') return 'openssl';
  const executable = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe');
  await access(executable);
  return executable;
}

async function createProviderCertificate() {
  const certificate = join(setupSecrets, 'provider-ca.pem');
  const key = join(setupSecrets, 'provider.key');
  const pfx = join(setupSecrets, 'provider.pfx');
  const password = randomBytes(32).toString('base64url');
  const openssl = await opensslCommand();
  await run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], {
    windowsHide: true, maxBuffer: 1024 * 1024,
  });
  await run(openssl, ['pkcs12', '-export', '-out', pfx, '-inkey', key, '-in', certificate, '-passout', 'env:BROWSER_SETUP_PROVIDER_PASSWORD'], {
    windowsHide: true, maxBuffer: 1024 * 1024,
    env: { ...process.env, BROWSER_SETUP_PROVIDER_PASSWORD: password },
  });
  return { certificate, key, pfx, password };
}

async function createSyntheticProvider(cert) {
  const addresses = [...new Set((await dnsLookup('localhost', { all: true, verbatim: true })).map(({ address }) => address))];
  if (!addresses.length) throw new Error('Synthetic provider hostname unavailable');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = uuid();
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const codes = new Map();
  const tokens = new Map();
  let origin;

  function json(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  function jwt(claims) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  }

  function authorize(url) {
    const clientId = url.searchParams.get('client_id');
    if (url.origin !== origin || url.pathname !== '/authorize' || ![providerClientId, replacementClientId].includes(clientId) ||
        url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('authorization_request_invalid');
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
    const state = url.searchParams.get('state');
    const nonce = url.searchParams.get('nonce');
    const challenge = url.searchParams.get('code_challenge');
    if (redirect.origin !== setupOrigin) throw new Error('callback_origin_invalid');
    if (redirect.pathname !== '/api/instance/auth/callback/zitadel') throw new Error('callback_path_invalid');
    if (!state || !nonce || !challenge) throw new Error('oauth_binding_missing');
    const code = uuid();
    codes.set(code, { nonce, challenge, redirect: redirect.href, clientId });
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', state);
    return redirect.href;
  }

  const server = createHttpsServer({ pfx: await readFile(cert.pfx), passphrase: cert.password }, (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin);
      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') return json(response, 200, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`,
        userinfo_endpoint: `${origin}/userinfo`, response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      });
      if (request.method === 'GET' && url.pathname === '/jwks') return json(response, 200, { keys: [jwk] });
      if (request.method === 'GET' && url.pathname === '/authorize') {
        response.writeHead(302, { Location: authorize(url) });
        return response.end();
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 32 * 1024) return json(response, 413, { error: 'request_too_large' });
          chunks.push(chunk);
        }
        const input = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const authorization = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
        const clientId = input.get('client_id');
        const clientSecret = input.get('client_secret');
        if (input.get('grant_type') !== 'authorization_code') return json(response, 400, { error: 'invalid_grant' });
        const code = input.get('code') ?? '';
        const proof = codes.get(code);
        codes.delete(code);
        if (!proof || authorization !== `${proof.clientId}:${providerClientSecret}` && (clientId !== proof.clientId || clientSecret !== providerClientSecret)) return json(response, 401, { error: 'invalid_client' });
        if (proof.redirect !== input.get('redirect_uri') || createHash('sha256').update(input.get('code_verifier') ?? '').digest('base64url') !== proof.challenge) return json(response, 400, { error: 'invalid_grant' });
        const accessToken = uuid();
        tokens.set(accessToken, providerSubject);
        const now = Math.floor(Date.now() / 1000);
        return json(response, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600,
          id_token: jwt({ iss: origin, sub: providerSubject, aud: proof.clientId, iat: now, exp: now + 60, nonce: proof.nonce }) });
      }
      if (request.method === 'GET' && ['/app', '/app/installations'].includes(url.pathname)) {
        if (!/^Bearer [A-Za-z0-9._-]+$/.test(request.headers.authorization ?? '')) return json(response, 401, { error: 'invalid_token' });
        return json(response, 200, url.pathname === '/app' ? { id: 12345, permissions: { contents: 'read', metadata: 'read' } } : []);
      }
      const subject = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (request.method === 'GET' && url.pathname === '/userinfo') return json(response, subject ? 200 : 401, subject ? { sub: subject, name: 'Synthetic Browser Owner' } : { error: 'invalid_token' });
      if (request.method === 'POST' && url.pathname === '/zitadel.authorization.v2.AuthorizationService/ListAuthorizations') {
        if (request.headers['connect-protocol-version'] !== '1' || !subject) return json(response, 401, { error: 'invalid_token' });
        return json(response, 200, { authorizations: [{ id: 'synthetic-instance-admin', user: { id: subject }, project: { id: providerProjectId },
          state: 'STATE_ACTIVE', roles: [{ key: providerRole }] }], pagination: { totalResult: 1, appliedLimit: 100 } });
      }
      return json(response, 404, { error: 'fixture_not_found' });
    })().catch(() => json(response, 400, { error: 'invalid_fixture_request' }));
  });
  server.listen(0, addresses[0]);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic provider listener unavailable');
  origin = `https://localhost:${address.port}`;
  return {
    origin, addresses, authorize,
    reset() { codes.clear(); tokens.clear(); },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function resetSetupFixture() {
  await setupDb.dropDatabase();
  setupProvider.reset();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
  await Promise.all([
    writeFile(setupFixture.files.marker, JSON.stringify({ instanceId: setupFixture.instanceId, phase: 'sealed', recoveryEpoch: 1 }), { mode: 0o600 }),
    writeFile(setupFixture.files.operator, JSON.stringify({ instanceId: setupFixture.instanceId, purpose: 'bootstrap', epoch: 1,
      credential: setupFixture.credential, expiresAt: expiresAt.toISOString() }), { mode: 0o600 }),
  ]);
  // Keep this configuring singleton aligned with tests/fixtures/instance.ts::instanceControl; bind verifier and expiry to the protected operator file.
  await setupDb.collection('instance_configuration').insertOne({
    _id: 'instance', instanceId: setupFixture.instanceId, schemaVersion: 2, revision: 0, editRevision: 0, nextBundleVersion: 1,
    lifecycle: 'configuring', createdAt: now, updatedAt: now, initializedAt: null,
    bootstrap: { epoch: 1, verifierHash: digest(setupFixture.credential), expiresAt, consumedAt: null, sessionSlots: [] },
    securityEpoch: 1, recoveryEpoch: 1, active: null, previous: null, candidate: null, administrators: [],
    gate: { state: 'open', activationId: null, deadline: null }, admissions: [], activation: null, auditOutbox: [], migration: null,
  }, { writeConcern: { w: 1, j: true } });
}

async function seedReadySettingsFixture() {
  await setupDb.dropDatabase();
  const now = new Date();
  const keyring = JSON.parse(await readFile(setupFixture.files.keyring, 'utf8'));
  const keyId = keyring.activeKeyId;
  const rootKey = Buffer.from(keyring.keys[keyId], 'base64');
  const encryptSecret = (value, purpose) => {
    const credentialVersion = uuid();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', rootKey, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([1, setupFixture.instanceId, purpose, keyId, credentialVersion])));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { formatVersion: 1, algorithm: 'aes-256-gcm', keyId, credentialVersion, nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), updatedAt: now };
  };
  const githubPrivateKey = await readFile(setupFixture.env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8');
  const bindingId = uuid();
  const administratorBindingId = uuid();
  const issuer = setupProvider.origin;
  const subject = providerSubject;
  const administratorSubject = 'synthetic-browser-administrator';
  const projectId = providerProjectId;
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
  await writeFile(setupFixture.files.marker, JSON.stringify({ instanceId: setupFixture.instanceId, phase: 'initialized', recoveryEpoch: 1 }), { mode: 0o600 });
  await setupDb.collection('instance_configuration').insertOne({
    _id: 'instance', instanceId: setupFixture.instanceId, schemaVersion: 2, revision: 0, editRevision: 0, nextBundleVersion: 2,
    lifecycle: 'ready', createdAt: now, updatedAt: now, initializedAt: now,
    bootstrap: { epoch: 1, verifierHash: digest(randomBytes(32)), expiresAt, consumedAt: now, sessionSlots: [] },
    securityEpoch: 1, recoveryEpoch: 1,
    active: { version: 1, configuration: sealInstanceBundle({ version: 1, createdAt: now, createdBy: bindingId,
      preferences: { displayName: 'Synthetic Settings Portal', description: 'Synthetic active instance branding.', docsFolder: 'docs' },
      runtime: { authSecret: (await readFile(setupFixture.env.AUTH_SECRET_FILE, 'utf8')).trim(),
        oauthTokenEncryptionKey: (await readFile(setupFixture.env.OAUTH_TOKEN_ENCRYPTION_KEY_FILE, 'utf8')).trim(),
        mongodbUri: (await readFile(setupFixture.env.MONGODB_URI_FILE, 'utf8')).trim(), mongodbDatabase: setupFixture.env.MONGODB_DATABASE,
        trustHost: true, workerEnabled: setupFixture.env.LIBRARIAN_WORKER_ENABLED === '1' },
      publicOrigin: setupOrigin, zitadel: { issuer, clientId: providerClientId, projectId, audience: 'synthetic-instance-api' },
      github: { provider: 'github', appId: '12345' }, secrets: {
        zitadelClientSecret: encryptSecret(providerClientSecret, 'zitadelClientSecret'),
        githubPrivateKey: encryptSecret(githubPrivateKey, 'githubPrivateKey'),
        githubWebhookSecret: encryptSecret(randomBytes(32).toString('base64url'), 'githubWebhookSecret'), previousWebhook: null,
      }, checks: [], ownerProof: null, impact: null, previousUntil: null }, setupFixture.instanceId, keyId, rootKey, now) },
    previous: null, candidate: null,
    administrators: [
      { bindingId, issuer, subject, projectId, kind: 'owner', status: 'active', boundAt: now, boundByActionId: uuid() },
      { bindingId: administratorBindingId, issuer, subject: administratorSubject, projectId, kind: 'administrator', status: 'active', boundAt: now, boundByActionId: uuid() },
    ],
    gate: { state: 'open', activationId: null, deadline: null }, admissions: [], activation: null, auditOutbox: [], migration: null,
  }, { writeConcern: { w: 1, j: true } });
  const userId = new ObjectId();
  const sessionToken = randomBytes(32).toString('base64url');
  const sessionExpires = new Date(now.getTime() + 8 * 60 * 60_000);
  await setupDb.collection('users').insertOne({ _id: userId, name: 'Synthetic Owner', email: null, emailVerified: null, image: null });
  await setupDb.collection('accounts').insertOne({ userId, type: 'oidc', provider: 'zitadel', providerAccountId: subject, issuer });
  await setupDb.collection('sessions').insertOne({ sessionToken, userId, createdAt: now, absoluteExpiresAt: sessionExpires, expires: sessionExpires,
    instanceId: setupFixture.instanceId, securityEpoch: 1, recoveryEpoch: 1 });
  await setupDb.collection('identity_authorizations').insertOne({ _id: digest(`${issuer}\0${subject}\0${projectId}`), issuer, subject, projectId,
    roles: [providerRole], verifiedAt: now, leaseFence: 0, lease: null });
  const administratorUserId = new ObjectId();
  const administratorSessionToken = randomBytes(32).toString('base64url');
  await setupDb.collection('users').insertOne({ _id: administratorUserId, name: 'Synthetic Instance Administrator', email: null, emailVerified: null, image: null });
  await setupDb.collection('accounts').insertOne({ userId: administratorUserId, type: 'oidc', provider: 'zitadel', providerAccountId: administratorSubject, issuer });
  await setupDb.collection('sessions').insertOne({ sessionToken: administratorSessionToken, userId: administratorUserId, createdAt: now,
    absoluteExpiresAt: sessionExpires, expires: sessionExpires, instanceId: setupFixture.instanceId, securityEpoch: 1, recoveryEpoch: 1 });
  await setupDb.collection('identity_authorizations').insertOne({ _id: digest(`${issuer}\0${administratorSubject}\0${projectId}`), issuer,
    subject: administratorSubject, projectId, roles: [providerRole], verifiedAt: now, leaseFence: 0, lease: null });
  return { sessionToken, administratorSessionToken };
}

async function waitForNext(child, port, tls = false) {
  let startupError;
  child.once('error', error => { startupError = error; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    if (startupError) throw startupError;
    try {
      if (tls) await new Promise((resolve, reject) => {
        const request = httpsRequest({ hostname: 'localhost', servername: 'localhost', port, path: '/', rejectUnauthorized: false, timeout: 1000 }, response => {
          response.resume(); response.once('end', resolve); response.once('error', reject);
        });
        request.once('timeout', () => request.destroy(new Error('Browser setup server readiness timed out')));
        request.once('error', reject);
        request.end();
      });
      else {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
      }
      return;
    }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error(child.exitCode !== null || child.signalCode !== null ? `Browser fixture server on ${port} exited before readiness` : `Browser fixture server on ${port} did not become ready`);
}

async function stopNext(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await once(killer, 'exit');
  } else child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(timer);
}

function startSetupServer() {
  setupServer = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', 'localhost', '--port', '3200',
    '--experimental-https', '--experimental-https-key', setupFixture.certificate.key, '--experimental-https-cert', setupFixture.certificate.certificate],
    { cwd: process.cwd(), env: setupFixture.env, stdio: 'inherit', windowsHide: true });
  return setupServer;
}

async function restartSetupServer() {
  await stopNext(setupServer);
  setupServer = undefined;
  await waitForNext(startSetupServer(), 3200, true);
}

async function prepare() {
  await mkdir(contentRoot, { recursive: true });
  await mkdir(secrets, { recursive: true });
  await mkdir(setupContentRoot, { recursive: true, mode: 0o700 });
  await mkdir(setupSecrets, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const user = (await run('whoami', [], { windowsHide: true })).stdout.trim();
    await run('icacls', [setupRoot, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { windowsHide: true });
  } else await chmod(setupRoot, 0o700);
  await client.connect();
  const db = client.db(dbName);
  fixtureDb = db;
  setupDb = client.db(setupDbName);
  const userId = new ObjectId();
  const sessionToken = 'synthetic-browser-admin-session';
  const sessionCreatedAt = new Date();
  const sessionExpiresAt = new Date(sessionCreatedAt.getTime() + 8 * 60 * 60 * 1000);
  const issuer = 'https://identity.synthetic.invalid';
  const subject = 'synthetic-browser-admin-subject';
  const projectId = 'synthetic-project';
  await db.collection('users').insertOne({ _id: userId, name: null, email: null, emailVerified: null, image: null });
  await db.collection('accounts').insertOne({ userId, type: 'oidc', provider: 'zitadel', providerAccountId: subject, issuer });
  await db.collection('sessions').insertOne({ sessionToken, userId, expires: sessionExpiresAt,
    createdAt: sessionCreatedAt, absoluteExpiresAt: sessionExpiresAt });
  await db.collection('identity_authorizations').insertOne({ _id: createHash('sha256').update(`${issuer}\0${subject}\0${projectId}`).digest('hex'),
    issuer, subject, projectId, roles: ['librarian-admin'], verifiedAt: sessionCreatedAt, leaseFence: 0, lease: null });
  const readerId = new ObjectId();
  const readerSubject = 'synthetic-browser-reader-subject';
  await db.collection('users').insertOne({ _id: readerId, name: null, email: null, emailVerified: null, image: null });
  await db.collection('accounts').insertOne({ userId: readerId, type: 'oidc', provider: 'zitadel', providerAccountId: readerSubject, issuer });
  for (const browser of browsers) {
    await db.collection('sessions').insertOne({ sessionToken: `synthetic-browser-reader-${browser}-session`, userId: readerId,
      expires: sessionExpiresAt, createdAt: sessionCreatedAt, absoluteExpiresAt: sessionExpiresAt });
  }
  await db.collection('identity_authorizations').insertOne({ _id: createHash('sha256').update(`${issuer}\0${readerSubject}\0${projectId}`).digest('hex'),
    issuer, subject: readerSubject, projectId, roles: ['docs:private-one:reader'], verifiedAt: sessionCreatedAt, leaseFence: 0, lease: null });
  for (const browser of browsers) {
    const syncReaderId = new ObjectId();
    const syncReaderSubject = `synthetic-browser-sync-reader-${browser}-subject`;
    await db.collection('users').insertOne({ _id: syncReaderId, name: null, email: null, emailVerified: null, image: null });
    await db.collection('accounts').insertOne({ userId: syncReaderId, type: 'oidc', provider: 'zitadel', providerAccountId: syncReaderSubject, issuer });
    await db.collection('sessions').insertOne({ sessionToken: `synthetic-browser-sync-reader-${browser}-session`, userId: syncReaderId,
      expires: sessionExpiresAt, createdAt: sessionCreatedAt, absoluteExpiresAt: sessionExpiresAt });
    const readerProject = `sync-reader-${browser}`;
    await db.collection('identity_authorizations').insertOne({ _id: createHash('sha256').update(`${issuer}\0${syncReaderSubject}\0${projectId}`).digest('hex'),
      issuer, subject: syncReaderSubject, projectId, roles: [`docs:${readerProject}:reader`], verifiedAt: sessionCreatedAt, leaseFence: 0, lease: null });
  }
  const wrongRoleId = new ObjectId();
  const wrongRoleSubject = 'synthetic-browser-wrong-role-subject';
  await db.collection('users').insertOne({ _id: wrongRoleId, name: null, email: null, emailVerified: null, image: null });
  await db.collection('accounts').insertOne({ userId: wrongRoleId, type: 'oidc', provider: 'zitadel', providerAccountId: wrongRoleSubject, issuer });
  await db.collection('sessions').insertOne({ sessionToken: 'synthetic-browser-wrong-role-session', userId: wrongRoleId,
    expires: sessionExpiresAt, createdAt: sessionCreatedAt, absoluteExpiresAt: sessionExpiresAt });
  await db.collection('identity_authorizations').insertOne({ _id: createHash('sha256').update(`${issuer}\0${wrongRoleSubject}\0${projectId}`).digest('hex'),
    issuer, subject: wrongRoleSubject, projectId, roles: ['docs:another-project:reader'], verifiedAt: sessionCreatedAt, leaseFence: 0, lease: null });
  const wrongProjectId = new ObjectId();
  const wrongProjectSubject = 'synthetic-browser-wrong-project-subject';
  await db.collection('users').insertOne({ _id: wrongProjectId, name: null, email: null, emailVerified: null, image: null });
  await db.collection('accounts').insertOne({ userId: wrongProjectId, type: 'oidc', provider: 'zitadel', providerAccountId: wrongProjectSubject, issuer });
  await db.collection('sessions').insertOne({ sessionToken: 'synthetic-browser-wrong-project-session', userId: wrongProjectId,
    expires: sessionExpiresAt, createdAt: sessionCreatedAt, absoluteExpiresAt: sessionExpiresAt });
  const wrongProject = 'other-synthetic-project';
  await db.collection('identity_authorizations').insertOne({ _id: createHash('sha256').update(`${issuer}\0${wrongProjectSubject}\0${wrongProject}`).digest('hex'),
    issuer, subject: wrongProjectSubject, projectId: wrongProject, roles: ['docs:private-one:reader'], verifiedAt: sessionCreatedAt, leaseFence: 0, lease: null });
  const expiredId = new ObjectId();
  const expiredAt = new Date(Date.now() - 1000);
  await db.collection('users').insertOne({ _id: expiredId, name: null, email: null, emailVerified: null, image: null });
  await db.collection('accounts').insertOne({ userId: expiredId, type: 'oidc', provider: 'zitadel',
    providerAccountId: 'synthetic-browser-expired-subject', issuer });
  await db.collection('sessions').insertOne({ sessionToken: 'synthetic-browser-expired-session', userId: expiredId,
    expires: expiredAt, createdAt: expiredAt, absoluteExpiresAt: expiredAt });
  const pixel = await readFile('tests/fixtures/content/public-project/pixel.png');
  const md = (title, body) => Buffer.from(`---\n{"title":"${title}"}\n---\n${body}`);
  await addProject(db, { slug: 'public-project', title: 'Public Project', visibility: 'public', repoId: 1,
    files: [['index.md', md('Synthetic Portal', '# Synthetic Portal\n\nRead the [setup guide](guides/setup.md#first-step).\n\n![Synthetic pixel](pixel.png)\n\n| Check | State |\n| --- | --- |\n| Fixture | Ready |\n\n- [x] Public fixture loaded'), 'markdown'],
      ['guides/setup.md', md('Setup', '# First step\n\nSetup fixture content.'), 'markdown'], ['pixel.png', pixel, 'asset']],
    links: { 'index.md': ['guides/setup.md#first-step', 'pixel.png'] },
    metadata: [['guides/meta.json', Buffer.from('{"title":"Guides","pages":["setup"],"defaultOpen":false}')]],
  });
  await addProject(db, { slug: 'other-project', title: 'Other Project', visibility: 'public', repoId: 2,
    files: [['index.md', md('Other Project', '# Other Project\n\nOnly in another repository: telescope.'), 'markdown']] });
  await addProject(db, { slug: 'private-one', title: 'Restricted One', visibility: 'private', repoId: 3,
    files: [['index.md', md('Private Fixture', '# SYNTHETIC_PRIVATE_BROWSER_SENTINEL'), 'markdown'],
      ['guides/setup.md', md('Private Article', '# SYNTHETIC_PRIVATE_ARTICLE_SENTINEL'), 'markdown'], ['pixel.png', pixel, 'asset']],
    links: { 'index.md': ['guides/setup.md', 'pixel.png'] },
    metadata: [['guides/meta.json', Buffer.from('{"title":"Private Guides","pages":["setup"],"defaultOpen":true}')]],
  });
  await addFailedFirstSyncProject(db);
  const syncCatalogIds = {};
  for (const [index, browser] of browsers.entries()) {
    const project = await addProject(db, { slug: `sync-reader-${browser}`, title: `Sync Reader ${browser}`, visibility: 'private', repoId: index + 4,
      files: [['index.md', md(`Sync Reader ${browser}`, `# SYNC_READER_BASE_${browser.toUpperCase()}`), 'markdown'],
        ['guides/setup.md', md('Original Guide', '# Original guide before publication.'), 'markdown']],
    });
    syncCatalogIds[browser] = project.catalogId;
  }
  directoryCatalogs = await db.collection('catalogs').find().toArray();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const values = { auth: randomBytes(32).toString('base64url'), oidc: randomBytes(32).toString('base64url'), mongo: `${uri}/${dbName}`,
    github: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), webhook: randomBytes(32).toString('hex'), encryption: randomBytes(32).toString('base64') };
  const paths = Object.fromEntries(await Promise.all(Object.entries(values).map(async ([key, value]) => {
    const path = join(secrets, `${key}.secret`);
    await writeFile(path, value, { mode: 0o600 });
    return [key, path];
  })));
  const instanceId = uuid();
  const operatorCredential = randomBytes(32).toString('base64url');
  const setupFiles = {
    marker: join(setupSecrets, 'instance-state.json'),
    keyring: join(setupSecrets, 'instance-keyring.json'),
    operator: join(setupSecrets, 'instance-operator-auth.json'),
    mongo: join(setupSecrets, 'mongo.uri'),
    policy: join(setupSecrets, 'outbound-policy.json'),
    providerCert: join(setupSecrets, 'provider-ca.pem'),
  };
  const setupKey = randomBytes(32).toString('base64');
  const providerCert = await createProviderCertificate();
  setupProvider = await createSyntheticProvider(providerCert);
  await Promise.all([
    writeFile(setupFiles.marker, JSON.stringify({ instanceId, phase: 'prepared', recoveryEpoch: 1 }), { mode: 0o600 }),
    writeFile(setupFiles.keyring, JSON.stringify({ activeKeyId: 'browser-setup-root', keys: { 'browser-setup-root': setupKey } }), { mode: 0o600 }),
    writeFile(setupFiles.operator, JSON.stringify({ instanceId, purpose: 'bootstrap', epoch: 1, credential: operatorCredential,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() }), { mode: 0o600 }),
    writeFile(setupFiles.mongo, `${uri}/${setupDbName}`, { mode: 0o600 }),
    writeFile(setupFiles.policy, JSON.stringify({ origins: [{ origin: setupProvider.origin, addresses: setupProvider.addresses }] }), { mode: 0o600 }),
  ]);
  setupFixture = { instanceId, credential: operatorCredential, files: setupFiles, certificate: providerCert, env: {
    ...process.env, __NEXT_PROCESSED_ENV: 'true', INSTANCE_DATABASE_FILE: '', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', AUTH_URL: setupOrigin, AUTH_TRUST_HOST: 'true',
    LIBRARIAN_NEXT_DIST_DIR: relative(process.cwd(), join(setupRoot, 'next')), LIBRARIAN_WORKER_ENABLED: '0',
    INSTANCE_ID: instanceId, INSTANCE_SETUP_ORIGIN: setupOrigin, INSTANCE_STATE_FILE: setupFiles.marker, INSTANCE_KEYRING_FILE: setupFiles.keyring,
    INSTANCE_OPERATOR_AUTH_FILE: setupFiles.operator, INSTANCE_OUTBOUND_POLICY_FILE: setupFiles.policy,
    MONGODB_DATABASE: setupDbName, CONTENT_ROOT: setupContentRoot, AUTH_SECRET_FILE: paths.auth,
    OAUTH_TOKEN_ENCRYPTION_KEY_FILE: paths.encryption, MONGODB_URI_FILE: setupFiles.mongo,
    NODE_EXTRA_CA_CERTS: setupFiles.providerCert,
    LIBRARIAN_TEST_PROVIDER_CA_FILE: setupFiles.providerCert,
    LIBRARIAN_TEST_GITHUB_API_ORIGIN: setupProvider.origin,
    AUTH_ZITADEL_ID: 'synthetic-runtime-client', AUTH_ZITADEL_ISSUER: setupProvider.origin, AUTH_ZITADEL_SECRET_FILE: paths.oidc,
    ZITADEL_PROJECT_ID: 'synthetic-runtime-project', ZITADEL_API_AUDIENCE: 'synthetic-runtime-api', GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY_FILE: paths.github, GITHUB_WEBHOOK_SECRET_FILE: paths.webhook,
  } };
  await resetSetupFixture();
  return { paths, syncCatalogIds, instanceId };
}

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    await Promise.all([stopNext(server), stopNext(setupServer)]);
    await setupProvider?.close();
    if (controlServer?.listening) await new Promise(resolve => controlServer.close(resolve));
    try { await Promise.all([client.db(dbName).dropDatabase(), client.db(setupDbName).dropDatabase()]); } finally {
      try { await client.close(); } finally {
        await Promise.all([
          rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
          rm(setupRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
          ...(stateWritten ? [rm(browserState, { force: true, maxRetries: 5, retryDelay: 200 })] : []),
        ]);
      }
    }
  })();
  return cleaning;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void cleanup().finally(() => process.exit(0)));

try {
  const { paths, syncCatalogIds, instanceId } = await prepare();
  await writeFile(browserState, JSON.stringify({ dbName, contentRoot, syncCatalogIds, setupDbName, setupOrigin, instanceId }), { flag: 'wx' });
  stateWritten = true;
  startControlServer();
  const env = { ...process.env, __NEXT_PROCESSED_ENV: 'true', INSTANCE_DATABASE_FILE: '', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', AUTH_URL: 'http://127.0.0.1:3100', AUTH_TRUST_HOST: 'true',
    LIBRARIAN_NEXT_DIST_DIR: relative(process.cwd(), join(root, 'next')),
    LIBRARIAN_WORKER_ENABLED: '0',
    AUTH_ZITADEL_ID: 'synthetic-client', AUTH_ZITADEL_ISSUER: 'https://identity.synthetic.invalid', ZITADEL_PROJECT_ID: 'synthetic-project',
    ZITADEL_API_AUDIENCE: 'synthetic-api', MONGODB_DATABASE: dbName, CONTENT_ROOT: contentRoot, GITHUB_APP_ID: '12345',
    AUTH_SECRET_FILE: paths.auth, AUTH_ZITADEL_SECRET_FILE: paths.oidc, MONGODB_URI_FILE: paths.mongo, GITHUB_APP_PRIVATE_KEY_FILE: paths.github,
    GITHUB_WEBHOOK_SECRET_FILE: paths.webhook, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: paths.encryption };
  await waitForNext(startSetupServer(), 3200, true);
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3100'],
    { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true });
  await waitForNext(server, 3100);
  await once(server, 'exit');
} finally { await cleanup(); }
