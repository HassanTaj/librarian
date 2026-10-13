import { expect, test, type Locator } from '@playwright/test';

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

async function expectRound(locator: Locator) {
  const bounds = await box(locator);
  expect(Math.abs(bounds.width - bounds.height)).toBeLessThanOrEqual(1);
}

test('reader sidebar has round Home, Search, Theme, and sign-out actions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.context().addCookies([{ name: 'authjs.session-token', value: 'synthetic-browser-admin-session', url: 'http://127.0.0.1:3100' }]);
  await page.goto('/public-project');

  const sidebar = page.locator('#nd-sidebar');
  const toolbar = sidebar.locator('[data-reader-sidebar-controls]');
  const actions = toolbar.locator('[data-reader-sidebar-actions]');
  const home = actions.getByRole('link', { name: 'Home', exact: true });
  const search = actions.getByRole('button', { name: 'Search this project' });
  const theme = actions.getByRole('button', { name: 'Toggle Theme' });
  const signOut = toolbar.getByRole('button', { name: 'Sign out' });

  await expect(home).toBeVisible();
  await expect(search).toBeVisible();
  await expect(theme).toBeVisible();
  await expect(signOut).toBeVisible();
  await Promise.all([home, search, theme, signOut].map(expectRound));

  const homeBounds = await box(home);
  const searchBounds = await box(search);
  const themeBounds = await box(theme);
  const signOutBounds = await box(signOut);
  const sidebarBounds = await box(sidebar);
  const toolbarBounds = await box(toolbar);
  expect(homeBounds.x).toBeLessThan(searchBounds.x);
  expect(searchBounds.x).toBeLessThan(themeBounds.x);
  expect(themeBounds.x + themeBounds.width).toBeLessThan(signOutBounds.x);
  expect(toolbarBounds.y).toBeGreaterThan(sidebarBounds.y + sidebarBounds.height - 100);
  expect(signOutBounds.x + signOutBounds.width).toBeLessThanOrEqual(toolbarBounds.x + toolbarBounds.width + 1);
});

test('desktop project search opens at the top across the sidebar width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto('/public-project');

  const sidebar = page.locator('#nd-sidebar');
  await sidebar.getByRole('button', { name: 'Search this project' }).click();
  const panel = page.locator('#project-search-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('searchbox', { name: 'Search this project' })).toBeFocused();

  const sidebarBounds = await box(sidebar);
  const panelBounds = await box(panel);
  expect(Math.abs(panelBounds.x - sidebarBounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(panelBounds.y - sidebarBounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(panelBounds.width - sidebarBounds.width)).toBeLessThanOrEqual(1);
});

test('mobile reader keeps Home accessible and opens Search above the bottom toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.goto('/public-project');

  await expect(page.locator('#nd-subnav').getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Sidebar' }).click();

  const drawer = page.locator('#nd-sidebar-mobile');
  const toolbar = drawer.locator('[data-reader-sidebar-controls]');
  const actions = toolbar.locator('[data-reader-sidebar-actions]');
  const home = actions.getByRole('link', { name: 'Home', exact: true });
  const search = actions.getByRole('button', { name: 'Search this project' });
  await expect(home).toBeVisible();
  await expectRound(home);

  await search.click();
  const input = drawer.getByRole('searchbox', { name: 'Search this project' });
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  const bounds = await box(input);
  const drawerBounds = await box(drawer);
  const panelBounds = await box(drawer.locator('#project-search-panel'));
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(850);
  expect(Math.abs(panelBounds.x - drawerBounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(panelBounds.width - drawerBounds.width)).toBeLessThanOrEqual(1);
  await input.fill('Setup');
  await expect(input).toHaveValue('Setup');
});
