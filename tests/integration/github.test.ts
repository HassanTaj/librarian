import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { newCatalogRecord } from '../../lib/catalog';
import { LIMITS } from '../../lib/limits';
import { createGitHubClient } from '../../lib/sync/github';
import { createBlobCache, trimBlobCache } from '../../lib/content/blob-cache';
import { validateCandidate } from '../../lib/content/validate';
import { processNextSyncJob, startSyncWorker } from '../../lib/sync/worker';
import { admitSyncJob, newManualJobId } from '../../lib/sync/jobs';
import { createStorageHarness } from './http-harness';
import { randomUUID } from 'node:crypto';
import type { Catalog } from '../../lib/catalog';

const appId = '123456';
const repositoryId = 987;
const installationId = 888;
const branch = 'feature/docs';
const commitSha = 'a'.repeat(40);
const rootTreeSha = 'b'.repeat(40);
const docsTreeSha = 'c'.repeat(40);
const token = 'ghs_synthetic_stateless_installation_token_with_no_fixed_length_assumption';
const now = 1_800_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

it('downloads only new SHAs across restart, rename, deletion, corruption and configuration changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-incremental-'));
  const source = catalog();
  const signal = new AbortController().signal;
  const cache = () => createBlobCache(root, source._id, source.configRevision, LIMITS.maxSnapshotBytes, signal, async () => true);
  const files = [
    { path: 'index.md', content: '---\r\ntitle: Original\r\n---\r\n# Original\r\n' },
    { path: 'guide.md', content: '# Guide' },
    { path: 'copy.md', content: '# Guide' },
    { path: 'meta.json', content: '{ "pages": ["index", "guide", "copy"] }' },
    { path: 'sample.txt', content: 'line\r\n' },
  ];
  const downloads = (f: ReturnType<typeof provider>) => f.requests.filter(request => request.url.pathname.includes('/git/blobs/')).length;
  try {
    const first = provider({ files });
    const initial = await first.client.readCandidate(source, signal, cache());
    expect(downloads(first)).toBe(4);
    expect(first.downloadedBytes).toBe([...new Set(files.map(file => file.content))].reduce((total, content) => total + Buffer.byteLength(content), 0));
    const second = provider({ files });
    const reused = await second.client.readCandidate(source, signal, cache());
    expect(downloads(second)).toBe(0);
    expect(second.downloadedBytes).toBe(0);
    expect(reused).toEqual(initial);
    expect(validateCandidate(reused.files)).toEqual(validateCandidate(initial.files));
    expect(validateCandidate(initial.files).documents[0].markdown).not.toBe(files[0].content);
    const changed = provider({ files: files.map(file => file.path === 'guide.md' ? { ...file, content: '# Changed' } : file) });
    await changed.client.readCandidate(source, signal, cache());
    expect(downloads(changed)).toBe(1);
    expect(changed.downloadedBytes).toBe(Buffer.byteLength('# Changed'));
    const renamed = provider({ files: [{ path: 'renamed.md', content: '# Guide' }, files[0]] });
    const renamedCandidate = await renamed.client.readCandidate(source, signal, cache());
    expect(downloads(renamed)).toBe(0);
    expect(renamedCandidate.files.map(file => file.path)).toEqual(['renamed.md', 'index.md']);
    const added = provider({ files: [...files, { path: 'new.md', content: '# New' }] });
    await added.client.readCandidate(source, signal, cache());
    expect(downloads(added)).toBe(1);
    const originalSha = gitBlob(files[0].content).sha;
    await writeFile(join(root, source._id, 'blob-cache', `1-${originalSha}`), 'x'.repeat(Buffer.byteLength(files[0].content)));
    const corrupt = provider({ files });
    await corrupt.client.readCandidate(source, signal, cache());
    expect(downloads(corrupt)).toBe(1);
    await rm(join(root, source._id, 'blob-cache', `1-${originalSha}`));
    const missing = provider({ files });
    await missing.client.readCandidate(source, signal, cache());
    expect(downloads(missing)).toBe(1);
    source.configRevision++;
    await trimBlobCache(root, source._id, source.configRevision, LIMITS.maxSnapshotBytes);
    const revised = provider({ files });
    await revised.client.readCandidate(source, signal, cache());
    expect(downloads(revised)).toBe(4);
    expect(second.requests.filter(request => request.url.pathname.includes('/git/ref/'))).toHaveLength(2);
    expect(second.requests.some(request => request.url.pathname.includes('/access_tokens'))).toBe(true);
    console.info('Incremental synthetic downloads: first=4, unchanged=0, changed=1, rename/delete=0, addition=1, corrupt=1, missing=1, revision=4');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('treats ordinary cache failures as misses, rejects unsafe cache paths and verifies adapter bytes', async () => {
  const source = catalog();
  const unavailable = { get: async () => { throw new Error('disk_unavailable'); }, put: async () => { throw new Error('disk_full'); } };
  const fixture = provider();
  await expect(fixture.client.readCandidate(source, undefined, unavailable)).resolves.toMatchObject({ files: [{ path: 'index.md' }] });
  const invalid = { get: async () => Buffer.from('bad'), put: async () => {} };
  await expect(provider().client.readCandidate(source, undefined, invalid)).resolves.toMatchObject({ files: [{ content: Buffer.from('# Synthetic docs') }] });
  const unsafe = { get: async () => { throw new Error('generation_invalid_path'); }, put: async () => {} };
  await expect(provider().client.readCandidate(source, undefined, unsafe)).rejects.toThrow('generation_invalid_path');
  const unsafeWrite = { get: async () => undefined, put: async () => { throw new Error('generation_invalid_path'); } };
  await expect(provider().client.readCandidate(source, undefined, unsafeWrite)).rejects.toThrow('generation_invalid_path');
});

it('preserves cancellation, access checks and head checks when every blob is cached', async () => {
  const source = catalog();
  const raw = Buffer.from('# Synthetic docs');
  const cached = { get: async () => raw, put: async () => {} };
  await expect(provider({ branchHeads: [commitSha, 'f'.repeat(40)] }).client.readCandidate(source, undefined, cached)).rejects.toThrow('github_head_changed');
  await expect(provider({ tokenPermissions: 'write' }).client.readCandidate(source, undefined, cached)).rejects.toThrow('github_invalid_token');
  const controller = new AbortController();
  const stopped = { get: async () => { controller.abort(); throw new Error('stopped'); }, put: async () => {} };
  await expect(provider().client.readCandidate(source, controller.signal, stopped)).rejects.toThrow('github_cancelled');
});

function gitBlob(content: string) {
  const bytes = Buffer.from(content);
  return { sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), bytes };
}

