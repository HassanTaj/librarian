import { expect, test } from '@playwright/test';

test('directory links to the protected repositories page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Zitadel' })).toBeVisible();
  await page.getByRole('link', { name: 'Repositories' }).click();
  await expect(page).toHaveURL(/\/repositories$/);
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

test('reader sign-out and theme controls sit together in the neutral sidebar footer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.context().addCookies([{ name: 'authjs.session-token', value: 'synthetic-browser-admin-session', url: 'http://127.0.0.1:3100' }]);
  await page.goto('/public-project');

  const sidebar = page.locator('#nd-sidebar');
  const controls = sidebar.locator('[data-reader-sidebar-controls]');
  await expect(controls.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(controls.getByRole('button', { name: 'Toggle Theme' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Sign out' })).toHaveCount(1);
  const classes = await controls.getAttribute('class');
  expect(classes).toContain('bg-fd-card');
  expect(classes).not.toContain('bg-fd-secondary');
});

test('directory filtering and columns work across phone, tablet and desktop widths', async ({ page, browserName }) => {
  if (browserName === 'chromium') {
    for (const [width, columns] of [[390, '1'], [800, '2'], [1280, '3']] as const) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Documentation Directory' })).toBeVisible();
      const publicTitle = page.getByRole('heading', { name: 'Public Project', exact: true });
      await expect(publicTitle).toBeVisible();
      await expect(page.getByText('Private', { exact: true }).first()).toBeVisible();
      const publicCard = page.getByRole('listitem').filter({ has: publicTitle });
      const syncedBadge = publicCard.getByRole('status', { name: 'Sync status: succeeded' });
      await expect(syncedBadge).toBeVisible();
      await expect(syncedBadge).toHaveClass(/text-primary/);
      const columnsStyle = await page.getByRole('list', { name: 'Documentation sources' }).evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length.toString());
      expect(columnsStyle).toBe(columns);
    }
  } else {
    await page.goto('/');
    expect(await page.getByRole('list', { name: 'Documentation sources' }).evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBeGreaterThan(1);
  }
  await expect(page.locator('footer')).toContainText('Made with love by');
  await expect(page.locator('header img[src*="librarian-github-app-icon.png"]')).toBeVisible();
  await expect(page.locator('footer img').first()).toBeVisible();
  const filter = page.getByRole('searchbox', { name: 'Search documentation' });
  await expect(filter).toHaveAttribute('placeholder', 'Filter documentation by title');
  await expect(page.getByText('Search documentation', { exact: true })).toHaveCount(0);
  await filter.fill('synthetic description');
  await expect(page.getByText('No projects match that title.', { exact: true })).toBeVisible();
  await filter.fill('pUbLiC');
  const publicTitle = page.getByRole('heading', { name: 'Public Project', exact: true });
  await expect(publicTitle).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Other Project', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Restricted One', exact: true })).toHaveCount(0);
  await publicTitle.locator('xpath=..').click();
  await expect(page).toHaveURL(/\/public-project$/);
  await expect(page.getByRole('heading', { name: 'Synthetic Portal', exact: true })).toBeVisible();
});

