import { expect, test, type Locator } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 850 } });

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

async function expectRound(locator: Locator) {
  const bounds = await box(locator);
  expect(Math.abs(bounds.width - bounds.height)).toBeLessThanOrEqual(1);
}

test('reader sidebar has round Home, Theme, and sign-out actions with accessible Search', async ({ page }) => {
  await page.context().addCookies([{ name: 'authjs.session-token', value: 'synthetic-browser-admin-session', url: 'http://127.0.0.1:3100' }]);
  await page.goto('/public-project');

  const sidebar = page.locator('#nd-sidebar');
  const toolbar = sidebar.locator('[data-reader-sidebar-controls]');
  const actions = toolbar.locator('[data-reader-sidebar-actions]');
  const home = actions.getByRole('link', { name: 'Home', exact: true });
  const theme = actions.getByRole('button', { name: 'Toggle Theme' });
  const search = sidebar.getByRole('button', { name: /^Search/ });
  const signOut = toolbar.getByRole('button', { name: 'Sign out' });

  await expect(home).toBeVisible();
  await expect(search).toBeVisible();
  await expect(theme).toBeVisible();
  await expect(signOut).toBeVisible();
  await Promise.all([home, theme, signOut].map(expectRound));

  const homeBounds = await box(home);
  const themeBounds = await box(theme);
  const signOutBounds = await box(signOut);
  const sidebarBounds = await box(sidebar);
  const toolbarBounds = await box(toolbar);
  expect(homeBounds.x).toBeLessThan(themeBounds.x);
  expect(themeBounds.x + themeBounds.width).toBeLessThan(signOutBounds.x);
  expect(toolbarBounds.y).toBeGreaterThan(sidebarBounds.y + sidebarBounds.height - 100);
  expect(signOutBounds.x + signOutBounds.width).toBeLessThanOrEqual(toolbarBounds.x + toolbarBounds.width + 1);
});

test('desktop project search opens a focused dialog', async ({ page }) => {
  await page.goto('/public-project');

  const sidebar = page.locator('#nd-sidebar');
  await sidebar.getByRole('button', { name: /^Search/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Search' })).toBeFocused();
});

test.describe('mobile reader actions', () => {
  test.use({ viewport: { width: 390, height: 850 } });

  test('mobile reader keeps Home accessible and opens Search', async ({ page }) => {
    await page.goto('/public-project');

    await expect(page.locator('#nd-subnav').getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open Sidebar' }).click();

    const drawer = page.locator('#nd-sidebar-mobile');
    const toolbar = drawer.locator('[data-reader-sidebar-controls]');
    const actions = toolbar.locator('[data-reader-sidebar-actions]');
    const home = actions.getByRole('link', { name: 'Home', exact: true });
    await expect(home).toBeVisible();
    await expectRound(home);
    await drawer.getByRole('button', { name: 'Close Sidebar' }).click();
    await expect(drawer).not.toBeVisible();

    const search = page.locator('#nd-subnav').getByRole('button', { name: 'Open Search' });
    await expect(search).toBeVisible();
    await search.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox', { name: 'Search' });
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    const bounds = await box(input);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(850);
    await input.fill('Setup');
    await expect(input).toHaveValue('Setup');
  });
});
