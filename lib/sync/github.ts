import { createHash, sign } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { CatalogSchema, newCatalogRecord, type Catalog } from '../catalog';
import { LIMITS } from '../limits';
import { canonicalPath, isDocumentPath } from '../content/paths';

export type BlobCache = {
  get(sha: string, size: number): Promise<Buffer | undefined>;
  put(sha: string, bytes: Buffer): Promise<void>;
};

export function blobSha(bytes: Buffer) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const tokenSchema = z.object({
  token: z.string().min(1).max(4096),
  expires_at: z.iso.datetime(),
  permissions: z.object({ contents: z.string().max(16).optional() }).passthrough(),
  repositories: z.array(z.object({ id: z.number().int().positive() }).passthrough()).optional(),
}).passthrough();
const refSchema = z.object({ ref: z.string(), object: z.object({ type: z.literal('commit'), sha }).passthrough() }).passthrough();
const commitSchema = z.object({ sha, tree: z.object({ sha }).passthrough() }).passthrough();
const repositorySchema = z.object({ id: z.number().int().positive(), name: z.string().min(1), private: z.boolean(),
  owner: z.object({ login: z.string().min(1) }).passthrough() }).passthrough();
const treeEntrySchema = z.object({
  path: z.string().min(1).max(LIMITS.maxPathBytes), mode: z.string().regex(/^\d{6}$/),
  type: z.enum(['blob', 'tree', 'commit']), sha, size: z.number().int().nonnegative().optional(),
}).passthrough();
const treeSchema = z.object({ sha, truncated: z.boolean(), tree: z.array(treeEntrySchema).max(100_000) }).passthrough();

export class GitHubError extends Error {
  constructor(readonly code: string, readonly retryAfterMs?: number) { super(code); }
}

function parseRetryAfter(response: Response, now: number) {
  const raw = response.headers.get('retry-after');
  let ms: number | undefined;
  if (raw && /^\d+(?:\.\d+)?$/.test(raw)) ms = Number(raw) * 1000;
  else if (raw) { const timestamp = Date.parse(raw); if (Number.isFinite(timestamp)) ms = timestamp - now; }
  if (ms === undefined && response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    if (Number.isFinite(reset)) ms = reset - now;
  }
  return { ms: ms !== undefined && ms >= 0 && ms <= LIMITS.maxRetryAfterMs ? Math.ceil(ms) : undefined,
    tooLong: ms !== undefined && ms > LIMITS.maxRetryAfterMs };
}

function statusError(response: Response, now: number) {
  if (response.status === 429 || (response.status === 403 &&
      (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))) {
    const retry = parseRetryAfter(response, now);
    return new GitHubError(retry.tooLong ? 'github_retry_after_too_long' : 'github_rate_limited', retry.ms);
  }
  if (response.status === 404) return new GitHubError('github_not_found');
  if (response.status === 401 || response.status === 403) return new GitHubError('github_access_denied');
  if (response.status >= 500) return new GitHubError('github_unavailable');
  return new GitHubError('github_request_failed');
}