function tree(files: Array<{ path: string; content: string; mode?: string; type?: string }>) {
  const contents = new Map<string, Buffer>();
  const entries = files.map(file => {
    const blob = gitBlob(file.content);
    contents.set(blob.sha, blob.bytes);
    return { path: file.path, mode: file.mode ?? '100644', type: file.type ?? 'blob', size: blob.bytes.length, sha: blob.sha };
  });
  return { contents, entries };
}

function provider(options: {
  files?: Array<{ path: string; content: string; mode?: string; type?: string }>;
  truncated?: boolean;
  branchHeads?: string[];
  tokenPermissions?: string;
  tokenExpiresAt?: string;
  repositories?: Array<{ id: number }>;
  omitRepositories?: boolean;
  repositoryIdResponse?: number;
  repositoryOwner?: string;
  repositoryName?: string;
  returnedRef?: string;
  returnedCommitSha?: string;
  corruptBlob?: boolean;
  status?: number;
  headers?: Record<string, string>;
  delay?: number;
} = {}) {
  const files = options.files ?? [{ path: 'index.md', content: '# Synthetic docs' }];
  const built = tree(files);
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  let headIndex = 0;
  let activeBlobs = 0;
  let maxActiveBlobs = 0;
  let downloadedBytes = 0;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const path = url.pathname;
    if (options.status) return new Response(null, { status: options.status, headers: options.headers });
    if (path === `/app/installations/${installationId}/access_tokens`) {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual(body.repository_ids
        ? { repository_ids: [repositoryId], permissions: { contents: 'read' } }
        : { repositories: ['docs'], permissions: { contents: 'read' } });
      const authorization = new Headers(init.headers).get('authorization') ?? '';
      const jwt = authorization.replace(/^Bearer /, '');
      const [header, claims, signature] = jwt.split('.');
      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
      expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ iss: appId });
      expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
      return Response.json({ token, expires_at: options.tokenExpiresAt ?? new Date(now + 60 * 60_000).toISOString(),
        permissions: { contents: options.tokenPermissions ?? 'read' },
        ...(!options.omitRepositories ? { repositories: options.repositories ?? [{ id: repositoryId }] } : {}) }, { status: 201 });
    }
    if (path === '/repos/synthetic/docs') {
      return Response.json({ id: options.repositoryIdResponse ?? repositoryId, name: options.repositoryName ?? 'docs', private: true,
        owner: { login: options.repositoryOwner ?? 'synthetic' } });
    }
    if (path.endsWith(`/git/ref/heads/feature/docs`)) {
      const head = (options.branchHeads ?? [commitSha, commitSha])[Math.min(headIndex++, (options.branchHeads ?? [commitSha]).length - 1)];
      return Response.json({ ref: options.returnedRef ?? `refs/heads/${branch}`, object: { type: 'commit', sha: head } });
    }
    if (path.endsWith(`/git/commits/${commitSha}`)) {
      return Response.json({ sha: options.returnedCommitSha ?? commitSha, tree: { sha: rootTreeSha } });
    }
    if (path.endsWith(`/git/trees/${rootTreeSha}`)) {
      return Response.json({ sha: rootTreeSha, truncated: false,
        tree: [{ path: 'feature', mode: '040000', type: 'tree', sha: 'd'.repeat(40) }] });
    }
    if (path.endsWith(`/git/trees/${'d'.repeat(40)}`)) {
      return Response.json({ sha: 'd'.repeat(40), truncated: false,
        tree: [{ path: 'docs', mode: '040000', type: 'tree', sha: docsTreeSha }] });
    }
    if (path.endsWith(`/git/trees/${docsTreeSha}`)) {
      return Response.json({ sha: docsTreeSha, truncated: options.truncated ?? false, tree: built.entries });
    }
    const blobMatch = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (blobMatch) {
      activeBlobs++;
      maxActiveBlobs = Math.max(maxActiveBlobs, activeBlobs);
      try {
        if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
        const bytes = built.contents.get(blobMatch[1]);
        if (!bytes) return new Response(null, { status: 404 });
        expect(new Headers(init.headers).get('accept')).toBe('application/vnd.github.raw+json');
        const body = options.corruptBlob && bytes.length ? Buffer.from([bytes[0]! ^ 1, ...bytes.subarray(1)]).toString('utf8') : bytes.toString('utf8');
        downloadedBytes += Buffer.byteLength(body);
        return new Response(body, { status: 200 });
      } finally { activeBlobs--; }
    }
    throw new Error('Unexpected provider request');
  };
  const client = createGitHubClient({ githubAppId: appId, githubPrivateKey: privatePem }, fetcher, () => now);
  return { client, requests, fetcher, get maxActiveBlobs() { return maxActiveBlobs; }, get downloadedBytes() { return downloadedBytes; } };
}

