import { expect, test, type BrowserContext, type Page } from '@playwright/test';

test.use({ ignoreHTTPSErrors: true });

const setupOrigin = 'https://localhost:3200';
const fixtureOrigin = 'http://127.0.0.1:3101';
let ownerSessionToken = '';
let administratorSessionToken = '';

async function fixture(path: string, method: 'GET' | 'POST' = 'POST') {
  const response = await fetch(`${fixtureOrigin}${path}`, { method });
  expect(response.ok, `browser fixture ${path} should succeed`).toBeTruthy();
  return response;
}

async function authenticate(context: BrowserContext, token = ownerSessionToken) {
  await context.addCookies([{ name: '__Secure-authjs.session-token', value: token, url: setupOrigin, secure: true, httpOnly: true, sameSite: 'Lax' }]);
}

async function openSettings(page: Page) {
  const settingsResponse = page.waitForResponse(response => response.url().endsWith('/api/instance/settings') && response.request().method() === 'GET');
  await page.goto(`${setupOrigin}/instance/settings`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Instance Settings' })).toBeVisible();
  expect((await settingsResponse).status()).toBe(200);
  await expect(page.getByLabel('Display name')).toBeVisible();
}

async function saveDraftAndVerifyOwner(page: Page, label: string, clientId?: string) {
  await page.getByLabel('Display name').fill(label);
  if (clientId) await page.getByLabel('Client ID').fill(clientId);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/instance/settings') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save draft' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole('status')).toContainText('Draft saved. Active settings have not changed.');

  const issuerResponse = await fixture('/setup/provider', 'GET');
  const issuer = (await issuerResponse.json() as { origin: string }).origin;
  await page.route(`${issuer}/authorize**`, route => route.continue());
  const callback = page.waitForRequest(request => request.url().startsWith(`${setupOrigin}/api/instance/auth/callback/zitadel?`));
  await page.getByRole('button', { name: 'Verify candidate owner' }).click();
  await callback;
  await expect(page.getByText(/Verified target proof ID for a protected ownership transfer/)).toBeVisible({ timeout: 30_000 });

  await fixture('/settings/reset-check-limits');
  for (const [index, type] of ['database', 'zitadel_discovery', 'zitadel_owner_login', 'github_structure', 'github_authentication',
    'github_permissions', 'github_installation', 'github_webhook'].entries()) {
    if (index === 6) await fixture('/settings/reset-check-limits');
    await page.getByRole('button', { name: type.replaceAll('_', ' '), exact: true }).click();
    await expect(page.getByRole('status')).toContainText(`${type}:`, { timeout: 30_000 });
  }
}

test.beforeEach(async () => {
  await fixture('/setup/reset');
  const response = await fixture('/settings/ready');
  const tokens = await response.json() as { sessionToken: string; administratorSessionToken: string };
  ownerSessionToken = tokens.sessionToken;
  administratorSessionToken = tokens.administratorSessionToken;
});

