import { expect, test, type BrowserContext, type Page } from '@playwright/test';

test.use({ ignoreHTTPSErrors: true, colorScheme: 'dark' });

const setupOrigin = 'https://localhost:3200';
const fixtureOrigin = 'http://127.0.0.1:3101';
const replacementSecret = 'SYNTHETIC_BROWSER_REPLACEMENT_SENTINEL'.repeat(2);
let sessionToken = '';

async function fixture(path: string, method: 'GET' | 'POST' = 'POST') {
  const response = await fetch(`${fixtureOrigin}${path}`, { method });
  expect(response.ok, `browser fixture ${path} should succeed`).toBeTruthy();
  return response;
}

async function authenticate(context: BrowserContext) {
  await context.addCookies([{ name: '__Secure-authjs.session-token', value: sessionToken, url: setupOrigin, secure: true, httpOnly: true, sameSite: 'Lax' }]);
}

async function openSettings(page: Page) {
  const settingsResponse = page.waitForResponse(response => response.url().endsWith('/api/instance/settings') && response.request().method() === 'GET', { timeout: 30_000 });
  await page.goto(`${setupOrigin}/instance/settings`);
  await expect(page.getByRole('heading', { name: 'Instance Settings' })).toBeVisible();
  const response = await settingsResponse;
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  await expect(page.getByLabel('Display name')).toBeVisible();
}

test.beforeEach(async () => {
  await fixture('/setup/reset');
  const response = await fixture('/settings/ready');
  sessionToken = (await response.json() as { sessionToken: string }).sessionToken;
});

