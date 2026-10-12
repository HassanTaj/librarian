import { createHash } from 'node:crypto';
import { dynamicLoader } from 'fumadocs-core/source';
import { localMd, type LocalMarkdownPage } from '@fumadocs/local-md';
import type { Root } from 'fumadocs-core/page-tree';
import type { Db } from 'mongodb';
import { createBoundedLru } from './lru';
import { HIGHLIGHT_LANGUAGES, LIMITS } from '../limits';
import { readAuthorizedGeneration, type AuthorizationContext } from '../auth/authorization';
import type { GenerationPin, Manifest } from './generations';
import { generationRoot, openSafeFile } from './paths';
import { validateMarkdown, validateMeta } from './validate';

type RuntimePage = { path: string; slugs: string[]; url: string; data: LocalMarkdownPage<{ title?: string; description?: string; full?: boolean }> };
type RuntimeLoader = { pageTree: Root; getPage: (slugs: string[] | undefined) => RuntimePage | undefined; getPages: () => RuntimePage[] };
type SearchApi = ReturnType<typeof import('fumadocs-core/search/server').createFromSource>;
export type RuntimeContent = { manifest: Manifest; generation: GenerationPin['generation']; loader: RuntimeLoader;
  cacheKey: string; sourceBytes: number; searchBytes: number; searchApi?: SearchApi };
const cache = createBoundedLru<RuntimeContent>(LIMITS.maxCacheEntries, LIMITS.maxCacheBytes, LIMITS.cacheIdleMs);

export function cacheRuntimeSearch(content: RuntimeContent, searchApi: SearchApi, searchBytes: number) {
  if (content.searchApi) return true;
  if (!cache.updateSize(content.cacheKey, content.sourceBytes + searchBytes)) return false;
  content.searchApi = searchApi;
  content.searchBytes = searchBytes;
  return true;
}
async function checkedFile(root: string, file: { path: string; size: number; sha256: string }, signal: AbortSignal) {
  signal.throwIfAborted();
  let handle: Awaited<ReturnType<typeof openSafeFile>> | undefined;
  try {
    handle = await openSafeFile(root, file.path);
    const stat = await handle.stat();
    if (stat.size !== file.size) throw new Error('invalid_content');
    const bytes = await handle.readFile();
    signal.throwIfAborted();
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('invalid_content');
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_content') throw error;
    throw new Error('invalid_content');
  } finally { await handle?.close(); }
}

export async function withRuntimeContent<T>(db: Db, contentRoot: string, slug: string, generationId: string | undefined,
  read: (content: RuntimeContent, signal: AbortSignal, authorization: AuthorizationContext) => Promise<T>, signal?: AbortSignal) {
  let lease: ReturnType<typeof cache.acquire>;
  try {
    return await readAuthorizedGeneration(db, contentRoot, slug, generationId, async (manifest, abort, pin, authorization) => {
      const key = `${pin.catalogId}:${manifest.configRevision}:${slug}:${manifest.generationId}`;
      lease = cache.acquire(key);
      let content = lease?.value;
      if (!content) {
        const root = generationRoot(contentRoot, pin.catalogId, manifest.generationId);
        const pagePaths = manifest.documents.map(file => file.path);
        await Promise.all(manifest.metadata.map(async file => {
          const bytes = await checkedFile(root, file, abort);
          return validateMeta(file.path, bytes, pagePaths);
        }));
        const documents = await Promise.all(manifest.documents.map(async file => {
          const bytes = await checkedFile(root, file, abort);
          const parsed = validateMarkdown(file.path, bytes);
          if (parsed.title !== file.title || (parsed.frontmatter.description ?? '') !== file.description) throw new Error('invalid_content');
          return file.path;
        }));
        const markdown = localMd({
          dir: root,
          include: [...documents, ...manifest.metadata.map(file => file.path)],
          mdOptions: { rehypeCodeOptions: { langs: [...HIGHLIGHT_LANGUAGES], themes: { light: 'github-light', dark: 'github-dark' } } },
        });
        const runtime = dynamicLoader(markdown.dynamicSource(), {
          baseUrl: `/${slug}`,
          url: slugs => `/${slug}${slugs.length ? `/${slugs.map(encodeURIComponent).join('/')}` : ''}?g=${manifest.generationId}`,
        });
        const loader = await runtime.get() as RuntimeLoader;
        abort.throwIfAborted();
        content = { manifest, generation: pin.generation, loader, cacheKey: key,
          sourceBytes: manifest.normalizedBytes, searchBytes: 0 };
        if (cache.set(key, content, content.sourceBytes)) lease = cache.acquire(key);
      }
      return read(content, abort, authorization);
    }, signal);
  } finally { lease?.release(); }
}
