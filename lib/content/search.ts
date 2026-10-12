import { createFromSource } from 'fumadocs-core/search/server';
import type { LoaderOutput } from 'fumadocs-core/source';
import { LIMITS } from '../limits';
import { cacheRuntimeSearch, type RuntimeContent } from './source';

export async function searchContent(content: RuntimeContent, query: string) {
  if (Buffer.byteLength(query, 'utf8') > LIMITS.maxSearchQueryBytes) throw new Error('invalid_query');
  if (!query.trim()) return [];
  const search = content.searchApi ?? createFromSource(content.loader as unknown as LoaderOutput, { search: { limit: LIMITS.maxSearchResults } });
  if (!content.searchApi) {
    const index = await search.export();
    cacheRuntimeSearch(content, search, Buffer.byteLength(JSON.stringify(index), 'utf8'));
  }
  return (await search.search(query, { limit: LIMITS.maxSearchResults })).slice(0, LIMITS.maxSearchResults);
}