test('protects grouped Settings, saves a private draft, pages audit and preserves it across restart and viewports', async ({ page, browser }) => {
  test.setTimeout(120_000);

  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const guest = await anonymous.newPage();
    await guest.goto(`${setupOrigin}/instance/settings`);
    await expect(guest.locator('main').getByRole('alert')).toContainText('Sign in to continue.');
    await expect(guest.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
    for (const path of ['/api/instance/settings', '/api/instance/audit']) {
      const response = await guest.request.get(`${setupOrigin}${path}`);
      expect(response.status()).toBe(401);
      expect(await response.text()).not.toContain('SYNTHETIC_BROWSER_REPLACEMENT_SENTINEL');
    }
    for (const path of ['/api/instance/settings/check', '/api/instance/settings/activate', '/api/instance/settings/rollback']) {
      const response = await guest.request.post(`${setupOrigin}${path}`, { data: {} });
      expect(response.status()).toBe(401);
    }
  } finally { await anonymous.close(); }

  await authenticate(page.context());
  await openSettings(page);
  await expect(page.locator('html')).toHaveClass(/dark/);
  for (const [tab, group] of [['Auth', 'Auth'], ['Zitadel', 'Zitadel'], ['MongoDB', 'MongoDB connection'], ['GitHub App', 'GitHub App'],
    ['GitHub webhook', 'GitHub webhook'], ['Runtime and documentation', 'Runtime and documentation'], ['Host prerequisites', 'Host prerequisites']]) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('group', { name: group })).toBeVisible();
  }
  await page.getByRole('tab', { name: 'Validation' }).click();
  await expect(page.getByRole('heading', { name: 'Validation and activation' })).toBeVisible();
  await page.getByRole('tab', { name: 'Audit' }).click();
  await expect(page.getByRole('heading', { name: 'System and audit' })).toBeVisible();
  await page.getByRole('tab', { name: 'Runtime and documentation' }).click();
  await expect(page.getByRole('link', { name: 'Synthetic Settings Portal' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'Instance Settings' })).toHaveAttribute('href', '/instance/settings');
  await page.getByLabel('Display name').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Description')).toBeFocused();

  const baseline = await page.evaluate(async () => (await (await fetch('/api/instance/settings', { cache: 'no-store' })).json()));
  await page.getByLabel('Display name').fill('Unsaved browser edit');
  await page.getByRole('button', { name: 'Cancel' }).click();
  const afterCancel = await page.evaluate(async () => (await (await fetch('/api/instance/settings', { cache: 'no-store' })).json()));
  expect(afterCancel.candidateVersion).toBe(baseline.candidateVersion);
  expect(afterCancel.active.preferences.displayName).toBe('Synthetic Settings Portal');

  await page.getByLabel('Default documentation folder').fill('../escape');
  await page.getByRole('button', { name: 'Save draft' }).click();
  const invalid = page.locator('main').getByRole('alert');
  await expect(invalid).toBeFocused();
  await expect(invalid).toContainText(/invalid|settings|request/i);
  await page.getByLabel('Default documentation folder').fill('docs');
  await page.getByLabel('Display name').fill('Saved browser draft');
  await page.getByLabel('Description').fill('Saved only as a candidate.');
  await page.getByRole('tab', { name: 'GitHub webhook' }).click();
  await page.getByLabel(/Replace GitHub webhook signing secret/).check();
  await page.getByLabel('New GitHub webhook signing secret').fill(replacementSecret);
  await page.getByRole('tab', { name: 'Runtime and documentation' }).click();
  const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/instance/settings') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save draft' }).click();
  const saved = await savedResponse;
  expect(saved.status()).toBe(200);
  const savedBody = await saved.text();
  expect(savedBody).not.toContain(replacementSecret);
  await expect(page.getByRole('status')).toContainText('Draft saved. Active settings have not changed.');
  await page.getByRole('tab', { name: 'GitHub webhook' }).click();
  await expect(page.getByLabel('New GitHub webhook signing secret')).toHaveValue('');
  const snapshot = await page.evaluate(async () => (await (await fetch('/api/instance/settings', { cache: 'no-store' })).json()));
  expect(snapshot.active.preferences.displayName).toBe('Synthetic Settings Portal');
  expect(snapshot.candidate.preferences.displayName).toBe('Saved browser draft');
  expect(JSON.stringify(snapshot)).not.toMatch(/ciphertext|SYNTHETIC_BROWSER_REPLACEMENT_SENTINEL/);
  expect(await page.content()).not.toContain(replacementSecret);
  await expect(page.getByRole('link', { name: 'Synthetic Settings Portal' })).toBeVisible();

  await page.getByRole('tab', { name: 'Validation' }).click();
  await page.getByRole('button', { name: 'Run database connection check' }).click();
  await expect(page.getByRole('status')).toContainText('Database connection: passed (database_ok)');
  const writes = await page.evaluate(async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 20; index++) {
      const currentResponse = await fetch('/api/instance/settings', { cache: 'no-store' });
      const current = await currentResponse.json();
      const response = await fetch('/api/instance/settings', { method: 'PATCH', cache: 'no-store', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': current.csrfToken, 'If-Match': `"${current.editRevision}"`,
      }, body: JSON.stringify({ candidateVersion: current.candidateVersion, changes: { description: `Audit entry ${index}` } }) });
      statuses.push(response.status);
      if (!response.ok) break;
    }
    return statuses;
  });
  expect(writes).toEqual(Array(20).fill(200));

  await page.getByRole('tab', { name: 'Audit' }).click();
  const audit = page.getByRole('heading', { name: 'System and audit' }).locator('..');
  await audit.getByRole('button', { name: 'Load audit' }).click();
  await expect(audit.locator('ul li')).toHaveCount(20);
  await expect(audit.getByRole('button', { name: 'Next audit page' })).toBeVisible();
  await audit.getByRole('button', { name: 'Next audit page' }).click();
  await expect(audit.locator('ul li')).toHaveCount(1);
  await expect(audit).not.toContainText(replacementSecret);

  await page.context().close();
  await fixture('/setup/restart');
  const reopened = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: 'dark' });
  try {
    await authenticate(reopened);
    const persisted = await reopened.newPage();
    await openSettings(persisted);
    await expect(persisted.getByLabel('Display name')).toHaveValue('Saved browser draft');
    await expect(persisted.getByLabel('Description')).toHaveValue('Audit entry 19');
    const snapshot = await persisted.evaluate(async () => (await (await fetch('/api/instance/settings', { cache: 'no-store' })).json()));
    expect(snapshot.active.preferences.displayName).toBe('Synthetic Settings Portal');
    expect(snapshot.candidate.preferences.displayName).toBe('Saved browser draft');
  } finally { await reopened.close(); }

  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, colorScheme: 'dark' });
    try {
      await authenticate(context);
      const responsive = await context.newPage();
      await openSettings(responsive);
      expect(await responsive.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(responsive.locator('html')).toHaveClass(/dark/);
    } finally { await context.close(); }
  }
});
