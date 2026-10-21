import { expect, test } from '@playwright/test';

test.use({ ignoreHTTPSErrors: true });

const setupOrigin = 'https://localhost:3200';
const fixtureOrigin = 'http://127.0.0.1:3101';

test('keeps the legacy instance catalog and nested routes available when the new namespace collides', async ({ page }) => {
  const prepared = await fetch(`${fixtureOrigin}/migration/prepare-collision`, { method: 'POST' });
  expect(prepared.status).toBe(204);

  for (const [path, heading] of [['/instance/setup', 'Legacy Setup Route'], ['/instance/settings', 'Legacy Settings Route']]) {
    const response = await page.request.get(`${setupOrigin}${path}`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(heading);
  }

  const home = await page.goto(`${setupOrigin}/`, { waitUntil: 'domcontentloaded' });
  expect(home?.status()).toBe(200);
  expect(page.url()).toBe(`${setupOrigin}/`);
  await expect(page.getByRole('link', { name: 'Legacy Instance Catalog Public' })).toHaveAttribute('href', '/instance');

  for (const [path, heading] of [
    ['/instance/setup', 'Legacy Setup Route'],
    ['/instance/settings', 'Legacy Settings Route'],
  ]) {
    const response = await page.goto(`${setupOrigin}${path}`, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
    expect(page.url()).toBe(`${setupOrigin}${path}`);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Instance Settings' })).toHaveCount(0);
  }
});
