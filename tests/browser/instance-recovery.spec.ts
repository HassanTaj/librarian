import { expect, test } from '@playwright/test';

test.use({ ignoreHTTPSErrors: true });

const setupOrigin = 'https://localhost:3200';
const fixtureOrigin = 'http://127.0.0.1:3101';

test('resumes protected recovery after restart and stays in maintenance until the host operation completes', async ({ page }) => {
  test.setTimeout(120_000);
  const prepared = await fetch(`${fixtureOrigin}/recovery/prepare`, { method: 'POST' });
  expect(prepared.status).toBe(200);
  const { recoveryCredential } = await prepared.json() as { recoveryCredential: string };

  const recoveryStatus = page.waitForResponse(response => response.url().endsWith('/api/instance/setup') && response.request().method() === 'GET');
  await page.goto(`${setupOrigin}/instance/setup`);
  expect((await recoveryStatus).status()).toBe(401);
  await expect(page.getByRole('heading', { name: 'Verify a recovery identity' })).toBeVisible();
  await expect(page.getByText(/fresh setup remains consumed/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /reset/i })).toHaveCount(0);

  const credential = page.getByLabel('Protected recovery credential');
  await credential.fill(recoveryCredential);
  const authorize = page.getByRole('button', { name: 'Authorize target verification' });
  await expect(authorize).toBeEnabled();
  const authorization = page.waitForResponse(response => response.url().endsWith('/api/instance/setup/authorize') && response.request().method() === 'POST');
  await credential.press('Enter');
  const authorizationResponse = await authorization;
  const authorizationBody = await authorizationResponse.json() as { error?: { code?: string } };
  const authorizationRequest = authorizationResponse.request();
  const requestHeaders = await authorizationRequest.allHeaders();
  const requestBody = authorizationRequest.postDataJSON() as { credential?: unknown };
  const safeRequest = { contentType: requestHeaders['content-type'], origin: requestHeaders.origin,
    credentialLength: typeof requestBody.credential === 'string' ? requestBody.credential.length : null,
    credentialFormatValid: typeof requestBody.credential === 'string' && /^[A-Za-z0-9_-]+$/.test(requestBody.credential) };
  expect(authorizationResponse.status(), `safe authorization error: ${authorizationBody.error?.code ?? 'none'}; request: ${JSON.stringify(safeRequest)}`).toBe(200);

  const provider = await (await fetch(`${fixtureOrigin}/setup/provider`)).json() as { origin: string };
  await page.route(`${provider.origin}/authorize**`, route => route.continue());
  const callback = page.waitForRequest(request => request.url().startsWith(`${setupOrigin}/api/instance/auth/callback/zitadel?`));
  await page.getByRole('button', { name: 'Sign in as the recovery target' }).click();
  await callback;
  await expect(page.getByText(/Target identity verified\. Give the host operator proof ID/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Stop all processes before the host operation/)).toBeVisible();

  const state = await (await fetch(`${fixtureOrigin}/settings/state`)).json();
  expect(state).toMatchObject({ state: 'maintenance', activeVersion: 1, candidateVersion: 2, gate: 'maintenance' });
  const health = await page.request.get(`${setupOrigin}/api/health`);
  expect(health.status()).toBe(503);
  expect(await health.json()).toMatchObject({ status: 'not_ready' });
});
