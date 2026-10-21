import { expect, test, type Page } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';

test.use({ ignoreHTTPSErrors: true });

const setupOrigin = 'https://localhost:3200';
const fixtureOrigin = 'http://127.0.0.1:3101';
const sentinelClientSecret = 'SYNTHETIC_ZITADEL_SECRET_SENTINEL';
const sentinelWebhookSecret = 'SYNTHETIC_WEBHOOK_SECRET_SENTINEL';
const candidateClientId = 'synthetic-instance-client';
const candidateProjectId = 'synthetic-instance-project';
const setupUrl = `${setupOrigin}/instance/setup`;
const steps = ['Welcome', 'Database', 'Zitadel', 'GitHub App', 'Preferences', 'Owner verification', 'Review'];

async function fixture(path: string, method: 'GET' | 'POST' = 'POST') {
  const response = await fetch(`${fixtureOrigin}${path}`, { method });
  expect(response.ok, `browser fixture ${path} should succeed`).toBeTruthy();
  return response;
}

async function bootstrapCredential() {
  const response = await fixture('/setup/bootstrap', 'GET');
  return (await response.json() as { credential: string }).credential;
}

async function syntheticProviderOrigin() {
  const response = await fixture('/setup/provider', 'GET');
  return (await response.json() as { origin: string }).origin;
}

async function authorize(page: Page, credential = '') {
  const initialSetup = page.waitForResponse(response => response.url().endsWith('/api/instance/setup'));
  await page.goto(setupUrl);
  expect((await initialSetup).status()).toBe(401);
  const input = page.getByLabel(/bootstrap credential/i);
  await expect(input).toBeVisible();
  await input.fill(credential || await bootstrapCredential());
  await expect(page.getByRole('button', { name: /authorize setup/i })).toBeEnabled();
  const authorization = page.waitForResponse(response => response.url().endsWith('/api/instance/setup/authorize') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /authorize setup/i }).click();
  const result = await authorization;
  if (!result.ok()) {
    const body = await result.json().catch(() => null) as { error?: { code?: string } } | null;
    throw new Error(`setup_authorization_failed:${body?.error?.code ?? result.status()}`);
  }
  await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
  await expect(page.getByLabel(/bootstrap credential/i)).toHaveCount(0);
}

async function nextStep(page: Page, current: string, next: string, action = 'Continue') {
  const wizard = page.getByRole('region', { name: 'Instance setup wizard' });
  const navigation = wizard.getByRole('navigation', { name: 'Setup steps' });
  await expect(navigation.getByRole('button', { name: current, exact: true })).toHaveAttribute('aria-current', 'step');
  await wizard.getByRole('button', { name: action, exact: true }).last().click();
  await expect(navigation.getByRole('button', { name: next, exact: true })).toHaveAttribute('aria-current', 'step');
}

