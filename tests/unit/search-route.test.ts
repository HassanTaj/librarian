import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from '../../app/api/search/[repoSlug]/route';

const state = vi.hoisted(() => ({ db: {}, content: { loader: {} }, getMongo: vi.fn(), withRuntimeContent: vi.fn(), searchContent: vi.fn() }));
vi.mock('@/lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('@/lib/content/source', () => ({ withRuntimeContent: state.withRuntimeContent }));
vi.mock('@/lib/content/search', () => ({ searchContent: state.searchContent }));

const handler = (url: string) => GET(new Request(url) as never, { params: Promise.resolve({ repoSlug: 'public-project' }) });

beforeEach(() => {
  vi.clearAllMocks();
  state.getMongo.mockResolvedValue({ db: state.db, contentRoot: 'synthetic-root' });
  state.withRuntimeContent.mockImplementation(async (_db, _root, _slug, _generation, read) => read(state.content, new AbortController().signal));
  state.searchContent.mockResolvedValue([{ id: 'doc#heading', url: '/public-project/doc?g=synthetic', type: 'heading', content: 'Synthetic result', breadcrumbs: ['Docs'] }]);
});

it('returns repository-scoped Fumadocs results without shared caching', async () => {
  const response = await handler('https://portal.synthetic/api/search/public-project?query=synthetic&g=00000000-0000-4000-8000-000000000001');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual([{ id: 'doc#heading', url: '/public-project/doc?g=synthetic', type: 'heading', content: 'Synthetic result', breadcrumbs: ['Docs'] }]);
  expect(state.withRuntimeContent).toHaveBeenCalledWith(state.db, 'synthetic-root', 'public-project', '00000000-0000-4000-8000-000000000001', expect.any(Function));
  expect(state.searchContent).toHaveBeenCalledWith(state.content, 'synthetic');
});

it('runs empty search inside the access boundary and bounds UTF-8 input and duplicate selectors', async () => {
  const empty = await handler('https://portal.synthetic/api/search/public-project?query=');
  expect(empty.status).toBe(200);
  expect(state.searchContent).toHaveBeenCalledWith(state.content, '');
  vi.clearAllMocks();
  const oversized = await handler(`https://portal.synthetic/api/search/public-project?query=${encodeURIComponent('🙂'.repeat(65))}`);
  expect(oversized.status).toBe(400);
  expect(state.getMongo).not.toHaveBeenCalled();
  const duplicate = await handler('https://portal.synthetic/api/search/public-project?query=a&query=b');
  expect(duplicate.status).toBe(400);
});

it('sanitizes access and storage failures and does not export a static index handler', async () => {
  state.withRuntimeContent.mockRejectedValue(new Error('unauthorized'));
  const denied = await handler('https://portal.synthetic/api/search/private-one?query=sentinel');
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('sentinel');
  state.withRuntimeContent.mockRejectedValue(new Error('storage_unavailable'));
  expect((await handler('https://portal.synthetic/api/search/public-project?query=synthetic')).status).toBe(503);
  const route = await import('../../app/api/search/[repoSlug]/route');
  expect('staticGET' in route).toBe(false);
});

it('validates repeated or malformed generation selectors and maps boundary errors safely', async () => {
  expect((await handler('https://portal.synthetic/api/search/public-project?query=ok&g=bad')).status).toBe(400);
  expect((await handler('https://portal.synthetic/api/search/public-project?query=ok&g=a&g=b')).status).toBe(400);
  for (const [code, status] of [['invalid_path', 400], ['invalid_query', 400], ['not_found', 404],
    ['content_unavailable', 404], ['reload_required', 409], ['synthetic_provider_detail', 503]] as const) {
    state.withRuntimeContent.mockRejectedValueOnce(new Error(code));
    const response = await handler('https://portal.synthetic/api/search/public-project?query=ok');
    expect(response.status, code).toBe(status);
    expect(await response.text()).not.toContain('synthetic_provider_detail');
  }
  state.getMongo.mockRejectedValueOnce(new Error('synthetic storage detail'));
  expect((await handler('https://portal.synthetic/api/search/public-project?query=ok')).status).toBe(503);
  state.getMongo.mockResolvedValueOnce({ db: state.db, contentRoot: null });
  expect((await handler('https://portal.synthetic/api/search/public-project?query=ok')).status).toBe(503);
});

