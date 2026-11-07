import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { expect, test } from '@playwright/test';
import { refreshAdminAuthorization } from './admin-fixture';

const readerCookie = (browser: string) => ({ name: 'authjs.session-token', value: `synthetic-browser-reader-${browser}-session`, url: 'http://127.0.0.1:3100' });
const adminCookie = { name: 'authjs.session-token', value: 'synthetic-browser-admin-session', url: 'http://127.0.0.1:3100' };
const wrongRoleCookie = { name: 'authjs.session-token', value: 'synthetic-browser-wrong-role-session', url: 'http://127.0.0.1:3100' };
const wrongProjectCookie = { name: 'authjs.session-token', value: 'synthetic-browser-wrong-project-session', url: 'http://127.0.0.1:3100' };
const expiredCookie = { name: 'authjs.session-token', value: 'synthetic-browser-expired-session', url: 'http://127.0.0.1:3100' };

test.beforeEach(async () => {
  await refreshAdminAuthorization();
  const { dbName } = JSON.parse(await readFile('.local/browser-state.json', 'utf8')) as { dbName: string };
  const client = new MongoClient(`mongodb://127.0.0.1:27018/${dbName}`);
  await client.connect();
  try {
    // The cross-browser suite outlasts the real role freshness window.
    const refreshed = await client.db(dbName).collection('identity_authorizations').updateOne(
      { subject: 'synthetic-browser-reader-subject' }, { $set: { verifiedAt: new Date() } });
    expect(refreshed.matchedCount).toBe(1);
  } finally { await client.close(); }
});

test('anonymous restricted pages show only a safe denial and a local sign-in return', async ({ page }) => {
  const response = await page.goto('/private-one');
  expect([200, 404]).toContain(response?.status());
  await expect(page.getByRole('heading', { name: 'Restricted project' })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('SYNTHETIC_PRIVATE_BROWSER_SENTINEL');
  await expect(page.getByRole('button', { name: 'Sign in with Zitadel' })).toBeVisible();
});

test('private HTML, RSC, metadata, search and assets authorize every identity and cache path', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const paths = ['/private-one', '/private-one/guides/setup'];
  const searchPath = '/api/search/private-one?query=SYNTHETIC_PRIVATE_BROWSER_SENTINEL';
  const assetPath = '/api/assets/private-one/pixel.png';
  const deniedIdentities = [undefined, adminCookie, wrongRoleCookie, wrongProjectCookie, expiredCookie];
  const assertDenied = async (cookie: typeof adminCookie | undefined) => {
    await page.context().clearCookies();
    if (cookie) await page.context().addCookies([cookie]);
    for (const path of paths) {
      const html = await page.request.get(path);
      expect([200, 404]).toContain(html.status());
      const body = await html.text();
      expect(body).not.toContain('SYNTHETIC_PRIVATE_BROWSER_SENTINEL');
      expect(body).not.toContain('SYNTHETIC_PRIVATE_ARTICLE_SENTINEL');
      expect(body).not.toContain('Private Guides');
      expect(body).not.toContain('<title>Private Fixture</title>');
      expect(body).not.toContain('<title>Private Article</title>');
      const rsc = await page.request.get(path, { headers: { rsc: '1', accept: 'text/x-component', 'next-url': path } });
      expect([200, 404]).toContain(rsc.status());
      const flight = await rsc.text();
      expect(flight).not.toContain('SYNTHETIC_PRIVATE_BROWSER_SENTINEL');
      expect(flight).not.toContain('SYNTHETIC_PRIVATE_ARTICLE_SENTINEL');
      expect(flight).not.toContain('Private Guides');
    }
    const search = await page.request.get(searchPath);
    expect(search.status()).toBe(404);
    expect(await search.text()).not.toContain('SYNTHETIC_PRIVATE_BROWSER_SENTINEL');
    expect((await page.request.get(assetPath)).status()).toBe(404);
    expect((await page.request.head(assetPath)).status()).toBe(404);
    expect((await page.request.get(assetPath, { headers: { 'if-none-match': '*' } })).status()).toBe(404);
    const publicPage = await page.request.get('/public-project');
    expect(publicPage.status()).toBe(200);
    expect(await publicPage.text()).toContain('Synthetic Portal');
  };
  for (const cookie of deniedIdentities) await assertDenied(cookie);

  await page.context().clearCookies();
  await page.context().addCookies([readerCookie(testInfo.project.name)]);
  const overview = await page.request.get(paths[0]);
  expect(overview.status()).toBe(200);
  const overviewHtml = await overview.text();
  expect(overviewHtml).toContain('SYNTHETIC_PRIVATE_BROWSER_SENTINEL');
  expect(overviewHtml).toContain('Private Guides');
  expect(overviewHtml).toContain('<title>Private Fixture</title>');
  const article = await page.request.get(paths[1]);
  expect(article.status()).toBe(200);
  const articleHtml = await article.text();
  expect(articleHtml).toContain('SYNTHETIC_PRIVATE_ARTICLE_SENTINEL');
  expect(articleHtml).toContain('<title>Private Article</title>');
  for (const path of paths) {
    const rsc = await page.request.get(path, { headers: { rsc: '1', accept: 'text/x-component', 'next-url': path } });
    expect(rsc.status()).toBe(200);
    expect(rsc.headers()['content-type']).toContain('text/x-component');
    expect(await rsc.text()).toMatch(/SYNTHETIC_PRIVATE_(?:BROWSER|ARTICLE)_SENTINEL/);
  }
  const search = await page.request.get(searchPath);
  expect(search.status()).toBe(200);
  expect(await search.text()).toContain('SYNTHETIC_PRIVATE_BROWSER_SENTINEL');
  const image = await page.request.get(assetPath);
  expect(image.status()).toBe(200);
  expect(image.headers()['content-type']).toContain('image/png');
  const etag = image.headers().etag;
  expect(etag).toBeTruthy();
  const head = await page.request.head(assetPath);
  expect(head.status()).toBe(200);
  expect(await head.body()).toHaveLength(0);
  expect((await page.request.get(assetPath, { headers: { 'if-none-match': etag! } })).status()).toBe(304);
  for (const cookie of deniedIdentities) await assertDenied(cookie);
});

