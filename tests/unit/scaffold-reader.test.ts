import { beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as route from '../../app/[repoSlug]/[[...page]]/page';
import Reader, { generateMetadata } from '../../app/[repoSlug]/[[...page]]/page';
import { ProjectSearchProvider } from '@/components/project-search';

const state = vi.hoisted(() => ({
  db: {},
  content: { manifest: { generationId: '00000000-0000-4000-8000-000000000001' }, generation: {}, loader: { pageTree: { name: 'Synthetic tree', children: [] }, getPage: vi.fn() } },
  withRuntimeContent: vi.fn(),
  getMongo: vi.fn(),
  listDirectoryCards: vi.fn(),
}));
vi.mock('@/lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('@/lib/content/source', () => ({ withRuntimeContent: state.withRuntimeContent }));
vi.mock('@/lib/catalog', () => ({
  listDirectoryCards: state.listDirectoryCards,
  isCatalogSlug: (value: string) => /^[a-z][a-z0-9-]{0,62}$/.test(value) && !['admin', 'api', 'auth', 'health'].includes(value),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_HTTP_ERROR_FALLBACK;404'); } }));

beforeEach(() => {
  vi.clearAllMocks();
  state.getMongo.mockResolvedValue({ db: state.db, contentRoot: 'synthetic-root' });
  state.listDirectoryCards.mockResolvedValue([]);
  state.withRuntimeContent.mockImplementation(async (_db, _root, _slug, _generation, read) => read(
    state.content, new AbortController().signal, { privateContent: false, roleVerifiedAt: null }));
  state.content.loader.getPage.mockReturnValue({
    data: { title: 'Synthetic guide', description: 'Safe description', frontmatter: { full: true }, load: async () => ({ render: async () => ({ toc: [], body: createElement('p', null, 'Approved body') }) }) },
    path: 'guide.md', slugs: ['guide'], url: '/synthetic/guide',
  });
});

it('renders a dynamically selected document inside its generation-scoped reader layout', async () => {
  const element = await Reader({ params: Promise.resolve({ repoSlug: 'synthetic', page: ['guide'] }), searchParams: Promise.resolve({ g: state.content.manifest.generationId }) });
  expect(state.withRuntimeContent).toHaveBeenCalledWith(state.db, 'synthetic-root', 'synthetic', state.content.manifest.generationId, expect.any(Function));
  expect(element.type).toBe(ProjectSearchProvider);
  expect(element.props).toMatchObject({ slug: 'synthetic', generation: state.content.manifest.generationId });
  const layout = element.props.children;
  expect(layout.props.tree).toMatchObject({ name: 'Synthetic tree', children: [], $id: expect.stringContaining(state.content.manifest.generationId) });
  expect(layout.props.children.props.children[0].props.children).toBe('Synthetic guide');
  expect(layout.props.children.props.children[2].props.children.props.children).toBe('Approved body');
});

it('returns metadata through the same guarded runtime source', async () => {
  await expect(generateMetadata({ params: Promise.resolve({ repoSlug: 'synthetic', page: ['guide'] }), searchParams: Promise.resolve({}) }))
    .resolves.toEqual({ title: 'Synthetic guide', description: 'Safe description' });
});

it('rejects ambiguous and invalid generation selectors and has no static parameter export', async () => {
  for (const g of [['one', 'two'], 'not-a-uuid']) {
    await expect(Reader({ params: Promise.resolve({ repoSlug: 'synthetic' }), searchParams: Promise.resolve({ g }) })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  }
  expect('generateStaticParams' in route).toBe(false);
});

it('rejects reserved application routes before loading Mongo', async () => {
  await expect(Reader({ params: Promise.resolve({ repoSlug: 'api', page: ['search'] }), searchParams: Promise.resolve({}) }))
    .rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  expect(state.getMongo).not.toHaveBeenCalled();
});

it('uses the same unavailable state when a document is absent', async () => {
  state.content.loader.getPage.mockReturnValue(undefined);
  await expect(Reader({ params: Promise.resolve({ repoSlug: 'synthetic', page: ['missing'] }), searchParams: Promise.resolve({}) }))
    .rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  await expect(generateMetadata({ params: Promise.resolve({ repoSlug: 'synthetic', page: ['missing'] }), searchParams: Promise.resolve({}) }))
    .rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
});
