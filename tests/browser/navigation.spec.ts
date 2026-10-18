import { expect, test } from '@playwright/test';

test('generation-pinned active page stays highlighted in its selected section', async ({ page }) => {
  await page.goto('/public-project');
  const guide = page.getByRole('link', { name: 'setup guide', exact: true });
  const href = await guide.getAttribute('href');
  expect(href).toMatch(/^\/public-project\/guides\/setup\?g=[0-9a-f-]{36}#first-step$/i);
  await guide.click();

  const sidebar = page.locator('#nd-sidebar');
  await expect(sidebar.locator('button[aria-haspopup="dialog"]')).toContainText('Guides');
  const activePage = sidebar.getByRole('link', { name: 'Setup', exact: true });
  await expect(activePage).toHaveAttribute('data-active', 'true');
  await expect(activePage).toHaveAttribute('href', /\?g=[0-9a-f-]{36}$/i);
  await expect(activePage).toHaveCSS('display', 'flex');
  await expect(activePage).toHaveCSS('gap', '8px');
});

test('keyboard search and directory-based project switching stay within the selected generation and repository', async ({ page }) => {
  await page.goto('/public-project');
  const trigger = page.locator('#nd-sidebar').getByRole('button', { name: /^Search/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const search = page.getByRole('combobox', { name: 'Search' });
  await expect(search).toBeFocused();
  const searchResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/search/public-project' && url.searchParams.get('query') === 'setup';
  });
  await search.fill('setup');
  expect((await searchResponse).status()).toBe(200);
  const result = page.getByRole('option').first();
  await expect(result).toBeVisible();
  await expect(result).toContainText(/setup/i);
  await result.click();
  await expect(page).toHaveURL(/\/public-project\/guides\/setup\?g=[0-9a-f-]{36}$/i);
  await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();
  await expect(page.locator('#nd-sidebar summary[aria-label^="Select project"]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.locator('a[href="/other-project"]').first().click();
  await expect(page).toHaveURL(/\/other-project$/);
  await expect(page.getByRole('heading', { name: 'Other Project', exact: true })).toBeVisible();
  expect(await page.locator('body').innerText()).toContain('telescope');
  expect(await page.locator('body').innerText()).not.toContain('Setup fixture content.');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.locator('a[href="/private-one"]').first().click();
  await expect(page.getByRole('heading', { name: 'Restricted project' })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('SYNTHETIC_PRIVATE_BROWSER_SENTINEL');
});

test.describe('mobile sidebar search', () => {
  test.use({ viewport: { width: 390, height: 850 } });

  test('mobile sidebar search opens a focused dialog within the viewport', async ({ page }) => {
    await page.goto('/public-project');
    await page.getByRole('button', { name: 'Open Sidebar' }).click();

    const drawer = page.locator('#nd-sidebar-mobile');
    await drawer.getByRole('button', { name: 'Close Sidebar' }).click();
    await page.getByRole('button', { name: 'Open Search' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox', { name: 'Search' });
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    const bounds = await input.evaluate(element => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom, width: window.innerWidth, height: window.innerHeight };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  });
});