test('history restoration performs a fresh private read after pagehide', async ({ page }, testInfo) => {
  await page.context().addCookies([readerCookie(testInfo.project.name)]);
  await page.goto('/private-one');
  await expect(page.getByRole('heading', { name: 'SYNTHETIC_PRIVATE_BROWSER_SENTINEL' })).toBeVisible();
  await page.goto('/public-project');
  await expect(page.getByRole('heading', { name: 'Synthetic Portal', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'SYNTHETIC_PRIVATE_BROWSER_SENTINEL' })).toBeVisible();
});

test('authorized private readers lose protected content after cross-tab sign-out', async ({ page }, testInfo) => {
  await page.context().addCookies([readerCookie(testInfo.project.name)]);
  await page.goto('/private-one');
  expect([200, 404]).toContain((await page.request.get('/private-one')).status());
  await expect(page.getByRole('heading', { name: 'SYNTHETIC_PRIVATE_BROWSER_SENTINEL' })).toBeVisible();

  const sibling = await page.context().newPage();
  await sibling.goto('/private-one');
  await expect(sibling.getByRole('heading', { name: 'SYNTHETIC_PRIVATE_BROWSER_SENTINEL' })).toBeVisible();

  const csrfResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/csrf');
  await page.getByRole('button', { name: 'Sign out' }).click();
  expect((await csrfResponse).status()).toBe(200);
  await expect(page).toHaveURL('http://127.0.0.1:3100/');
  await expect(sibling).toHaveURL('http://127.0.0.1:3100/');
  await expect(page.getByText('SYNTHETIC_PRIVATE_BROWSER_SENTINEL')).toHaveCount(0);
  await expect(sibling.getByText('SYNTHETIC_PRIVATE_BROWSER_SENTINEL')).toHaveCount(0);

  const denied = await page.request.get('/private-one');
  expect(await denied.text()).not.toContain('SYNTHETIC_PRIVATE_BROWSER_SENTINEL');
  await sibling.close();
});