test('owner applies reviewed settings, reports pending truthfully, and prepares a monotonic rollback candidate', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await authenticate(page.context());
  await openSettings(page);
  await expect(page.getByText(/Root keys, database, storage, proxy and outbound policy require a protected host operator and restart/)).toBeVisible();
  await saveDraftAndVerifyOwner(page, 'Activated synthetic portal');

  const administratorContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await authenticate(administratorContext, administratorSessionToken);
    const administratorPage = await administratorContext.newPage();
    await openSettings(administratorPage);
    const activate = administratorPage.getByRole('button', { name: 'Activate saved draft' });
    await expect(activate).toBeEnabled();
    const settingsResponse = await administratorPage.request.get(`${setupOrigin}/api/instance/settings`);
    expect(settingsResponse.status()).toBe(200);
    const current = await settingsResponse.json();
    const denied = await administratorPage.request.post(`${setupOrigin}/api/instance/settings/activate`, { headers: {
      origin: setupOrigin, 'X-CSRF-Token': current.csrfToken, 'If-Match': `"${current.editRevision}"`,
    }, data: { candidateVersion: current.candidateVersion, confirmationNonce: current.impact.confirmationNonce, confirm: true } });
    expect(denied.status()).toBe(409);
    const unchanged = await (await administratorPage.request.get(`${setupOrigin}/api/instance/settings`)).json();
    expect(unchanged.activeVersion).toBe(1);
    expect(unchanged.candidateVersion).toBe(2);
  } finally { await administratorContext.close().catch(() => undefined); }

  page.once('dialog', dialog => dialog.accept());
  const firstApply = page.waitForResponse(response => response.url().endsWith('/api/instance/settings/activate') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Activate saved draft' }).click();
  const first = await firstApply;
  expect(first.status()).toBe(202);
  expect(await first.json()).toMatchObject({ status: 'pending', activeVersion: 2, candidateVersion: null });
  await expect(page.getByRole('status')).toContainText('Activation is pending. Check instance health, then refresh.');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Active revision 2. No saved draft.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare rollback' })).toBeEnabled();

  page.once('dialog', dialog => dialog.accept());
  const rollback = page.waitForResponse(response => response.url().endsWith('/api/instance/settings/rollback') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Prepare rollback' }).click();
  expect((await rollback).status()).toBe(200);
  await expect(page.getByRole('status')).toContainText('Rollback draft saved. Verify the owner and providers before activation.');
  const prepared = await page.evaluate(async () => (await (await fetch('/api/instance/settings', { cache: 'no-store' })).json()));
  expect(prepared).toMatchObject({ activeVersion: 2, candidateVersion: 3,
    impact: { securityEpochIncrement: true, categories: ['preferences', 'origin', 'identity', 'github'] } });

  await saveDraftAndVerifyOwner(page, 'Synthetic rollback candidate', 'synthetic-instance-client-replacement');
  const identityCandidate = await page.evaluate(async () => (await (await fetch('/api/instance/settings', { cache: 'no-store' })).json()));
  expect(identityCandidate).toMatchObject({ candidateVersion: 4, impact: { securityEpochIncrement: true } });
  page.once('dialog', dialog => dialog.accept());
  const secondApply = page.waitForResponse(response => response.url().endsWith('/api/instance/settings/activate') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Activate saved draft' }).click();
  expect((await secondApply).status()).toBe(202);
  await expect(page.getByRole('status')).toContainText('Activation is pending. Check instance health, then refresh.');
  const state = await (await fixture('/settings/state', 'GET')).json();
  expect(state).toMatchObject({ state: 'ready', activeVersion: 4, candidateVersion: null, securityEpoch: 2, gate: 'open' });
  const expiredSession = await page.request.get(`${setupOrigin}/api/auth/session`);
  expect(expiredSession.status()).toBe(200);
  const session = await expiredSession.json();
  expect(session === null, `session endpoint exposed keys: ${Object.keys(session ?? {}).join(', ')}`).toBe(true);
});

test('a draining request keeps Apply pending without reporting the draft active', async ({ page }) => {
  test.setTimeout(180_000);
  await authenticate(page.context());
  await openSettings(page);
  await saveDraftAndVerifyOwner(page, 'Pending adoption portal');
  await fixture('/settings/add-request-pin');

  page.once('dialog', dialog => dialog.accept());
  const apply = page.waitForResponse(response => response.url().endsWith('/api/instance/settings/activate') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Activate saved draft' }).click();
  const response = await apply;
  const body = await response.text();
  expect(response.status(), body).toBe(202);
  expect(JSON.parse(body)).toMatchObject({ status: 'pending', state: 'ready', activeVersion: 1, candidateVersion: 2 });
  await expect(page.getByRole('status')).toContainText('Activation is pending. Check instance health, then refresh.');
  const state = await (await fixture('/settings/state', 'GET')).json();
  expect(state).toMatchObject({ state: 'ready', activeVersion: 1, candidateVersion: 2, activationPhase: 'draining', gate: 'closing' });
  const health = await page.request.get(`${setupOrigin}/api/health`);
  expect(health.status()).toBe(503);
  expect(await health.json()).toMatchObject({ status: 'not_ready' });
});
