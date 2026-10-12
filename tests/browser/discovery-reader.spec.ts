import { expect, test } from '@playwright/test';

test('directory links to the protected administration page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Zitadel' })).toBeVisible();
  await page.getByRole('link', { name: 'Administration' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Sign in required' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Zitadel' })).toBeVisible();
});

test('sign-in appears only when signed out and starts Zitadel without an Auth.js page', async ({ page }) => {
  await page.context().addCookies([{ name: 'authjs.session-token', value: 'synthetic-browser-admin-session', url: 'http://127.0.0.1:3100' }]);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Zitadel' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Zitadel' })).toBeVisible();
  await page.route('**/api/auth/providers', route => route.fulfill({ json: { zitadel: {
    id: 'zitadel', name: 'ZITADEL', type: 'oidc', signinUrl: '/api/auth/signin/zitadel', callbackUrl: '/api/auth/callback/zitadel',
  } } }));
  await page.route('**/api/auth/csrf', route => route.fulfill({ json: { csrfToken: 'synthetic-csrf' } }));
  let providerPost = false;
  await page.route('**/api/auth/signin/zitadel**', async route => {
    providerPost = route.request().method() === 'POST';
    await route.fulfill({ json: { url: 'https://identity.synthetic.invalid/login' } });
  });
  await page.route('https://identity.synthetic.invalid/login', route => route.fulfill({ contentType: 'text/html', body: 'Synthetic Zitadel page' }));
  await page.getByRole('button', { name: 'Sign in with Zitadel' }).click();
  await expect(page).toHaveURL('https://identity.synthetic.invalid/login');
  expect(providerPost).toBe(true);
});

test('directory filtering and columns work across phone, tablet and desktop widths', async ({ page, browserName }) => {
  if (browserName === 'chromium') {
    for (const [width, columns] of [[390, '1'], [800, '2'], [1280, '3']] as const) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Project documentation' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Public Project/ })).toBeVisible();
      await expect(page.getByRole('link', { name: /Restricted One/ })).toBeVisible();
      const syncedBadge = page.getByRole('link', { name: /Public Project/ }).getByRole('status', { name: 'Sync status: succeeded' });
      await expect(syncedBadge).toBeVisible();
      await expect(syncedBadge).toHaveClass(/text-primary/);
      const columnsStyle = await page.getByRole('list', { name: 'Projects' }).evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length.toString());
      expect(columnsStyle).toBe(columns);
    }
  } else {
    await page.goto('/');
    expect(await page.getByRole('list', { name: 'Projects' }).evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBeGreaterThan(1);
  }
  const filter = page.getByRole('searchbox', { name: 'Filter projects by title' });
  await filter.fill('synthetic description');
  await expect(page.getByRole('status')).toHaveText('No projects match that title.');
  await filter.fill('pUbLiC');
  await expect(page.getByRole('link', { name: /Public Project/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Other Project/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Restricted One/ })).toHaveCount(0);
});

test('public Markdown renders with the active theme and a safe private route', async ({ page }) => {
  const response = await page.goto('/public-project');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Synthetic Portal', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Fixture');
  await expect(page.getByText('Public fixture loaded')).toBeVisible();
  await expect(page.getByRole('link', { name: 'setup guide' })).toHaveAttribute('href', /\/public-project\/guides\/setup\?g=/);
  const image = await page.getByRole('img', { name: 'Synthetic pixel' }).getAttribute('src');
  expect(image).toMatch(/^\/api\/assets\/public-project\/pixel\.png\?g=/);
  expect((await page.request.get(image!)).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Toggle Theme' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search this project' })).toBeVisible();
  const privatePage = await page.request.get('/private-one');
  expect(await privatePage.text()).not.toContain('SYNTHETIC_PRIVATE_BROWSER_SENTINEL');
  await page.getByRole('button', { name: 'Toggle Theme' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
});