async function fillDraft(page: Page, includeSecrets: boolean) {
  const issuer = await syntheticProviderOrigin();
  await nextStep(page, 'Welcome', 'Database');
  await page.getByRole('button', { name: /retry connection/i }).click();
  await expect(page.getByRole('status')).toContainText('Database connection passed.', { timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Instance setup wizard' }).getByRole('alert')).toHaveCount(0);
  await nextStep(page, 'Database', 'Zitadel');
  await page.getByLabel(/zitadel issuer/i).fill(issuer);
  await page.getByLabel(/client id/i).fill(candidateClientId);
  await page.getByLabel(/project id/i).fill(candidateProjectId);
  await page.getByLabel(/api audience/i).fill('synthetic-instance-api');
  if (includeSecrets) await page.getByLabel(/client secret/i).fill(sentinelClientSecret);
  await nextStep(page, 'Zitadel', 'GitHub App');
  await page.getByLabel(/github app id/i).fill('12345');
  if (includeSecrets) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await page.getByLabel(/github private key/i).fill(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    await page.getByLabel(/webhook secret/i).fill(sentinelWebhookSecret);
  }
  await nextStep(page, 'GitHub App', 'Preferences');
  await page.getByLabel(/display name/i).fill('Synthetic Setup Portal');
  await page.getByLabel(/description/i).fill('Browser fixture for a fresh installation.');
  await page.getByLabel(/default docs folder/i).fill('docs');
  await nextStep(page, 'Preferences', 'Owner verification');
}

async function verifiedSyntheticOwner(page: Page) {
  const issuer = await syntheticProviderOrigin();
  let authorizationUrl: URL | undefined;
  const authResponses: string[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === setupOrigin && url.pathname.startsWith('/api/instance/auth/')) authResponses.push(`${response.request().method()} ${url.pathname}:${response.status()}`);
  });
  await page.route(`${issuer}/authorize**`, async route => {
    authorizationUrl = new URL(route.request().url());
    await route.continue();
  });
  const login = page.getByRole('button', { name: /sign in.*owner|verify owner|candidate.*sign in/i });
  await expect(login).toBeEnabled();
  const endpointShapes = await page.evaluate(async () => {
    const providersResponse = await fetch('/api/instance/auth/providers');
    const providers = await providersResponse.json().catch(() => null) as Record<string, unknown> | null;
    const csrfResponse = await fetch('/api/instance/auth/csrf');
    const csrf = await csrfResponse.json().catch(() => null) as { csrfToken?: unknown } | null;
    return { providersStatus: providersResponse.status, providerIds: Object.keys(providers ?? {}), csrfStatus: csrfResponse.status,
      hasCsrfToken: typeof csrf?.csrfToken === 'string' };
  });
  expect(endpointShapes).toMatchObject({ providersStatus: 200, providerIds: ['zitadel'], csrfStatus: 200, hasCsrfToken: true });
  const signInResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === setupOrigin && url.pathname === '/api/instance/auth/signin/zitadel' && response.request().method() === 'POST';
  });
  const providerRedirect = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === issuer && url.pathname === '/authorize';
  });
  const callback = page.waitForRequest(request => request.url().startsWith(`${setupOrigin}/api/instance/auth/callback/zitadel?`));
  await login.click();
  const signIn = await signInResponse;
  expect(signIn.status()).toBe(200);
  const redirect = await signIn.json() as { url: string };
  const authorizationLocation = new URL(redirect.url);
  if (authorizationLocation.origin !== issuer || authorizationLocation.pathname !== '/authorize') {
    throw new Error(`candidate_signin_redirect_invalid:${signIn.status()}:${authorizationLocation.pathname}:${authResponses.join('|')}`);
  }
  expect((await providerRedirect).status()).toBe(302);
  const callbackRequest = await callback;
  expect(authorizationUrl).toBeDefined();
  expect(authorizationUrl!.searchParams.get('client_id')).toBe(candidateClientId);
  expect(authorizationUrl!.searchParams.get('response_type')).toBe('code');
  expect(authorizationUrl!.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorizationUrl!.searchParams.get('code_challenge')).toBeTruthy();
  expect(authorizationUrl!.searchParams.get('state')).toBeTruthy();
  expect(authorizationUrl!.searchParams.get('nonce')).toBeTruthy();
  expect(authorizationUrl!.searchParams.get('redirect_uri')).toBe(`${setupOrigin}/api/instance/auth/callback/zitadel`);
  expect(new URL(callbackRequest.url()).searchParams.get('code')).toBeTruthy();
  expect(new URL(callbackRequest.url()).searchParams.get('state')).toBe(authorizationUrl!.searchParams.get('state'));
  await expect(page.getByText(/owner verified|verified owner/i)).toBeVisible();
  await nextStep(page, 'Owner verification', 'Review', 'Review');
  const wizard = page.getByRole('region', { name: 'Instance setup wizard' });
  await wizard.getByRole('button', { name: 'Review', exact: true }).last().click();
  await expect(wizard.getByRole('status')).toContainText('Review the check results and confirm setup', { timeout: 45_000 });
  for (const result of ['database: passed (database_ok)', 'zitadel discovery: passed (provider_ok)', 'github structure: passed (provider_ok)',
    'github authentication: passed (provider_ok)', 'github permissions: passed (provider_ok)', 'github installation: warning (installation_missing)',
    'github webhook: warning (delivery_unverified)']) await expect(wizard).toContainText(result);
}