async function readBytes(response: Response, maximum: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
    await response.body?.cancel();
    throw new GitHubError('github_response_too_large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new GitHubError('github_response_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError('github_unavailable');
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function base64url(value: unknown) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

export function createGitHubClient(
  config: { githubAppId: string; githubPrivateKey: string }, fetcher: typeof fetch = fetch, now = () => Date.now(),
) {
  function appJwt() {
    const seconds = Math.floor(now() / 1000);
    const header = base64url({ alg: 'RS256', typ: 'JWT' });
    const payload = base64url({ iat: seconds - 30, exp: seconds + 9 * 60, iss: config.githubAppId });
    const unsigned = `${header}.${payload}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), config.githubPrivateKey).toString('base64url')}`;
  }

  async function request(path: string, options: {
    token: string; method?: 'GET' | 'POST'; body?: unknown; expected: number; maximum: number;
    accept?: string; signal?: AbortSignal;
  }) {
    const timeout = AbortSignal.timeout(LIMITS.upstreamTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers = new Headers({
      accept: options.accept ?? 'application/vnd.github+json', authorization: `Bearer ${options.token}`,
      'user-agent': 'Librarian', 'x-github-api-version': '2026-03-10',
    });
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    let response: Response;
    try {
      response = await fetcher(new URL(path, 'https://api.github.com'), {
        method: options.method ?? 'GET', headers, redirect: 'error', signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      if (options.signal?.aborted) throw new GitHubError('github_cancelled');
      throw new GitHubError(timeout.aborted ? 'github_timeout' : 'github_unavailable');
    }
    if (response.status !== options.expected) {
      await response.body?.cancel();
      throw statusError(response, now());
    }
    try { return await readBytes(response, options.maximum); }
    catch (error) {
      if (options.signal?.aborted) throw new GitHubError('github_cancelled');
      if (timeout.aborted) throw new GitHubError('github_timeout');
      throw error;
    }
  }

  async function json<T>(path: string, options: Parameters<typeof request>[1], schema: z.ZodType<T>): Promise<T> {
    const bytes = await request(path, options);
    try { return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError('github_invalid_response');
    }
  }

  async function installationToken(catalog: Catalog, signal: AbortSignal) {
    const response = await json(`/app/installations/${catalog.github.installationId}/access_tokens`, {
      token: appJwt(), method: 'POST', expected: 201, maximum: LIMITS.maxOAuthResponseBytes, signal,
      body: { repository_ids: [catalog.github.repositoryId], permissions: { contents: 'read' } },
    }, tokenSchema);
    const expiry = Date.parse(response.expires_at);
    if (response.permissions.contents !== 'read' || !Number.isFinite(expiry) || expiry <= now() || expiry > now() + 61 * 60_000 ||
        (response.repositories !== undefined && !response.repositories.some(repository => repository.id === catalog.github.repositoryId))) {
      throw new GitHubError('github_invalid_token');
    }
    return response.token;
  }

  async function getCurrentHead(catalog: Catalog, token: string, signal: AbortSignal) {
    const repo = `${encodeURIComponent(catalog.github.owner)}/${encodeURIComponent(catalog.github.name)}`;
    const ref = catalog.github.branch.split('/').map(encodeURIComponent).join('/');
    const value = await json(`/repos/${repo}/git/ref/heads/${ref}`, {
      token, expected: 200, maximum: LIMITS.maxOAuthResponseBytes, signal,
    }, refSchema);
    if (value.ref !== `refs/heads/${catalog.github.branch}`) throw new GitHubError('github_invalid_response');
    return value.object.sha;
  }

  async function verifyRepository(inputValue: unknown) {
    const input = z.object({ installationId: z.number().int().positive(), owner: z.string(), name: z.string(), branch: z.string(), docsPath: z.string() }).strict().parse(inputValue);
    let validated: Catalog;
    try {
      validated = newCatalogRecord({ github: { ...input, repositoryId: 1 }, slug: 'source-check', title: 'Source check', visibility: 'private' });
    } catch { throw new GitHubError('github_invalid_catalog'); }
    const signal = AbortSignal.timeout(LIMITS.attemptTimeoutMs);
    const tokenResult = await json(`/app/installations/${input.installationId}/access_tokens`, {
      token: appJwt(), method: 'POST', expected: 201, maximum: LIMITS.maxOAuthResponseBytes, signal,
      body: { repositories: [validated.github.name], permissions: { contents: 'read' } },
    }, tokenSchema);
    const expires = Date.parse(tokenResult.expires_at);
    if (tokenResult.permissions.contents !== 'read' || !Number.isFinite(expires) || expires <= now() ||
        expires > now() + 61 * 60_000) throw new GitHubError('github_invalid_token');
    const repo = `${encodeURIComponent(validated.github.owner)}/${encodeURIComponent(validated.github.name)}`;
    const repository = await json(`/repos/${repo}`, { token: tokenResult.token, expected: 200,
      maximum: LIMITS.maxOAuthResponseBytes, signal }, repositorySchema);
    if (repository.owner.login.toLowerCase() !== validated.github.owner.toLowerCase() ||
        repository.name.toLowerCase() !== validated.github.name.toLowerCase() ||
        !tokenResult.repositories || tokenResult.repositories.length !== 1 || tokenResult.repositories[0].id !== repository.id) {
      throw new GitHubError('github_invalid_catalog');
    }
    const catalog = { ...validated, github: { ...validated.github, repositoryId: repository.id } };
    const commitSha = await getCurrentHead(catalog, tokenResult.token, signal);
    const commit = await json(`/repos/${repo}/git/commits/${commitSha}`, { token: tokenResult.token,
      expected: 200, maximum: LIMITS.maxOAuthResponseBytes, signal }, commitSchema);
    if (commit.sha !== commitSha) throw new GitHubError('github_invalid_response');
    let treeSha = commit.tree.sha;
    for (const segment of catalog.github.docsPath.split('/')) {
      const entries = await getTree(catalog, tokenResult.token, treeSha, false, signal);
      const entry = entries.find(item => item.path === segment);
      if (!entry || entry.type !== 'tree' || entry.mode !== '040000') throw new GitHubError('github_docs_missing');
      treeSha = entry.sha;
    }
    return { repositoryId: repository.id, owner: repository.owner.login, name: repository.name,
      isPrivate: repository.private, commitSha };
  }

  async function getTree(catalog: Catalog, token: string, treeSha: string, recursive: boolean, signal: AbortSignal) {
    const repo = `${encodeURIComponent(catalog.github.owner)}/${encodeURIComponent(catalog.github.name)}`;
    const value = await json(`/repos/${repo}/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`, {
      token, expected: 200, maximum: LIMITS.maxGitHubTreeBytes, signal,
    }, treeSchema);
    if (value.sha !== treeSha || value.truncated) throw new GitHubError('github_tree_invalid');
    return value.tree;
  }

  return {
    verifyRepository,
    async readCandidate(input: unknown, externalSignal?: AbortSignal, cache?: BlobCache) {
      let catalog: Catalog;
      try { catalog = CatalogSchema.parse(input); }
      catch { throw new GitHubError('github_invalid_catalog'); }
      if (!catalog.enabled || catalog.accessState !== 'ready') throw new GitHubError('github_catalog_unavailable');
      const deadline = AbortSignal.timeout(LIMITS.attemptTimeoutMs);
      const signal = externalSignal ? AbortSignal.any([externalSignal, deadline]) : deadline;
      try {
        const token = await installationToken(catalog, signal);
        const commitSha = await getCurrentHead(catalog, token, signal);
        const repo = `${encodeURIComponent(catalog.github.owner)}/${encodeURIComponent(catalog.github.name)}`;
        const commit = await json(`/repos/${repo}/git/commits/${commitSha}`, {
          token, expected: 200, maximum: LIMITS.maxOAuthResponseBytes, signal,
        }, commitSchema);
        if (commit.sha !== commitSha) throw new GitHubError('github_invalid_response');

        let selectedTreeSha = commit.tree.sha;
        for (const segment of catalog.github.docsPath.split('/')) {
          const entries = await getTree(catalog, token, selectedTreeSha, false, signal);
          const entry = entries.find(item => item.path === segment);
          if (!entry || entry.type !== 'tree' || entry.mode !== '040000') throw new GitHubError('github_docs_missing');
          selectedTreeSha = entry.sha;
        }
        const entries = await getTree(catalog, token, selectedTreeSha, true, signal);
        const files: Array<{ path: string; mode: string; sha: string; size: number }> = [];
        let totalBytes = 0;
        let pages = 0;
        for (const entry of entries) {
          let path: string;
          try { path = canonicalPath(entry.path); }
          catch { throw new GitHubError('github_unsafe_path'); }
          if (entry.type === 'tree') {
            if (entry.mode !== '040000') throw new GitHubError('github_unsafe_entry');
            continue;
          }
          if (entry.type !== 'blob' || entry.mode !== '100644') throw new GitHubError('github_unsafe_entry');
          const basename = posix.basename(path);
          const extension = posix.extname(path).toLowerCase();
          const markdown = isDocumentPath(path);
          const metadata = basename === 'meta.json';
          const asset = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.csv', '.json'].includes(extension);
          const maximum = markdown ? LIMITS.maxMarkdownBytes : metadata ? LIMITS.maxMetadataBytes : asset ? LIMITS.maxAssetBytes : -1;
          if (maximum < 0) continue;
          if (entry.size === undefined || entry.size > maximum) throw new GitHubError('github_content_limit');
          files.push({ path, mode: entry.mode, sha: entry.sha, size: entry.size });
          totalBytes += entry.size;
          if (markdown) pages++;
          if (files.length > LIMITS.maxFiles || pages > LIMITS.maxPages || totalBytes > LIMITS.maxSnapshotBytes) {
            throw new GitHubError('github_content_limit');
          }
        }
        if (!pages) throw new GitHubError('github_no_pages');

        const controller = new AbortController();
        const blobSignal = AbortSignal.any([signal, controller.signal]);
        let index = 0;
        const blobs = new Map<string, Promise<Buffer>>();
        const readBlob = (file: typeof files[number]) => {
          let pending = blobs.get(file.sha);
          if (!pending) {
            pending = (async () => {
              blobSignal.throwIfAborted();
              let bytes: Buffer | undefined;
              try { bytes = await cache?.get(file.sha, file.size); }
              catch (error) {
                blobSignal.throwIfAborted();
                if (error instanceof Error && error.message === 'generation_invalid_path') throw error;
              }
              if (!bytes || bytes.length !== file.size || blobSha(bytes) !== file.sha) {
                bytes = await request(`/repos/${repo}/git/blobs/${file.sha}`, {
                  token, expected: 200, maximum: file.size, accept: 'application/vnd.github.raw+json', signal: blobSignal,
                });
                if (bytes.length !== file.size || blobSha(bytes) !== file.sha) throw new GitHubError('github_blob_mismatch');
                blobSignal.throwIfAborted();
                try { await cache?.put(file.sha, bytes); }
                catch (error) {
                  blobSignal.throwIfAborted();
                  if (error instanceof Error && error.message === 'generation_invalid_path') throw error;
                }
              }
              return bytes;
            })();
            blobs.set(file.sha, pending);
          }
          return pending;
        };
        const content = new Array<{ path: string; mode: string; content: Buffer }>(files.length);
        const workers = Array.from({ length: Math.min(LIMITS.fetchConcurrency, files.length) }, async () => {
          while (true) {
            const current = index++;
            if (current >= files.length) return;
            try {
              const file = files[current];
              const bytes = await readBlob(file);
              if (bytes.length !== file.size) throw new GitHubError('github_blob_mismatch');
              content[current] = { path: file.path, mode: file.mode, content: bytes };
            } catch (error) {
              controller.abort();
              throw error;
            }
          }
        });
        await Promise.all(workers);
        if (await getCurrentHead(catalog, token, signal) !== commitSha) throw new GitHubError('github_head_changed');
        return { commitSha, treeSha: commit.tree.sha, files: content };
      } catch (error) {
        if (externalSignal?.aborted) throw new GitHubError('github_cancelled');
        if (deadline.aborted) throw new GitHubError('github_timeout');
        throw error;
      }
    },
  };
}
