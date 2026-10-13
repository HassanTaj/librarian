import { expect, test } from '@playwright/test';

test('generation-pinned active page expands its sidebar folder and stays highlighted', async ({ page }) => {
  await page.goto('/public-project');
  const guide = page.getByRole('link', { name: 'setup guide', exact: true });
  const href = await guide.getAttribute('href');
  expect(href).toMatch(/^\/public-project\/guides\/setup\?g=[0-9a-f-]{36}#first-step$/i);
  await guide.click();

  const sidebar = page.locator('#nd-sidebar');
  const folder = sidebar.getByRole('button', { name: 'Guides' });
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  const activePage = sidebar.getByRole('link', { name: 'Setup', exact: true });
  await expect(activePage).toHaveAttribute('data-active', 'true');
  await expect(activePage).toHaveAttribute('href', /\?g=[0-9a-f-]{36}$/i);
  await expect(activePage).toHaveCSS('display', 'flex');
  await expect(activePage).toHaveCSS('gap', '8px');
});

test('keyboard search and directory-based project switching stay within the selected generation and repository', async ({ page }) => {
  await page.goto('/public-project');
  const trigger = page.getByRole('button', { name: 'Search this project' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const search = page.getByRole('searchbox', { name: 'Search this project' });
  await expect(search).toBeFocused();
  await search.fill('setup');
  const result = page.locator('#project-search-panel a').first();
  await expect(result).toBeVisible();
  const href = await result.getAttribute('href');
  expect(href).toMatch(/^\/public-project\/guides\/setup\?g=[0-9a-f-]{36}$/i);
  await result.click();
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

test('the project search input stays visible inside the mobile sidebar when opened', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.goto('/public-project');
  await page.getByRole('button', { name: 'Open Sidebar' }).click();

  const drawer = page.locator('#nd-sidebar-mobile');
  await drawer.getByRole('button', { name: 'Search this project' }).click();
  const input = drawer.getByRole('searchbox', { name: 'Search this project' });
  await expect(input).toBeVisible();
  const bounds = await input.evaluate(element => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom, width: window.innerWidth, height: window.innerHeight };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
});