async function assertNoBrowserSecret(page: Page, urls: string[]) {
  const html = await page.content();
  const response = await page.request.get(page.url());
  const serverHtml = await response.text();
  const snapshot = await page.request.get(`${setupOrigin}/api/instance/setup`);
  const safeSnapshot = await snapshot.text();
  const storage = await page.evaluate(() => JSON.stringify({
    local: Object.entries(localStorage), session: Object.entries(sessionStorage),
  }));
  for (const sentinel of [sentinelClientSecret, sentinelWebhookSecret]) {
    expect(html).not.toContain(sentinel);
    expect(serverHtml).not.toContain(sentinel);
    expect(safeSnapshot).not.toContain(sentinel);
    expect(page.url()).not.toContain(sentinel);
    expect(urls.some(url => url.includes(sentinel))).toBe(false);
    expect(storage).not.toContain(sentinel);
  }
}

async function setupState() {
  const response = await fixture('/setup/state', 'GET');
  return response.json() as Promise<{ lifecycle: string; ownerCount: number; candidateVersion: number | null }>;
}

test.beforeEach(async () => {
  await fixture('/setup/reset');
});

test.describe('mobile fresh setup', () => {
  test.use({ viewport: { width: 375, height: 812 }, colorScheme: 'dark' });

  test('completes the seven-step setup through candidate OIDC login and admits one concurrent finalizer', async ({ page }) => {
    test.setTimeout(90_000);
    const urls: string[] = [];
    page.on('request', request => urls.push(request.url()));
    const initialSetup = page.waitForResponse(response => response.url().endsWith('/api/instance/setup'));
    await page.goto(setupUrl);
    expect((await initialSetup).status()).toBe(401);
    await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);
    const credential = await bootstrapCredential();
    const welcome = page.getByLabel(/bootstrap credential/i);
    await welcome.fill(credential);
    await expect(page.getByRole('button', { name: /authorize setup/i })).toBeEnabled();
    await welcome.press('Enter');
    await expect(welcome).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Instance setup wizard' }).getByRole('status')).toContainText('Setup authorized.');

    await fillDraft(page, true);
    await assertNoBrowserSecret(page, urls);
    await verifiedSyntheticOwner(page);
    await assertNoBrowserSecret(page, urls);
    for (const step of steps) await expect(page.getByRole('navigation', { name: /setup steps/i })).toContainText(step);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: /complete setup|finish setup|confirm and finish/i })).toBeEnabled();

    const second = await page.context().newPage();
    try {
      await second.goto(setupUrl);
      await expect(second.getByRole('heading', { name: /review/i })).toBeVisible();
      const finalize = page.getByRole('button', { name: /complete setup|finish setup|confirm and finish/i });
      const competingFinalize = second.getByRole('button', { name: /complete setup|finish setup|confirm and finish/i });
      await expect(competingFinalize).toBeEnabled();
      await Promise.allSettled([finalize.click(), competingFinalize.click()]);
    } finally { await second.close(); }

    await expect.poll(async () => (await setupState()).lifecycle).toBe('ready');
    expect(await setupState()).toMatchObject({ lifecycle: 'ready', ownerCount: 1 });
    await expect(page.getByRole('heading', { name: 'Setup is complete' })).toBeVisible();
    await expect(page.getByLabel(/bootstrap credential/i)).toHaveCount(0);

    const status = await page.request.get(`${setupOrigin}/api/instance/status`);
    const csrf = /__Host-librarian_pre_csrf=([^;]+)/.exec(status.headers()['set-cookie'] ?? '')?.[1];
    expect(csrf).toBeTruthy();
    const reused = await page.request.post(`${setupOrigin}/api/instance/setup/authorize`, {
      headers: { origin: setupOrigin, cookie: `__Host-librarian_pre_csrf=${csrf}`, 'x-csrf-token': csrf! },
      data: { credential: await bootstrapCredential() },
    });
    expect(reused.status()).toBe(409);
    expect(await reused.text()).not.toContain(await bootstrapCredential());
  });
});