function catalog() {
  const value = newCatalogRecord({ github: { repositoryId, installationId, owner: 'synthetic', name: 'docs', branch,
    docsPath: 'feature/docs' }, slug: 'synthetic-docs', title: 'Synthetic docs', visibility: 'private' });
  value.accessState = 'ready';
  return value;
}

it('reuses persisted blobs when sync is driven by the started background worker', async () => {
  const storage = await createStorageHarness();
  const source = catalog();
  await storage.db.collection<Catalog>('catalogs').insertOne(source);
  const fixture = provider({ tokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
  const enqueue = () => admitSyncJob(storage.db, { _id: newManualJobId(source._id, randomUUID()), catalogId: source._id,
    origin: 'manual', event: 'manual', payloadDigest: 'a'.repeat(64) });
  const first = await enqueue();
  const worker = startSyncWorker({ db: storage.db, contentRoot: storage.contentRoot,
    github: { githubAppId: appId, githubPrivateKey: privatePem, fetcher: fixture.fetcher } });
  const waitFor = async (id: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = await storage.db.collection<Catalog>('catalogs').findOne({ _id: source._id });
      if (current?.lastSuccess?.jobId === id) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Synthetic worker did not publish');
  };
  try {
    await waitFor(first.job._id);
    const second = await enqueue();
    await waitFor(second.job._id);
    expect(fixture.requests.filter(request => request.url.pathname.includes('/git/blobs/'))).toHaveLength(1);
  } finally { await worker.stop(); await storage.close(); }
});

it('publishes new complete generations from cached raw blobs and preserves publication on later upstream failure', async () => {
  const storage = await createStorageHarness();
  const source = catalog();
  await storage.db.collection<Catalog>('catalogs').insertOne(source);
  const files = [{ path: 'index.md', content: '# Worker raw\r\n' }, { path: 'guide.md', content: '# Guide' }];
  const run = async (fixture: ReturnType<typeof provider>) => {
    await admitSyncJob(storage.db, { _id: newManualJobId(source._id, randomUUID()), catalogId: source._id,
      origin: 'manual', event: 'manual', payloadDigest: 'a'.repeat(64) });
    return processNextSyncJob({ db: storage.db, contentRoot: storage.contentRoot,
      github: { githubAppId: appId, githubPrivateKey: privatePem, fetcher: fixture.fetcher } });
  };
  const current = () => storage.db.collection<Catalog>('catalogs').findOne({ _id: source._id });
  const tokenExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  try {
    const first = provider({ files, tokenExpiresAt });
    expect(await run(first)).toBe('succeeded');
    const firstPointer = (await current())!.published!;
    const second = provider({ files, tokenExpiresAt });
    expect(await run(second)).toBe('succeeded');
    const secondPointer = (await current())!.published!;
    expect(secondPointer.generationId).not.toBe(firstPointer.generationId);
    expect(second.requests.filter(request => request.url.pathname.includes('/git/blobs/'))).toHaveLength(0);
    const paths = [firstPointer, secondPointer].map(pointer => join(storage.contentRoot, source._id, 'generations', pointer.generationId, 'index.md'));
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(paths[0])).toEqual(await readFile(paths[1]));
    expect(await readFile(join(storage.contentRoot, source._id, 'blob-cache', `1-${gitBlob(files[0].content).sha}`), 'utf8')).toBe(files[0].content);
    const renamed = provider({ files: [{ path: 'renamed.md', content: files[1].content }, files[0]], tokenExpiresAt });
    expect(await run(renamed)).toBe('succeeded');
    expect(renamed.requests.filter(request => request.url.pathname.includes('/git/blobs/'))).toHaveLength(0);
    const validPointer = (await current())!.published!;
    const retained = (await current())!.retained.map(pointer => ({ ...pointer, retiredAt: new Date(0) }));
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: source._id }, { $set: { retained } });
    const failed = provider({ files: [{ path: 'index.md', content: '# Changed' }], tokenExpiresAt, corruptBlob: true });
    expect(await run(failed)).toBe('failed');
    expect((await current())!.published).toEqual(validPointer);
  } finally { await storage.close(); }
});

