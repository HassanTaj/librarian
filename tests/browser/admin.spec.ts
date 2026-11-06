import { expect, test, type Locator } from '@playwright/test';
import { refreshAdminAuthorization } from './admin-fixture';

test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(refreshAdminAuthorization);

test('the former /admin UI route is not registered', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Configured Repositories' })).toHaveCount(0);
});

async function expectCircularButton(button: Locator, size: number) {
  const box = await button.boundingBox();
  expect(box?.width).toBeCloseTo(size, 2);
  expect(box?.height).toBeCloseTo(size, 2);
  const radius = Number.parseFloat(await button.evaluate(element => getComputedStyle(element).borderTopLeftRadius));
  expect(radius).toBeGreaterThanOrEqual(size / 2);
}

test('administrator can review configured repositories and save safe settings across viewports', async ({ page, browser }) => {
  await page.context().addCookies([{ name: 'authjs.session-token', value: 'synthetic-browser-admin-session', url: 'http://127.0.0.1:3100' }]);
  await page.goto('/repositories');
  await expect(page.getByRole('heading', { name: 'Configured Repositories' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Toggle Theme' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Perspective V / Docs' })).toHaveAttribute('href', '/');
  await page.getByRole('link', { name: 'Perspective V / Docs' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.goto('/repositories');
  await expect(page.getByRole('heading', { name: 'Configured Repositories' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Repositories' })).toHaveAttribute('href', '/repositories');
  await expect(page.getByRole('heading', { name: 'Configured repositories', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeHidden();
  const refreshButton = page.getByRole('button', { name: 'Refresh status' });
  await expectCircularButton(refreshButton, 36);
  await page.getByRole('button', { name: 'Configure' }).click();
  await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();
  const configureButton = page.getByRole('button', { name: 'Configure' });
  await expect(configureButton).toBeDisabled();
  await expect(configureButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  const primaryButton = page.getByRole('button', { name: 'Save', exact: true });
  const cancelConfigureButton = page.locator('#new-catalog-form').getByRole('button', { name: 'Cancel' });
  await expect(cancelConfigureButton).toBeVisible();
  const secondaryButton = refreshButton;
  await expect(primaryButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(secondaryButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(primaryButton).toHaveCSS('border-top-color', 'rgb(166, 58, 169)');
  await expect(secondaryButton).toHaveCSS('border-top-color', 'rgb(101, 190, 114)');
  await expect(primaryButton).toHaveCSS('color', 'rgb(166, 58, 169)');
  await expect(secondaryButton).toHaveCSS('color', 'rgb(101, 190, 114)');
  await cancelConfigureButton.click();
  await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeHidden();
  await expect(configureButton).toBeEnabled();

  const project = page.locator('article').filter({ hasText: 'Public Project' });
  const summary = project.locator('dl').first();
  await expect(summary.getByText('Repository type', { exact: true })).toBeVisible();
  await expect(summary.getByText('Public', { exact: true })).toBeVisible();
  await expect(summary.getByText('Enabled', { exact: true })).toBeVisible();
  await expect(summary.getByText('Yes', { exact: true })).toBeVisible();
  const fullCommit = 'a'.repeat(40);
  const shortCommit = project.getByLabel(`Published commit ${fullCommit}`);
  await expect(shortCommit).toHaveText('aaaaaaa…');
  await expect(shortCommit).toHaveAttribute('title', fullCommit);
  await expect(summary.getByText('Last successful sync', { exact: true })).toBeVisible();
  const lastSync = summary.locator('div').filter({ hasText: 'Last successful sync' }).locator('dd');
  await expect(lastSync).not.toHaveText('Never');
  await expect(lastSync).not.toBeEmpty();
  const collapsedStatus = project.getByRole('status').filter({ hasText: 'succeeded' });
  const cardBox = (await project.boundingBox())!;
  const statusBox = (await collapsedStatus.boundingBox())!;
  expect(Math.abs(statusBox.x - cardBox.x - 20)).toBeLessThanOrEqual(1);
  expect(statusBox.y + statusBox.height).toBeGreaterThanOrEqual(cardBox.y + cardBox.height - 30);
  const viewButton = project.getByRole('button', { name: 'View Public Project details' });
  await expectCircularButton(viewButton, 32);
  const syncButton = project.getByRole('button', { name: 'Sync Public Project' });
  const syncBox = (await syncButton.boundingBox())!;
  await expectCircularButton(syncButton, 32);
  expect(syncBox.x + syncBox.width).toBeGreaterThanOrEqual(cardBox.x + cardBox.width - 24);
  await expect(viewButton).toHaveAttribute('aria-expanded', 'false');
  await viewButton.click();
  await expect(project.getByText('GitHub installation ID', { exact: true })).toBeVisible();
  const hideButton = project.getByRole('button', { name: 'Hide Public Project details' });
  await expect(hideButton).toHaveAttribute('aria-expanded', 'true');
  await expect(project.getByRole('status').filter({ hasText: 'succeeded' })).toBeVisible();
  const editButton = project.getByRole('button', { name: 'Edit Public Project' });
  const deleteButton = project.getByRole('button', { name: 'Delete Public Project' });
  await expect(editButton).toBeVisible();
  await expectCircularButton(editButton, 32);
  await expect(deleteButton).toBeVisible();
  await expectCircularButton(deleteButton, 32);
  await editButton.click();
  await expect(project.getByRole('button', { name: 'Edit Public Project' })).toHaveCount(0);
  await expect(project.getByRole('button', { name: 'Delete Public Project' })).toBeDisabled();
  await expect(project.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(project.getByLabel('GitHub owner')).toBeEnabled();
  await expect(project.getByLabel('Portal route slug')).toBeEnabled();
  await expect(project.getByLabel('Repository type')).toHaveValue('public');
  await expect(project.getByLabel('Repository type').locator('option')).toHaveText(['Private', 'Public']);
  for (const label of ['Repository name', 'GitHub installation ID', 'Branch', 'Documentation folder', 'Display title',
    'Required reader role', 'Owner approval reference', 'Enabled']) {
    await expect(project.getByLabel(label)).toBeVisible();
  }
  await expect(project.getByRole('button', { name: 'Sync Public Project' })).toBeEnabled();
  await expect(project.getByLabel('Directory description')).toBeVisible();
  await expect(project.getByLabel('Directory description')).toHaveJSProperty('tagName', 'TEXTAREA');
  const descriptionLabel = project.getByLabel('Directory description').locator('xpath=..');
  expect(await descriptionLabel.evaluate(label => [...label.parentElement!.querySelectorAll(':scope > label')].at(-1) === label)).toBe(true);
  await expect(page.getByRole('button', { name: 'Refresh status' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Configure' })).toBeVisible();
  await expect(project.getByRole('button', { name: 'Sync Public Project' })).toHaveCSS('cursor', 'pointer');
  await expect(secondaryButton).toHaveCSS('cursor', 'pointer');

  await page.route('**/api/admin/repos/*', async route => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic save rejected.' } }) });
      return;
    }
    await route.continue();
  });
  await project.getByRole('button', { name: 'Save' }).click();
  await expect(project.getByLabel('GitHub owner')).toBeVisible();
  const saveError = project.locator('details').filter({ hasText: 'Settings could not be saved' });
  await expect(saveError.locator('summary')).toBeVisible();
  await saveError.locator('summary').click();
  await expect(saveError.getByRole('alert')).toHaveText('Synthetic save rejected.');
  await page.unroute('**/api/admin/repos/*');
  await project.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Catalog settings saved.' })).toBeVisible();
  await expect(project.getByLabel('GitHub owner')).toBeHidden();

  await page.route('**/api/admin/repos/*/sync', route => route.fulfill({ status: 202, contentType: 'application/json',
    body: JSON.stringify({ status: 'pending' }) }));
  const queued = page.waitForResponse(response => response.url().includes('/api/admin/repos/') &&
    response.url().endsWith('/sync') && response.request().method() === 'POST');
  await project.getByRole('button', { name: 'Sync Public Project' }).click();
  const response = await queued;
  expect(response.status()).toBe(202);
  await expect(page.getByRole('status').filter({ hasText: 'Synchronization request was durably accepted.' })).toBeVisible();

  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const desktop = await desktopContext.newPage();
    await desktopContext.addCookies([{ name: 'authjs.session-token', value: 'synthetic-browser-admin-session', url: 'http://127.0.0.1:3100' }]);
    await desktop.goto('/repositories');
    await expect(desktop.getByRole('heading', { name: 'Configured Repositories' })).toBeVisible();
    await expect(desktop.getByRole('link', { name: 'Repositories' })).toHaveAttribute('href', '/repositories');
    expect(await desktop.evaluate(() => window.innerWidth)).toBe(1280);
  } finally { await desktopContext.close(); }
});