test('expires a setup session without losing the durable draft and requires a new authorization', async ({ page }) => {
  await authorize(page);
  await fillDraft(page, false);
  await fixture('/setup/expire-sessions');
  const denied = await page.request.get(`${setupOrigin}/api/instance/setup`);
  expect(denied.status()).toBe(401);
  const expiredSetup = page.waitForResponse(response => response.url().endsWith('/api/instance/setup') && response.request().method() === 'GET');
  await page.reload();
  expect((await expiredSetup).status()).toBe(401);
  const credential = page.getByLabel(/bootstrap credential/i);
  await expect(credential).toBeVisible();
  await credential.fill(await bootstrapCredential());
  const authorizeButton = page.getByRole('button', { name: /authorize setup/i });
  await expect(authorizeButton).toBeEnabled();
  await authorizeButton.click();
  await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
  await nextStep(page, 'Welcome', 'Database');
  await nextStep(page, 'Database', 'Zitadel');
  await nextStep(page, 'Zitadel', 'GitHub App');
  await nextStep(page, 'GitHub App', 'Preferences');
  await expect(page.getByLabel(/display name/i)).toHaveValue('Synthetic Setup Portal');
});

test('keeps a saved draft across browser close and setup-process restart while requiring bootstrap reauthorization', async ({ browser }) => {
  test.setTimeout(90_000);
  const original = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await original.newPage();
    await authorize(page);
    await fillDraft(page, false);
    await expect(page.getByRole('heading', { name: /owner verification/i })).toBeVisible();
  } finally { await original.close(); }

  await fixture('/setup/restart');
  const reopened = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await reopened.newPage();
    await authorize(page);
    await nextStep(page, 'Welcome', 'Database');
    await nextStep(page, 'Database', 'Zitadel');
    await nextStep(page, 'Zitadel', 'GitHub App');
    await nextStep(page, 'GitHub App', 'Preferences');
    await expect(page.getByLabel(/display name/i)).toHaveValue('Synthetic Setup Portal');
  } finally { await reopened.close(); }
});

test.describe('mobile setup errors', () => {
  test.use({ viewport: { width: 360, height: 800 }, colorScheme: 'dark' });

  test('keeps setup errors accessible on a phone and does not echo a rejected credential', async ({ page }) => {
    const wrong = 'SYNTHETIC_WRONG_BOOTSTRAP_SENTINEL';
    const initialSetup = page.waitForResponse(response => response.url().endsWith('/api/instance/setup'));
    await page.goto(setupUrl);
    expect((await initialSetup).status()).toBe(401);
    await expect(page.locator('html')).toHaveClass(/dark/);
    const credential = page.getByLabel(/bootstrap credential/i);
    await credential.fill(wrong);
    await expect(page.getByRole('button', { name: /authorize setup/i })).toBeEnabled();
    await credential.press('Enter');
    const wizard = page.getByRole('region', { name: 'Instance setup wizard' });
    const error = wizard.getByRole('alert');
    await expect(error).toBeVisible();
    await expect(credential).toHaveValue('');
    expect(await error.innerText()).not.toContain(wrong);
    expect(await page.content()).not.toContain(wrong);
    expect(page.url()).not.toContain(wrong);
    await expect(error).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