it('uses a short-lived JWT, a selected read-only installation token, immutable tree/blob SHAs, and rechecks branch head', async () => {
  const fixture = provider();
  const result = await fixture.client.readCandidate(catalog());
  expect(result).toMatchObject({ commitSha, treeSha: rootTreeSha, files: [{ path: 'index.md', mode: '100644' }] });
  expect(result.files[0].content.toString()).toBe('# Synthetic docs');
  expect(fixture.requests.filter(request => request.url.pathname.includes('/git/ref/')).length).toBe(2);
  expect(fixture.requests.some(request => request.url.searchParams.get('recursive') === '1')).toBe(true);
  expect(fixture.requests.find(request => request.url.searchParams.get('recursive') === '1')?.url.pathname.endsWith(`/git/trees/${docsTreeSha}`)).toBe(true);
  expect(fixture.requests.every(request => request.init.redirect === 'error')).toBe(true);
});

it('validates repository identity, selected installation access, branch and docs folder before catalog admission', async () => {
  const fixture = provider();
  const result = await fixture.client.verifyRepository({ installationId, owner: 'synthetic', name: 'docs', branch, docsPath: 'feature/docs' });
  expect(result).toEqual({ repositoryId, owner: 'synthetic', name: 'docs', isPrivate: true, commitSha });
  expect(fixture.requests[0].url.pathname).toBe(`/app/installations/${installationId}/access_tokens`);
  expect(fixture.requests[0].init.body).toContain('"repositories":["docs"]');
  await expect(fixture.client.verifyRepository({ installationId, owner: 'synthetic', name: 'docs', branch, docsPath: 'missing' }))
    .rejects.toThrow('github_docs_missing');
});

