import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { expect, test } from '@playwright/test';
import { admitSyncJob, newManualJobId, type SyncJob } from '../../lib/sync/jobs';
import { processNextSyncJob } from '../../lib/sync/worker';

test('a running reader sees a published generation without rebuilding or restarting the app', async ({ page }, testInfo) => {
  const state = JSON.parse(await readFile('.local/browser-state.json', 'utf8')) as {
    dbName: string;
    contentRoot: string;
    syncCatalogIds: Record<string, string>;
  };
  const marker = `SYNC_READER_${testInfo.project.name}_${randomUUID()}`;
  const slug = `sync-reader-${testInfo.project.name}`;
  const client = new MongoClient(`mongodb://127.0.0.1:27018/${state.dbName}`);
  await client.connect();
  try {
    await page.context().addCookies([{ name: 'authjs.session-token', value: `synthetic-browser-sync-reader-${testInfo.project.name}-session`, url: 'http://127.0.0.1:3100' }]);
    await page.goto(`/${slug}`);
    await expect(page.getByRole('heading', { name: `SYNC_READER_BASE_${testInfo.project.name.toUpperCase()}` })).toBeVisible();
    const before = await page.locator('main').innerText();
    const db = client.db(state.dbName);
    const catalog = state.syncCatalogIds[testInfo.project.name];
    await db.collection<SyncJob>('syncJobs').deleteMany({ state: 'queued', catalogId: { $ne: catalog } });
    const key = randomUUID();
    const admitted = await admitSyncJob(db, {
      _id: newManualJobId(catalog, key), catalogId: catalog, origin: 'manual', event: 'manual',
      payloadDigest: key.replaceAll('-', '').padEnd(64, '0'),
    });
    expect(admitted.duplicate).toBe(false);
    const commitSha = randomUUID().replaceAll('-', '').repeat(2).slice(0, 40);
    const guide = `guides/${testInfo.project.name}-live.md`;
    const md = (title: string, body: string) => Buffer.from(`---\n{"title":"${title}"}\n---\n${body}`);
    const pixel = await readFile('tests/fixtures/content/public-project/pixel.png');
    const result = await processNextSyncJob({ db, contentRoot: state.contentRoot, readCandidate: async () => ({
      commitSha, treeSha: commitSha,
      files: [
        { path: 'index.md', mode: '100644', content: md('Updated Private Home', `# ${marker}\n\n[Latest guide](${guide})\n\n![Latest asset](latest.png)`) },
        { path: guide, mode: '100644', content: md('Latest Guide', `# ${marker}\n\nPublished while the server remained running.`) },
        { path: 'guides/meta.json', mode: '100644', content: Buffer.from(JSON.stringify({ title: `Updated ${marker}`, pages: [`${testInfo.project.name}-live`], defaultOpen: true })) },
        { path: 'latest.png', mode: '100644', content: pixel },
      ],
    }) });
    const job = await db.collection<SyncJob>('syncJobs').findOne({ _id: admitted.job._id });
    expect(result, JSON.stringify(job?.result)).toBe('succeeded');

    await page.reload();
    await expect(page.getByRole('heading', { name: marker })).toBeVisible();
    expect(await page.locator('main').innerText()).not.toBe(before);
    const article = await page.request.get(`/${slug}/guides/${testInfo.project.name}-live`);
    expect(article.status()).toBe(200);
    expect(await article.text()).toContain(marker);
    const search = await page.request.get(`/api/search/${slug}?query=${encodeURIComponent(marker)}`);
    expect(search.status()).toBe(200);
    expect(await search.text()).toContain(marker);
    const oldGuide = await page.request.get(`/${slug}/guides/setup`);
    expect([200, 404]).toContain(oldGuide.status());
    const oldGuideHtml = await oldGuide.text();
    expect(oldGuideHtml).not.toContain('Original guide before publication.');
    expect(oldGuideHtml).not.toContain('Original Guide');
    expect((await page.request.get(`/api/assets/${slug}/latest.png`)).status()).toBe(200);
  } finally { await client.close(); }
});
