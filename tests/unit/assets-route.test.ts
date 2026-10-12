import { beforeEach, expect, it, vi } from 'vitest';
import { GET, HEAD } from '../../app/api/assets/[repoSlug]/[...path]/route';

const state = vi.hoisted(() => ({ db: {}, getMongo: vi.fn(), readAsset: vi.fn() }));
vi.mock('@/lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('@/lib/content/assets', () => ({ readAsset: state.readAsset }));

const params = Promise.resolve({ repoSlug: 'public-project', path: ['notes.txt'] });
const request = (method = 'GET', extra: Record<string, string> = {}) => new Request('https://portal.synthetic/api/assets/public-project/notes.txt?g=00000000-0000-4000-8000-000000000001', { method, headers: extra });

beforeEach(() => {
  vi.clearAllMocks();
  state.getMongo.mockResolvedValue({ db: state.db, contentRoot: 'synthetic-root' });
  state.readAsset.mockResolvedValue({ bytes: Buffer.from('Synthetic attachment'), mime: 'text/plain', inline: false, sha256: 'a'.repeat(64), filename: 'notes.txt' });
});

it('returns a manifest-mapped attachment with safe headers and no public caching', async () => {
  const response = await GET(request() as never, { params });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('Synthetic attachment');
  expect(response.headers.get('content-type')).toBe('text/plain');
  expect(response.headers.get('content-disposition')).toContain('attachment; filename="notes.txt"');
  expect(response.headers.get('content-security-policy')).toBe('sandbox');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(state.readAsset).toHaveBeenCalledWith(state.db, 'synthetic-root', 'public-project', '00000000-0000-4000-8000-000000000001', 'notes.txt', expect.any(AbortSignal));
});

it('supports guarded HEAD and conditional requests only after reading the authorized manifest asset', async () => {
  const head = await HEAD(request('HEAD') as never, { params });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength('Synthetic attachment')));
  expect(await head.text()).toBe('');
  const conditional = await GET(request('GET', { 'if-none-match': `"${'a'.repeat(64)}"` }) as never, { params });
  expect(conditional.status).toBe(304);
  expect(conditional.headers.get('content-length')).toBeNull();
  expect(state.readAsset).toHaveBeenCalledTimes(2);
});

it('does not deliver a denied body and rejects unsafe paths or generations', async () => {
  state.readAsset.mockRejectedValue(new Error('unauthorized'));
  const denied = await GET(request() as never, { params });
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('Synthetic attachment');
  expect((await GET(request() as never, { params: Promise.resolve({ repoSlug: 'public-project', path: ['..', 'notes.txt'] }) })).status).toBe(400);
  expect((await GET(new Request('https://portal.synthetic/api/assets/public-project/notes.txt?g=invalid') as never, { params })).status).toBe(400);
});

it('serves inline assets without attachment sandboxing and honors weak entity tags', async () => {
  state.readAsset.mockResolvedValue({ bytes: Buffer.from([1, 2, 3]), mime: 'image/png', inline: true,
    sha256: 'b'.repeat(64), filename: 'résumé.png' });
  const response = await GET(request() as never, { params });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toBeNull();
  expect(response.headers.get('content-disposition')).toContain(`inline; filename="r_sum_.png"; filename*=UTF-8''r%C3%A9sum%C3%A9.png`);
  expect((await GET(request('GET', { 'if-none-match': `W/"${'b'.repeat(64)}"` }) as never, { params })).status).toBe(304);
});

it('maps safe asset failures and missing storage to the expected HTTP statuses', async () => {
  for (const [code, status] of [['invalid_path', 400], ['reload_required', 409], ['not_found', 404],
    ['unauthorized', 404], ['content_unavailable', 503], ['synthetic_internal_detail', 503]] as const) {
    state.readAsset.mockRejectedValueOnce(new Error(code));
    const response = await GET(request() as never, { params });
    expect(response.status, code).toBe(status);
    expect(await response.text()).not.toContain('synthetic_internal_detail');
  }
  state.getMongo.mockResolvedValueOnce({ db: state.db, contentRoot: '' });
  expect((await HEAD(request('HEAD') as never, { params })).status).toBe(503);
  const duplicateGeneration = new Request('https://portal.synthetic/api/assets/public-project/notes.txt?g=x&g=y');
  expect((await GET(duplicateGeneration as never, { params })).status).toBe(400);
});