it('fetches at most two bounded blobs at once', async () => {
  const fixture = provider({ files: Array.from({ length: 5 }, (_, index) => ({ path: `page-${index}.md`, content: `# Page ${index}` })), delay: 10 });
  const result = await fixture.client.readCandidate(catalog());
  expect(result.files).toHaveLength(5);
  expect(fixture.maxActiveBlobs).toBeLessThanOrEqual(LIMITS.fetchConcurrency);
});

it.each([
  ['truncated trees', { truncated: true }, 'github_tree_invalid'],
  ['symbolic links', { files: [{ path: 'index.md', content: '# link', mode: '120000' }] }, 'github_unsafe_entry'],
  ['submodules', { files: [{ path: 'index.md', content: '# submodule', mode: '160000', type: 'commit' }] }, 'github_unsafe_entry'],
])('rejects incomplete or unsafe source entries (%s)', async (_name, options, code) => {
  await expect(provider(options).client.readCandidate(catalog())).rejects.toMatchObject({ code });
});

it('rejects a moved branch head rather than mixing commits', async () => {
  await expect(provider({ branchHeads: [commitSha, 'f'.repeat(40)] }).client.readCandidate(catalog()))
    .rejects.toThrow('github_head_changed');
});

it('respects provider rate-limit headers without exposing provider response bodies', async () => {
  const fixture = provider({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil((now + 30_000) / 1000)) } });
  await expect(fixture.client.readCandidate(catalog())).rejects.toMatchObject({ code: 'github_rate_limited', retryAfterMs: 30_000 });
  expect(fixture.requests.some(request => request.url.pathname.endsWith('/access_tokens'))).toBe(true);
  await expect(provider({ status: 429, headers: { 'retry-after': 'invalid', 'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(Math.ceil((now + 10_000) / 1000)) } }).client.readCandidate(catalog()))
    .rejects.toMatchObject({ code: 'github_rate_limited', retryAfterMs: 10_000 });
});

it('fails terminally when GitHub asks for a retry beyond the one-hour policy bound', async () => {
  const fixture = provider({ status: 429, headers: { 'retry-after': '3601' } });
  await expect(fixture.client.readCandidate(catalog())).rejects.toMatchObject({ code: 'github_retry_after_too_long' });
});

it.each([
  [401, {}, 'github_access_denied'], [403, {}, 'github_access_denied'], [404, {}, 'github_not_found'],
  [500, {}, 'github_unavailable'], [400, {}, 'github_request_failed'],
  [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'invalid' }, 'github_rate_limited'],
])('maps upstream status %i to a safe provider result', async (status, headers, code) => {
  await expect(provider({ status, headers }).client.readCandidate(catalog())).rejects.toMatchObject({ code });
});

it('accepts a bounded retry timestamp and rejects malformed installation tokens and tree contents', async () => {
  await expect(provider({ status: 429, headers: { 'retry-after': new Date(now + 5000).toUTCString() } }).client.readCandidate(catalog()))
    .rejects.toMatchObject({ code: 'github_rate_limited', retryAfterMs: 5000 });
  await expect(provider({ tokenExpiresAt: new Date(now - 1000).toISOString() }).client.readCandidate(catalog()))
    .rejects.toThrow('github_invalid_token');
  await expect(provider({ repositories: [] }).client.readCandidate(catalog())).rejects.toThrow('github_invalid_token');
  await expect(provider({ files: [] }).client.readCandidate(catalog())).rejects.toMatchObject({ code: 'github_no_pages' });
  await expect(provider({ files: [{ path: 'opaque.bin', content: 'not a docs asset' }] }).client.readCandidate(catalog()))
    .rejects.toMatchObject({ code: 'github_no_pages' });
  await expect(provider({ corruptBlob: true }).client.readCandidate(catalog())).rejects.toMatchObject({ code: 'github_blob_mismatch' });
});

it('rejects a token that exceeds selected repository or read-only permissions', async () => {
  await expect(provider({ tokenPermissions: 'write' }).client.readCandidate(catalog())).rejects.toThrow('github_invalid_token');
  await expect(provider({ repositories: [{ id: 999 }] }).client.readCandidate(catalog())).rejects.toThrow('github_invalid_token');
});

it('rejects malformed token expiry and mismatched branch, commit, and repository identities', async () => {
  const input = { installationId, owner: 'synthetic', name: 'docs', branch, docsPath: 'feature/docs' };
  await expect(provider({ tokenExpiresAt: 'invalid' }).client.readCandidate(catalog())).rejects.toThrow('github_invalid_response');
  await expect(provider({ tokenExpiresAt: new Date(now + 62 * 60_000).toISOString() }).client.verifyRepository(input))
    .rejects.toThrow('github_invalid_token');
  await expect(provider({ returnedRef: 'refs/heads/main' }).client.readCandidate(catalog())).rejects.toThrow('github_invalid_response');
  await expect(provider({ returnedCommitSha: 'f'.repeat(40) }).client.readCandidate(catalog())).rejects.toThrow('github_invalid_response');
  await expect(provider({ repositoryOwner: 'another-owner' }).client.verifyRepository(input)).rejects.toThrow('github_invalid_catalog');
  await expect(provider({ omitRepositories: true }).client.verifyRepository(input)).rejects.toThrow('github_invalid_catalog');
});

it('stops before blob reads when the selected tree exceeds the file-count policy', async () => {
  const fixture = provider({ files: Array.from({ length: LIMITS.maxFiles + 1 }, (_, index) => ({
    path: `page-${index}.md`, content: '# Bounded page',
  })) });
  await expect(fixture.client.readCandidate(catalog())).rejects.toMatchObject({ code: 'github_content_limit' });
  expect(fixture.requests.some(request => request.url.pathname.includes('/git/blobs/'))).toBe(false);
});

it('handles absent, declared-oversize, and streamed-oversize provider bodies without parsing partial JSON', async () => {
  const clientFor = (fetcher: typeof fetch) => createGitHubClient({ githubAppId: appId, githubPrivateKey: privatePem }, fetcher, () => now);
  await expect(clientFor(async () => new Response(null, { status: 201 })).readCandidate(catalog()))
    .rejects.toMatchObject({ code: 'github_invalid_response' });
  await expect(clientFor(async () => new Response('{}', { status: 201,
    headers: { 'content-length': String(LIMITS.maxOAuthResponseBytes + 1) } })).readCandidate(catalog()))
    .rejects.toMatchObject({ code: 'github_response_too_large' });
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(LIMITS.maxOAuthResponseBytes + 1));
    controller.close();
  } });
  await expect(clientFor(async () => new Response(body, { status: 201 })).readCandidate(catalog()))
    .rejects.toMatchObject({ code: 'github_response_too_large' });
  const failedStream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('synthetic stream failure')); } });
  await expect(clientFor(async () => new Response(failedStream, { status: 201 })).readCandidate(catalog()))
    .rejects.toMatchObject({ code: 'github_unavailable' });
});

