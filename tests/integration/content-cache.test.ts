import { expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { searchContent } from '../../lib/content/search';
import { cacheRuntimeSearch, withRuntimeContent, type RuntimeContent } from '../../lib/content/source';
import type { Catalog } from '../../lib/catalog';
import { seedRuntimeCatalog } from './runtime-fixtures';

it('reuses a bounded generation loader and search index only after current authorization', async () => {
  const storage = await seedRuntimeCatalog();
  try {
    let first: RuntimeContent | undefined;
    const initial = await withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async content => {
      first = content;
      return searchContent(content, 'setup');
    });
    expect(initial.length).toBeGreaterThan(0);
    expect(first?.searchApi).toBeDefined();
    expect(first!.searchBytes).toBeGreaterThan(0);
    expect(cacheRuntimeSearch(first!, first!.searchApi!, first!.searchBytes)).toBe(true);
    const uncached: RuntimeContent = { ...first!, cacheKey: `${storage.catalog._id}:not-cached`, searchApi: undefined, searchBytes: 0 };
    expect(cacheRuntimeSearch(uncached, first!.searchApi!, 1)).toBe(false);
    expect(uncached.searchApi).toBeUndefined();

    await writeFile(join(storage.root, 'guides', 'setup.md'), '# Mutated storage content');
    const reused = await withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async content => {
      expect(content).toBe(first);
      return searchContent(content, 'setup');
    });
    expect(reused).toEqual(initial);

    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.catalog._id }, { $set: { visibility: 'private', approvalRef: null } });
    const deniedRead = vi.fn();
    await expect(withRuntimeContent(storage.db, storage.contentRoot, storage.catalog.slug, undefined, async () => deniedRead()))
      .rejects.toThrow('unauthorized');
    expect(deniedRead).not.toHaveBeenCalled();
  } finally { await storage.close(); }
});
