import { expect, it } from 'vitest';
import { CatalogSchema, type Catalog } from '../../lib/catalog';
import { catalogs, privateSentinels } from '../fixtures/catalogs';
import { seedRuntimeCatalog } from './runtime-fixtures';
import { startConfiguredApp } from './configured-app';

it('serves the safe directory, a generation-pinned public reader, scoped search and guarded assets over real Next HTTP', async () => {
  const storage = await seedRuntimeCatalog();
  let server: Awaited<ReturnType<typeof startConfiguredApp>> | undefined;
  try {
    await storage.db.collection<Catalog>('catalogs').insertOne(CatalogSchema.parse(catalogs[1]));
    server = await startConfiguredApp(storage, 3191);
    const home = await fetch(server.origin);
    const directory = await home.text();
    expect(home.status).toBe(200);
    expect(directory).toContain('Public Project');
    expect(directory).toContain('Restricted One');
    expect(directory).not.toContain(privateSentinels[0]);

    const reader = await fetch(`${server.origin}/public-project?g=${storage.generationId}`);
    const article = await reader.text();
    expect(reader.status).toBe(200);
    expect(article).toContain('Synthetic Portal');
    expect(article).toContain('Read the');
    expect(article).toContain(storage.generationId);
    expect(article).toContain(`/public-project/guides/setup?g=${storage.generationId}`);
    expect(article).toContain(`/api/assets/public-project/pixel.png?g=${storage.generationId}`);
    expect(article).not.toContain(privateSentinels[0]);

    const search = await fetch(`${server.origin}/api/search/public-project?query=Fixture&g=${storage.generationId}`);
    const results = await search.json();
    expect(search.status).toBe(200);
    expect(search.headers.get('cache-control')).toBe('private, no-store');
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(results)).toContain(storage.generationId);
    expect(JSON.stringify(results)).not.toContain(privateSentinels[0]);

    const image = await fetch(`${server.origin}/api/assets/public-project/pixel.png?g=${storage.generationId}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    const attachment = await fetch(`${server.origin}/api/assets/public-project/notes.txt?g=${storage.generationId}`);
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get('content-disposition')).toContain('attachment');
    const conditional = await fetch(`${server.origin}/api/assets/public-project/notes.txt?g=${storage.generationId}`, { headers: { 'If-None-Match': attachment.headers.get('etag')! } });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('cache-control')).toBe('private, no-store');

    const privateReader = await fetch(`${server.origin}/private-one`);
    const denied = await privateReader.text();
    expect(denied).toContain('Page unavailable');
    expect(denied).not.toContain('Restricted One');
    expect(denied).not.toContain(privateSentinels[0]);
  } finally {
    if (server) await server.close();
    await storage.close();
  }
});