test('directory selection is circular, sync controls are buttons, and statuses sit at card bottoms', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.setExtraHTTPHeaders({ cookie: 'authjs.session-token=synthetic-browser-admin-session' });
  await page.goto('/');

  const toolbar = page.getByRole('toolbar', { name: 'Documentation directory tools' });
  const filter = toolbar.getByRole('searchbox');
  const sync = toolbar.getByRole('button', { name: 'Sync 0 selected documents' });
  await expect(filter).toHaveAttribute('placeholder', 'Filter documentation by title');
  await expect(sync).toBeDisabled();
  await expect(sync).toContainText('Sync');
  await expect(sync).toContainText('0');
  const filterBounds = await filter.boundingBox();
  const syncBounds = await sync.boundingBox();
  expect(filterBounds).not.toBeNull();
  expect(syncBounds).not.toBeNull();
  expect(Math.abs((filterBounds!.y + filterBounds!.height / 2) - (syncBounds!.y + syncBounds!.height / 2))).toBeLessThanOrEqual(1);

  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Public Project', exact: true }) });
  const article = card.locator('article');
  const title = card.getByRole('heading', { name: 'Public Project', exact: true });
  const link = card.locator('a').nth(1);
  const checkbox = card.getByRole('checkbox', { name: 'Select Public Project' });
  const syncCard = card.getByRole('button', { name: 'Sync Public Project' });
  const status = card.getByRole('status', { name: 'Sync status: succeeded' });
  const cardBounds = await article.boundingBox();
  const checkboxBounds = await checkbox.evaluate(element => {
    const { x, y, width, height } = element.parentElement!.getBoundingClientRect();
    return { x, y, width, height };
  });
  const titleBounds = await title.boundingBox();
  const cardSyncBounds = await syncCard.boundingBox();
  const statusBounds = await status.boundingBox();
  const checkboxSurface = await checkbox.evaluate(element => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, radius: Number.parseFloat(style.borderTopLeftRadius), appearance: style.appearance };
  });
  expect(cardBounds).not.toBeNull();
  expect(checkboxBounds).not.toBeNull();
  expect(titleBounds).not.toBeNull();
  expect(cardSyncBounds).not.toBeNull();
  expect(statusBounds).not.toBeNull();
  expect(checkboxSurface).toMatchObject({ width: 20, height: 20, appearance: 'none' });
  expect(checkboxSurface.radius).toBeGreaterThanOrEqual(checkboxSurface.width / 2);
  await expect(title).toHaveCSS('text-overflow', 'ellipsis');
  await expect(link.locator('p')).toHaveCSS('-webkit-line-clamp', '3');
  expect(Math.abs(checkboxBounds!.x - cardBounds!.x - 20)).toBeLessThanOrEqual(1);
  expect(Math.abs(checkboxBounds!.y - cardBounds!.y - 20)).toBeLessThanOrEqual(1);
  expect(Math.abs(cardSyncBounds!.x + cardSyncBounds!.width - cardBounds!.x - cardBounds!.width + 20)).toBeLessThanOrEqual(1);
  expect(Math.abs((titleBounds!.y + titleBounds!.height / 2) - (cardSyncBounds!.y + cardSyncBounds!.height / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(statusBounds!.x + statusBounds!.width - cardBounds!.x - cardBounds!.width + 20)).toBeLessThanOrEqual(1);
  expect(Math.abs(statusBounds!.y + statusBounds!.height - cardBounds!.y - cardBounds!.height + 20)).toBeLessThanOrEqual(1);

  await checkbox.locator('xpath=..').click();
  await expect(checkbox).toBeChecked();
  await expect(checkbox.locator('xpath=..').locator('svg')).toHaveClass(/opacity-100/);
  const oneSelected = toolbar.getByRole('button', { name: 'Sync 1 selected document' });
  const oneCount = oneSelected.locator('span[aria-hidden="true"]');
  await expect(oneCount).toBeVisible();
  await expect(oneCount).toHaveText('1');
  await expect(oneCount).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(oneCount).toHaveCSS('color', 'rgb(166, 58, 169)');
  await page.getByRole('checkbox', { name: 'Select Other Project' }).locator('xpath=..').click();
  await expect(page.getByRole('checkbox', { name: 'Select Other Project' })).toBeChecked();
  await expect(toolbar.getByRole('button', { name: 'Sync 2 selected documents' }).locator('span[aria-hidden="true"]')).toHaveText('2');
});

test('public Markdown renders with the active theme and a safe private route', async ({ page }) => {
  const response = await page.goto('/public-project');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Synthetic Portal', exact: true })).toBeVisible();
  await expect(page.locator('a a')).toHaveCount(0);
  await expect(page.getByRole('table')).toContainText('Fixture');
  await expect(page.getByText('Public fixture loaded')).toBeVisible();
  await expect(page.getByRole('link', { name: 'setup guide' })).toHaveAttribute('href', /\/public-project\/guides\/setup\?g=/);
  const image = await page.getByRole('img', { name: 'Synthetic pixel' }).getAttribute('src');
  expect(image).toMatch(/^\/api\/assets\/public-project\/pixel\.png\?g=/);
  expect((await page.request.get(image!)).status()).toBe(200);
  const themeToggle = page.getByRole('button', { name: 'Toggle Theme' });
  await expect(themeToggle).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search this project' })).toBeVisible();
  const privatePage = await page.request.get('/private-one');
  expect(await privatePage.text()).not.toContain('SYNTHETIC_PRIVATE_BROWSER_SENTINEL');
  await expect(themeToggle.locator('svg').first()).toHaveClass(/bg-fd-accent/);
  await themeToggle.click();
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('reader navigation fits a phone viewport and keeps Home and search accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.goto('/public-project');

  await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  const header = page.locator('#nd-subnav');
  const dimensions = await header.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);

  await page.getByRole('button', { name: 'Open Sidebar' }).click();
  const drawer = page.locator('#nd-sidebar-mobile');
  await expect(drawer.getByRole('button', { name: 'Search this project' })).toBeVisible();
  await expect(drawer.locator('summary[aria-label^="Select project"]')).toHaveCount(0);
  await expect(drawer.getByRole('link', { name: 'Home', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto('/public-project');
  const sidebar = page.locator('#nd-sidebar');
  await expect(sidebar.locator('summary[aria-label^="Select project"]')).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
});
