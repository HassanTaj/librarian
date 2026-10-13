import { expect, it, vi } from 'vitest';
import { adminErrorResponse, readAdminJson, requireAdmin } from '../../lib/auth/admin';
import { LIMITS } from '../../lib/limits';

const dependencies = vi.hoisted(() => ({ getAuthContext: vi.fn(), auth: vi.fn(), getMongo: vi.fn(),
  getVerifiedRoles: vi.fn(), getOAuthAccessToken: vi.fn() }));
vi.mock('../../auth', () => ({ getAuthContext: dependencies.getAuthContext, auth: dependencies.auth }));
vi.mock('../../lib/mongo', () => ({ getMongo: dependencies.getMongo }));
vi.mock('../../lib/auth/roles', () => ({ getVerifiedRoles: dependencies.getVerifiedRoles }));
vi.mock('../../lib/auth/tokens', () => ({ getOAuthAccessToken: dependencies.getOAuthAccessToken }));

it('distinguishes failed role verification from a verified absence of admin role', async () => {
  const userId = '507f1f77bcf86cd799439011';
  const config = { zitadelIssuer: 'https://identity.synthetic.invalid', zitadelProjectId: 'synthetic-project',
    zitadelClientId: 'synthetic-client', zitadelSecret: 'synthetic-secret', oauthTokenEncryptionKey: Buffer.alloc(32),
    authUrl: 'http://localhost:3000', authSecret: 'synthetic-auth-secret' };
  const findOne = vi.fn().mockResolvedValue({ providerAccountId: 'synthetic-subject' });
  const db = { collection: () => ({ findOne }) };
  dependencies.getAuthContext.mockResolvedValue({ session: { user: { id: userId } }, config });
  dependencies.getMongo.mockResolvedValue({ db });
  dependencies.auth.mockResolvedValue({ user: { id: userId } });
  const request = new Request('http://localhost/repositories', { headers: { cookie: 'authjs.session-token=synthetic-session' } });

  dependencies.getVerifiedRoles.mockRejectedValueOnce(new Error('role_verification_failed'));
  await expect(requireAdmin(request)).rejects.toThrow('admin_unavailable');

  dependencies.getVerifiedRoles.mockResolvedValueOnce([]);
  await expect(requireAdmin(request)).rejects.toThrow('admin_forbidden');
});

it('reads bounded JSON and safely handles empty request bodies', async () => {
  await expect(readAdminJson(new Request('https://portal.synthetic.invalid', { method: 'POST' }))).resolves.toEqual({});
  await expect(readAdminJson(new Request('https://portal.synthetic.invalid', { method: 'POST', body: '' }))).resolves.toEqual({});
  await expect(readAdminJson(new Request('https://portal.synthetic.invalid', { method: 'POST', body: '{"title":"Synthetic"}' })))
    .resolves.toEqual({ title: 'Synthetic' });
  await expect(readAdminJson(new Request('https://portal.synthetic.invalid', { method: 'POST', headers: {
    'content-length': String(LIMITS.maxAdminBytes + 1),
  }, body: '{}' }))).rejects.toThrow('admin_too_large');
  await expect(readAdminJson(new Request('https://portal.synthetic.invalid', { method: 'POST', body: '{' })))
    .rejects.toThrow('admin_invalid_json');
  await expect(readAdminJson(new Request('https://portal.synthetic.invalid', { method: 'POST', body: new Uint8Array([0xff]) })))
    .rejects.toThrow('admin_invalid_json');
});

it('cancels over-limit streamed bodies and sanitizes body-stream failures', async () => {
  let cancelled = false;
  const oversized = new Request('https://portal.synthetic.invalid', { method: 'POST', body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(LIMITS.maxAdminBytes + 1)); },
    cancel() { cancelled = true; },
  }), duplex: 'half' } as RequestInit);
  await expect(readAdminJson(oversized)).rejects.toThrow('admin_too_large');
  expect(cancelled).toBe(true);

  const broken = new Request('https://portal.synthetic.invalid', { method: 'POST', body: new ReadableStream({
    start(controller) { controller.error(new Error('synthetic stream failure')); },
  }), duplex: 'half' } as RequestInit);
  await expect(readAdminJson(broken)).rejects.toThrow('admin_invalid_json');
});

it('maps expected admin failures to safe status codes and hides unknown errors', async () => {
  const cases: [string, number][] = [
    ['admin_unauthorized', 401], ['admin_forbidden', 403], ['admin_origin', 403], ['admin_csrf', 403],
    ['admin_too_large', 413], ['sync_rate_limited', 429], ['admin_invalid_json', 400], ['admin_invalid_request', 400],
    ['github_invalid_catalog', 400], ['github_docs_missing', 400], ['github_access_denied', 400], ['github_not_found', 400],
    ['github_invalid_content', 400], ['github_tree_invalid', 400], ['github_unsafe_path', 400], ['github_unsafe_entry', 400],
    ['github_content_limit', 400], ['github_no_pages', 400], ['github_blob_mismatch', 400],
    ['catalog_not_found', 404], ['catalog_conflict', 409], ['sync_catalog_unavailable', 409],
    ['sync_catalog_conflict', 409], ['public_approval_required', 409], ['admin_unavailable', 503], ['sync_quota_exhausted', 503],
    ['sync_storage_unavailable', 503],
  ];
  for (const [code, status] of cases) {
    const response = adminErrorResponse(new Error(code));
    expect(response.status, code).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(JSON.stringify(await response.json())).not.toContain(code === 'admin_unavailable' ? 'synthetic private' : 'secret');
  }
  const approval = await adminErrorResponse(new Error('public_approval_required')).json();
  expect(approval.error.code).toBe('public_approval_required');
  for (const detail of ['exact scope and content', 'not a GitHub App Installation ID problem', 'PUBLIC_CATALOG_APPROVALS_FILE',
    'repository ID', 'branch', 'docs folder', 'catalog slug', 'reviewed commit', 'candidate content digest',
    'Owner approval reference', 'admin API cannot create approval records', 'docs/guides/public-catalog-approval.md', 'clear Owner approval reference',
    'rejected edit leaves prior settings unchanged']) expect(approval.error.message).toContain(detail);
  const unknown = adminErrorResponse('synthetic secret exception');
  expect(unknown.status).toBe(503);
  expect(await unknown.json()).toMatchObject({ error: { code: 'admin_unavailable', message: 'Administration is temporarily unavailable.' } });
});
