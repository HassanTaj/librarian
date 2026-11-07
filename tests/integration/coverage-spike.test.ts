import { expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { convert } from 'ast-v8-to-istanbul';
import { parseAstAsync } from 'vite';
import { createCoverageMap, type CoverageMapData, type FileCoverageData } from '@vitest/istanbul-lib-coverage';
import { chromium } from '@playwright/test';
import { ObjectId } from 'mongodb';
import { catalogs } from '../fixtures/catalogs';
import { CatalogSchema, type Catalog } from '../../lib/catalog';
import { createLibrarianAdapter } from '../../lib/auth/adapter';
import { LIMITS } from '../../lib/limits';
import type { Manifest } from '../../lib/content/generations';
import { generationRoot } from '../../lib/content/paths';
import { startNextHarness } from './http-harness';
import { seedRuntimeCatalog } from './runtime-fixtures';
import { captureSources, verifySourceMap, verifyInstrumentedCoverage } from '../../scripts/coverage-provenance.mjs';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function seedPrivateReader(storage: Awaited<ReturnType<typeof seedRuntimeCatalog>>) {
  const issuer = 'https://identity.example';
  const projectId = 'project-123';
  const subject = 'synthetic-reader';
  const key = Buffer.alloc(32, 4);
  const adapter = await createLibrarianAdapter(storage.client, storage.db, issuer, key);
  const user = await adapter.createUser!({ id: new ObjectId().toHexString(), name: 'Synthetic reader', email: 'reader@example.invalid', emailVerified: null, image: null });
  const now = Date.now();
  await adapter.linkAccount!({
    userId: user.id, type: 'oidc', provider: 'zitadel', providerAccountId: subject,
    access_token: 'synthetic-private-access', refresh_token: 'synthetic-private-refresh', id_token: 'synthetic-private-id',
    expires_at: Math.floor(now / 1000) + 3600, token_type: 'bearer', scope: 'openid',
  });
  const sessionToken = randomUUID();
  await adapter.createSession!({ sessionToken, userId: user.id, expires: new Date(now + LIMITS.sessionAbsoluteMs) });
  const authorization = {
    _id: createHash('sha256').update(`${issuer}\0${subject}\0${projectId}`).digest('hex'),
    issuer, subject, projectId, roles: ['docs:private-one:reader'], verifiedAt: new Date(now), leaseFence: 1, lease: null,
  };
  await storage.db.collection<typeof authorization>('identity_authorizations').insertOne(authorization);
  return { sessionToken, cookie: `__Secure-authjs.session-token=${sessionToken}` };
}

async function addPrivateCatalog(storage: Awaited<ReturnType<typeof seedRuntimeCatalog>>) {
  const catalog = CatalogSchema.parse(catalogs[1]);
  const generationId = randomUUID();
  const root = generationRoot(storage.contentRoot, catalog._id, generationId);
  const content = new Map(storage.content);
  content.set('index.md', Buffer.from('---\n{"title":"Synthetic Private"}\n---\n# Synthetic Private\n\nSYNTHETIC_PRIVATE_BODY'));
  await mkdir(root, { recursive: true });
  for (const [path, bytes] of content) {
    const file = join(root, ...path.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const manifest = structuredClone(storage.manifest) as Manifest;
  Object.assign(manifest, { catalogId: catalog._id, generationId, commitSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), fence: 1, completedAt: new Date().toISOString() });
  manifest.documents = manifest.documents.map(file => {
    const bytes = content.get(file.path)!;
    return { ...file, ...(file.path === 'index.md' ? { title: 'Synthetic Private' } : {}), size: bytes.length, sha256: digest(bytes) };
  });
  manifest.assets = manifest.assets.map(file => {
    const bytes = content.get(file.path)!;
    return { ...file, size: bytes.length, sha256: digest(bytes) };
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(root, 'manifest.json'), manifestBytes);
  catalog.published = { generationId, configRevision: 1, commitSha: manifest.commitSha, fence: 1,
    jobId: `manual:${catalog._id}:${randomUUID()}`, manifestDigest: digest(manifestBytes), publishedAt: new Date() };
  catalog.publicationRevision = 1;
  catalog.leaseFence = 1;
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
}

async function addBrokenPublicCatalog(storage: Awaited<ReturnType<typeof seedRuntimeCatalog>>) {
  const catalog = CatalogSchema.parse({ ...catalogs[2], slug: 'broken-project', title: 'Broken project', visibility: 'public',
    approvalRef: 'synthetic-owner-approval', readerRole: 'docs:broken-project:reader' });
  catalog.published = { generationId: randomUUID(), configRevision: 1, commitSha: 'e'.repeat(40), fence: 1,
    jobId: `manual:${catalog._id}:${randomUUID()}`, manifestDigest: 'f'.repeat(64), publishedAt: new Date() };
  catalog.publicationRevision = 1;
  catalog.leaseFence = 1;
  await storage.db.collection<Catalog>('catalogs').insertOne(catalog);
}

async function runtimeEnvironment(storage: Awaited<ReturnType<typeof seedRuntimeCatalog>>) {
  const directory = join(storage.root, 'runtime-config');
  await mkdir(directory, { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = Buffer.alloc(32, 4);
  const values = {
    auth: Buffer.alloc(32, 3).toString('base64'), zitadel: 'synthetic-zitadel-secret',
    mongo: `mongodb://127.0.0.1:27018/${storage.db.databaseName}`,
    github: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), webhook: 'synthetic-github-webhook-secret-value',
    oauth: key.toString('base64'),
  };
  const files: Record<keyof typeof values, string> = {} as Record<keyof typeof values, string>;
  for (const [name, value] of Object.entries(values) as [keyof typeof values, string][]) {
    files[name] = join(directory, name);
    await writeFile(files[name], value);
  }
  return {
    AUTH_URL: 'https://docs.example.invalid', AUTH_TRUST_HOST: 'true', AUTH_ZITADEL_ID: 'synthetic-client',
    AUTH_ZITADEL_ISSUER: 'https://identity.example', ZITADEL_PROJECT_ID: 'project-123', ZITADEL_API_AUDIENCE: 'urn:synthetic:api',
    MONGODB_DATABASE: storage.db.databaseName, GITHUB_APP_ID: '1', CONTENT_ROOT: storage.contentRoot,
    AUTH_SECRET_FILE: files.auth, AUTH_ZITADEL_SECRET_FILE: files.zitadel, MONGODB_URI_FILE: files.mongo,
    GITHUB_APP_PRIVATE_KEY_FILE: files.github, GITHUB_WEBHOOK_SECRET_FILE: files.webhook, OAUTH_TOKEN_ENCRYPTION_KEY_FILE: files.oauth,
  };
}

it('maps raw actual-Next execution back to original application sources', async () => {
  const root = process.cwd();
  const directory = resolve(root, 'coverage/next-spike');
  await mkdir(directory, { recursive: true });
  for (const file of await readdir(directory)) await rm(join(directory, file), { recursive: true, force: true });
  const sources = await captureSources(root);
  const distDirectory = process.env.LIBRARIAN_NEXT_DIST_DIR ?? '.next';
  const build = spawn(process.execPath, [resolve(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {
    cwd: root, env: { ...process.env, NODE_ENV: 'production', LIBRARIAN_COVERAGE_BUILD: '1', LIBRARIAN_NEXT_DIST_DIR: distDirectory, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  expect((await once(build, 'exit'))[0], 'Coverage-only build must succeed after source capture').toBe(0);
  const captureFile = join(directory, 'instrumented.json');
  const storage = await seedRuntimeCatalog();
  await addPrivateCatalog(storage);
  await addBrokenPublicCatalog(storage);
  const privateAuth = await seedPrivateReader(storage);
  const env = await runtimeEnvironment(storage);
  let server: Awaited<ReturnType<typeof startNextHarness>> | undefined;
  let browserCoverage: CoverageMapData | undefined;
  try {
    server = await startNextHarness({ appRoot: root, port: 3188, coverageDirectory: directory,
      env: { ...env, LIBRARIAN_NEXT_DIST_DIR: distDirectory, LIBRARIAN_INSTRUMENTED_CAPTURE: captureFile } });
    const home = await fetch(server.origin);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Public Project');

    const reader = await fetch(`${server.origin}/public-project`);
    expect(reader.status).toBe(200);
    expect(await reader.text()).toContain('Synthetic Portal');
    const article = await fetch(`${server.origin}/public-project/guides/setup`);
    expect(article.status).toBe(200);
    expect(await article.text()).toContain('Fixture content.');
    const invalidGeneration = await fetch(`${server.origin}/public-project?g=invalid`);
    expect([200, 404]).toContain(invalidGeneration.status);

    const search = await fetch(`${server.origin}/api/search/public-project?query=Fixture`);
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual(expect.arrayContaining([expect.objectContaining({ url: expect.stringContaining('g=') })]));
    const asset = await fetch(`${server.origin}/api/assets/public-project/notes.txt`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('Synthetic attachment');
    expect((await fetch(`${server.origin}/api/assets/private-one/notes.txt`)).status).toBe(404);
    expect((await fetch(`${server.origin}/api/search/private-one?query=Fixture`)).status).toBe(404);

    const denied = await fetch(`${server.origin}/private-one`);
    expect(denied.status).toBe(200);
    const deniedBody = await denied.text();
    expect(deniedBody).toContain('Restricted project');
    expect(deniedBody).not.toContain('SYNTHETIC_PRIVATE_BODY');
    const privateReader = await fetch(`${server.origin}/private-one`, { headers: { cookie: privateAuth.cookie } });
    expect(privateReader.status).toBe(200);
    expect(await privateReader.text()).toContain('SYNTHETIC_PRIVATE_BODY');
    const broken = await fetch(`${server.origin}/broken-project`);
    expect([200, 500]).toContain(broken.status);

    const missing = await fetch(`${server.origin}/synthetic-project`);
    expect([200, 404]).toContain(missing.status); // Next may commit headers before the streamed not-found boundary.
    expect(await missing.text()).toContain('Page unavailable');
    const legacySearch = await fetch(`${server.origin}/api/search?query=synthetic`);
    expect([200, 404]).toContain(legacySearch.status); // Next can stream the catch-all not-found page with a committed 200.
    expect(await legacySearch.text()).toContain('Page unavailable');
    const browser = await chromium.launch({ headless: true,
      ...(process.env.LIBRARIAN_BROWSER_EXECUTABLE ? { executablePath: process.env.LIBRARIAN_BROWSER_EXECUTABLE } : {}) });
    try {
      const page = await browser.newPage();
      const browserMap = createCoverageMap({});
      const captureBrowser = async () => {
        const counters = await page.evaluate(() => (globalThis as typeof globalThis & { __VITEST_COVERAGE__?: Record<string, FileCoverageData> }).__VITEST_COVERAGE__ ?? {});
        if (Object.keys(counters).length) browserMap.merge(counters);
      };
      await page.goto(server.origin);
      await page.locator('#project-filter').fill('not found');
      await page.getByRole('status').waitFor();
      await page.goto(`${server.origin}/public-project`);
      await page.locator('#nd-sidebar').getByRole('button', { name: /^Search/ }).click();
      const search = page.getByRole('dialog').getByRole('combobox', { name: 'Search' });
      await search.fill('Fixture content');
      await page.getByRole('option').first().waitFor({ state: 'visible' });
      await captureBrowser();
      await page.goto(`${server.origin}/broken-project`);
      await page.getByRole('heading', { name: 'Documentation unavailable' }).waitFor({ state: 'visible' });
      await captureBrowser();
      browserCoverage = Object.fromEntries(browserMap.files().map(file => [file, browserMap.fileCoverageFor(file).toJSON()]));
    } finally { await browser.close(); }

    const proxyHeaders = { 'x-forwarded-host': new URL(env.AUTH_URL).host, 'x-forwarded-proto': 'https' };
    const csrf = await fetch(`${server.origin}/api/auth/csrf`, { headers: proxyHeaders });
    expect(csrf.status).toBe(200);
    const csrfToken = (await csrf.json() as { csrfToken: string }).csrfToken;
    const csrfCookies = csrf.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    const signout = await fetch(`${server.origin}/api/auth/signout`, { method: 'POST', redirect: 'manual',
      headers: { ...proxyHeaders, cookie: `${privateAuth.cookie}; ${csrfCookies}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, callbackUrl: '/' }) });
    expect(signout.status).toBe(302);
    const loggedOut = await fetch(`${server.origin}/api/auth/session`, { headers: { ...proxyHeaders, cookie: privateAuth.cookie } });
    expect(await loggedOut.json()).toBeNull();
  } finally {
    if (server) await server.close();
    await storage.close();
  }
  if (!server) throw new Error('Coverage Next server did not start');
  const captures = (await readdir(directory)).filter(file => /^coverage-.*\.json$/.test(file));
  expect(captures.length, 'Actual Next process must flush its own raw V8 capture').toBeGreaterThan(0);
  const output = createCoverageMap({});
  let converted = 0;
  for (const capture of captures) {
    const raw = JSON.parse(await readFile(join(directory, capture), 'utf8'));
    for (const script of raw.result) {
      if (!script.url.startsWith('file:')) continue;
      const path = fileURLToPath(script.url);
      if (!relative(resolve(root, distDirectory, 'server'), path).replaceAll('\\', '/').match(/^(?!\.\.)[^:]+\.js$/)) continue;
      const code = await readFile(path, 'utf8');
      const map = await readFile(`${path}.map`, 'utf8').then(JSON.parse).catch(() => undefined);
      // Generated webpack manifests are not application sources.
      if (!map) continue;
      const verified = await verifySourceMap(root, map, sources, String(converted));
      output.merge(await convert({ code, sourceMap: verified, coverage: script, ast: parseAstAsync(code), wrapperLength: 0 }));
      converted++;
    }
  }
  expect(converted, 'At least one exact disk-loaded server bundle must convert').toBeGreaterThan(0);
  const required = ['app/layout.tsx', 'app/page.tsx', 'app/[repoSlug]/[[...page]]/page.tsx'];
  for (const file of required) {
    const canonical = resolve(root, file).replaceAll('\\', '/');
    const keys = output.files().map(file => file.replaceAll('\\', '/'));
    expect(keys, `Missing original source identity: ${file}`).toContain(canonical);
    const actual = output.files()[keys.indexOf(canonical)];
    const coverage = output.fileCoverageFor(actual);
    expect(Object.values(coverage.data.s).some(hit => hit > 0), `No original-source hits: ${file}`).toBe(true);
  }
  // Next deliberately returns 128 + SIGTERM (15) after its awaited cleanup.
  expect(server.process.exitCode).toBe(143);
  const coverage = await verifyInstrumentedCoverage(JSON.parse(await readFile(captureFile, 'utf8')), sources);
  const client = await verifyInstrumentedCoverage(browserCoverage!, sources);
  for (const file of required) expect(Object.values(coverage[resolve(root, file)].s).some(hit => (hit as number) > 0)).toBe(true);
  const hashes = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, source.hash]));
  await writeFile(resolve(root, 'coverage/server-evidence.json'), JSON.stringify({
    reports: [{ kind: 'server', coverage, hashes }, ...(Object.keys(client).length ? [{ kind: 'browser', coverage: client, hashes }] : [])],
    server: { exited: true, mapsVerified: true, captures: captures.map(file => relative(root, join(directory, file))) },
    browser: { exited: true, captured: true, originalSourceFiles: Object.keys(client).length },
  }));
});