it('maps network and caller-abort failures safely and rejects unusable catalogues before fetching', async () => {
  const networkFailure = createGitHubClient({ githubAppId: appId, githubPrivateKey: privatePem }, async () => { throw new Error('offline'); }, () => now);
  await expect(networkFailure.readCandidate(catalog())).rejects.toMatchObject({ code: 'github_unavailable' });

  const controller = new AbortController();
  controller.abort();
  const cancelled = createGitHubClient({ githubAppId: appId, githubPrivateKey: privatePem }, async (_input, init) => {
    if (init?.signal?.aborted) throw new Error('aborted');
    return new Response(null, { status: 201 });
  }, () => now);
  await expect(cancelled.readCandidate(catalog(), controller.signal)).rejects.toMatchObject({ code: 'github_cancelled' });

  const disabled = catalog();
  disabled.enabled = false;
  await expect(provider().client.readCandidate(disabled)).rejects.toMatchObject({ code: 'github_catalog_unavailable' });
  const blocked = catalog();
  blocked.accessState = 'blocked';
  await expect(provider().client.readCandidate(blocked)).rejects.toMatchObject({ code: 'github_catalog_unavailable' });
  const client = provider().client;
  await expect(client.readCandidate({})).rejects.toMatchObject({ code: 'github_invalid_catalog' });
  await expect(client.verifyRepository({ installationId, owner: '../unsafe', name: 'docs', branch, docsPath: 'feature/docs' }))
    .rejects.toMatchObject({ code: 'github_invalid_catalog' });
});

