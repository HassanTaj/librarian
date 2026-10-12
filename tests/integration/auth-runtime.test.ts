import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { auth, createServerAuth, getAuthContext, handlers } from '../../auth';
import { createStorageHarness } from './http-harness';

const mocks = vi.hoisted(() => ({ loadConfig: vi.fn(), getMongo: vi.fn() }));
vi.mock('../../lib/config', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../../lib/mongo', () => ({ getMongo: mocks.getMongo }));

it('builds the request-scoped Auth.js handlers from runtime config and Mongo', async () => {
  const storage = await createStorageHarness();
  const config = {
    authUrl: 'http://127.0.0.1:3000', trustHost: true, authSecret: Buffer.alloc(32, 3).toString('base64'),
    zitadelClientId: 'synthetic-client', zitadelSecret: 'synthetic-secret', zitadelIssuer: 'https://identity.example',
    zitadelProjectId: 'project-1', zitadelApiAudience: 'urn:zitadel:project:synthetic', oauthTokenEncryptionKey: Buffer.alloc(32, 4),
  } as Parameters<typeof createServerAuth>[0];
  mocks.loadConfig.mockResolvedValue(config);
  mocks.getMongo.mockResolvedValue(storage);
  try {
    await expect(auth()).rejects.toThrow();
    await expect(getAuthContext()).rejects.toThrow();

    const csrf = await handlers.GET(new NextRequest('http://127.0.0.1:3000/api/auth/csrf'));
    expect(csrf.status).toBe(200);
    expect(await csrf.json()).toMatchObject({ csrfToken: expect.any(String) });

    const signout = await handlers.POST(new NextRequest('http://127.0.0.1:3000/api/auth/signout', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrfToken=invalid&callbackUrl=%2F',
    }));
    expect(signout.status).toBeGreaterThanOrEqual(300);
    expect(signout.status).toBeLessThan(400);
    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.getMongo).toHaveBeenCalledTimes(1);
  } finally { await storage.close(); }
});
