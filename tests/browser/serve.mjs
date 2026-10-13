import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MongoClient, ObjectId } from 'mongodb';

const uri = 'mongodb://127.0.0.1:27018';
if (new URL(uri).hostname !== '127.0.0.1') throw new Error('Browser fixture Mongo must be loopback-only');
const id = randomUUID();
const dbName = `librarian_browser_${id.replaceAll('-', '')}`;
const root = resolve('.local', `browser-${id}`);
const secrets = join(root, 'secrets');
const contentRoot = join(root, 'content');
const browserState = resolve('.local/browser-state.json');
const browsers = ['chromium', 'firefox', 'webkit'];
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10, minPoolSize: 0 });
let server;
let cleaning;
let stateWritten = false;

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = () => randomUUID();

async function addProject(db, { slug, title, visibility, repoId, files, links = {}, metadata = [] }) {
  const catalogId = uuid();
  const generationId = uuid();
  const generationRoot = join(contentRoot, catalogId, 'generations', generationId);
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

async function prepare() {
  await mkdir(contentRoot, { recursive: true });
  await mkdir(secrets, { recursive: true });
  await client.connect();
  const db = client.db(dbName);
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
  const syncCatalogIds = {};
  for (const [index, browser] of browsers.entries()) {
    const project = await addProject(db, { slug: `sync-reader-${browser}`, title: `Sync Reader ${browser}`, visibility: 'private', repoId: index + 4,
      files: [['index.md', md(`Sync Reader ${browser}`, `# SYNC_READER_BASE_${browser.toUpperCase()}`), 'markdown'],
        ['guides/setup.md', md('Original Guide', '# Original guide before publication.'), 'markdown']],
    });
    syncCatalogIds[browser] = project.catalogId;
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const values = { auth: randomBytes(32).toString('base64url'), oidc: randomBytes(32).toString('base64url'), mongo: `${uri}/${dbName}`,
    github: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), webhook: randomBytes(32).toString('hex'), encryption: randomBytes(32).toString('base64') };
  const paths = Object.fromEntries(await Promise.all(Object.entries(values).map(async ([key, value]) => {
    const path = join(secrets, `${key}.secret`);
    await writeFile(path, value, { mode: 0o600 });
    return [key, path];
  })));
  return { paths, syncCatalogIds };
}

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit');
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        await once(killer, 'exit');
      } else {
        server.kill('SIGTERM');
      }
      const timer = setTimeout(() => server.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
    try { await client.db(dbName).dropDatabase(); } finally {
      try { await client.close(); } finally {
        await Promise.all([
          rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
          ...(stateWritten ? [rm(browserState, { force: true, maxRetries: 5, retryDelay: 200 })] : []),
        ]);
      }
    }
  })();
  return cleaning;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void cleanup().finally(() => process.exit(0)));

try {
  const { paths, syncCatalogIds } = await prepare();
  await writeFile(browserState, JSON.stringify({ dbName, contentRoot, syncCatalogIds }), { flag: 'wx' });
  stateWritten = true;
  const env = { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', AUTH_URL: 'http://127.0.0.1:3100', AUTH_TRUST_HOST: 'true',
    LIBRARIAN_NEXT_DIST_DIR: relative(process.cwd(), join(root, 'next')),
    LIBRARIAN_WORKER_ENABLED: '0',
    AUTH_ZITADEL_ID: 'synthetic-client', AUTH_ZITADEL_ISSUER: 'https://identity.synthetic.invalid', ZITADEL_PROJECT_ID: 'synthetic-project',
    ZITADEL_API_AUDIENCE: 'synthetic-api', MONGODB_DATABASE: dbName, CONTENT_ROOT: contentRoot, GITHUB_APP_ID: '12345',
    AUTH_SECRET_FILE: paths.auth, AUTH_ZITADEL_SECRET_FILE: paths.oidc, MONGODB_URI_FILE: paths.mongo, GITHUB_APP_PRIVATE_KEY_FILE: paths.github,
    GITHUB_WEBHOOK_SECRET_FILE: paths.webhook, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: paths.encryption };
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3100'],
    { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true });
  let startupError;
  server.once('error', error => { startupError = error; });
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline && server.exitCode === null) {
    if (startupError) throw startupError;
    try { await fetch('http://127.0.0.1:3100/', { signal: AbortSignal.timeout(1000) }); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!ready) throw new Error(server.exitCode !== null ? 'Browser fixture server exited before readiness' : 'Browser fixture server did not become ready');
  await once(server, 'exit');
} finally { await cleanup(); }