it('selects nested metadata and supported assets while rejecting noncanonical and oversized paths', async () => {
  const fixture = provider({ files: [
    { path: 'index.md', content: '# Synthetic docs' },
    { path: 'guides/meta.json', content: '{"title":"Guides"}' },
    { path: 'guides/notes.json', content: '{}' },
    { path: 'guides/readme.txt', content: 'Attachment' },
  ] });
  const candidate = await fixture.client.readCandidate(catalog());
  expect(candidate.files.map(file => file.path)).toEqual(['index.md', 'guides/meta.json', 'guides/notes.json', 'guides/readme.txt']);
  await expect(provider({ files: [{ path: 'index.md', content: '# Synthetic docs' }, { path: 'guides', content: '', mode: '040000', type: 'tree' }] })
    .client.readCandidate(catalog())).resolves.toMatchObject({ files: [{ path: 'index.md' }] });
  await expect(provider({ files: [{ path: 'index.md', content: '# Synthetic docs' }, { path: 'guides', content: '', type: 'tree' }] })
    .client.readCandidate(catalog())).rejects.toMatchObject({ code: 'github_unsafe_entry' });
  await expect(provider({ files: [{ path: '../index.md', content: '# Escaped' }] }).client.readCandidate(catalog()))
    .rejects.toMatchObject({ code: 'github_unsafe_path' });
  await expect(provider({ files: [{ path: 'too-large.pdf', content: 'x'.repeat(LIMITS.maxAssetBytes + 1) }] }).client.readCandidate(catalog()))
    .rejects.toMatchObject({ code: 'github_content_limit' });
});

it('fetches supported Markdown and MDX only from the configured docs subtree', async () => {
  const fixture = provider({ files: [
    { path: 'index.mdx', content: '# Safe MDX' },
    { path: '.mintignore', content: '*.tmp' },
    { path: 'runtime/setup.md', content: '# Setup' },
    { path: 'runtime/archive.zip', content: 'not imported' },
  ] });
  const result = await fixture.client.readCandidate(catalog());
  expect(result.files.map(file => file.path)).toEqual(['index.mdx', 'runtime/setup.md']);
  expect(fixture.requests.filter(request => request.url.pathname.includes('/git/blobs/'))).toHaveLength(2);
});
