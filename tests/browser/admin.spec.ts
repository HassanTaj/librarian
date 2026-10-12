import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('administrator can review configured repositories and save safe settings across viewports', async ({ page, browser }) => {
  await page.setExtraHTTPHeaders({ cookie: 'authjs.session-token=synthetic-browser-admin-session' });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  await page.getByRole('link', { name: 'Back to home' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Configured repositories' })).toBeVisible();

  const project = page.locator('article').filter({ hasText: 'Public Project' });
  await expect(project.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-expanded', 'false');
  await project.getByRole('button', { name: 'Edit' }).click();
  await expect(project.getByLabel('GitHub owner')).toBeEnabled();
  await expect(project.getByLabel('Portal route slug')).toBeEnabled();
  await expect(project.getByLabel('Repository type')).toHaveValue('public');
  await expect(project.getByLabel('Repository type').locator('option')).toHaveText(['Private', 'Public']);
  await expect(project.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Refresh status' })).toBeVisible();
  const primaryButton = page.getByRole('button', { name: 'Save repository' });
  const secondaryButton = page.getByRole('button', { name: 'Refresh status' });
  await expect(primaryButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(secondaryButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(primaryButton).toHaveCSS('border-top-color', 'rgb(166, 58, 169)');
  await expect(secondaryButton).toHaveCSS('border-top-color', 'rgb(101, 190, 114)');
  await expect(primaryButton).toHaveCSS('color', 'rgb(166, 58, 169)');
  await expect(secondaryButton).toHaveCSS('color', 'rgb(101, 190, 114)');
  await expect(project.getByRole('button', { name: 'Sync now' })).toHaveCSS('cursor', 'pointer');
  await expect(secondaryButton).toHaveCSS('cursor', 'pointer');

  const queued = page.waitForResponse(response => response.url().includes('/api/admin/repos/') &&
    response.url().endsWith('/sync') && response.request().method() === 'POST');
  await project.getByRole('button', { name: 'Sync now' }).click();
  const response = await queued;
  expect(response.status()).toBe(202);
  await expect(page.getByRole('status').filter({ hasText: 'Synchronization request was durably accepted.' })).toBeVisible();
  await project.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Catalog settings saved.' })).toBeVisible();

  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const desktop = await desktopContext.newPage();
    await desktop.setExtraHTTPHeaders({ cookie: 'authjs.session-token=synthetic-browser-admin-session' });
    await desktop.goto('/admin');
    await expect(desktop.getByRole('heading', { name: 'Administration' })).toBeVisible();
    await expect(desktop.getByRole('heading', { name: 'Configured repositories' })).toBeVisible();
    expect(await desktop.evaluate(() => window.innerWidth)).toBe(1280);
  } finally { await desktopContext.close(); }
});
