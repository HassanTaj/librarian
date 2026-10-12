import { expect, it } from 'vitest';
import { searchContent } from '../../lib/content/search';
import { withRuntimeContent } from '../../lib/content/source';
import { LIMITS } from '../../lib/limits';
import { seedRuntimeCatalog } from './runtime-fixtures';

it('freezes the pinned Fumadocs live-search result shape to the selected repository and generation', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    const results = await withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, content =>
      searchContent(content, 'setup'));
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(LIMITS.maxSearchResults);
    expect(Object.keys(results[0]).sort()).toEqual(['breadcrumbs', 'content', 'id', 'type', 'url']);
    expect(results.every(result => typeof result.content === 'string' && typeof result.url === 'string' &&
      result.url.startsWith('/public-project') && result.url.includes(`g=${storage.generationId}`))).toBe(true);
    expect(JSON.stringify(results)).not.toContain('private-one');
  } finally { await storage.close(); }
});

it('returns an authorized empty-query result and rejects overlong UTF-8 input', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    await expect(withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, content =>
      searchContent(content, ''))).resolves.toEqual([]);
    await expect(withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, content =>
      searchContent(content, '🙂'.repeat(65)))).rejects.toThrow('invalid_query');
  } finally { await storage.close(); }
});

it('blocks private search before creating an index from private document bodies', async () => {
  const storage = await seedRuntimeCatalog('private');
  try {
    await expect(withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, content =>
      searchContent(content, 'Fixture content'))).rejects.toThrow('unauthorized');
  } finally { await storage.close(); }
});
