import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import Reader, { generateMetadata } from '../../app/[repoSlug]/[[...page]]/page';
import { PrivateContentGuard } from '../../components/private-content-guard';
import { SignInButton } from '../../components/sign-in-button';

const state = vi.hoisted(() => ({ auth: vi.fn(), getMongo: vi.fn(), listDirectoryCards: vi.fn(), withRuntimeContent: vi.fn(), notFound: vi.fn(), docsLayout: () => null, accountControls: () => null }));
vi.mock('next/navigation', () => ({ notFound: state.notFound }));
vi.mock('../../auth', () => ({ auth: state.auth }));
vi.mock('../../components/sign-in-button', () => ({ SignInButton: vi.fn(() => null) }));
vi.mock('@/lib/catalog', () => ({ isCatalogSlug: (value: string) => /^[a-z][a-z0-9-]{0,62}$/.test(value), listDirectoryCards: state.listDirectoryCards }));
vi.mock('@/lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('@/lib/content/source', () => ({ withRuntimeContent: state.withRuntimeContent }));
vi.mock('@/lib/content/paths', () => ({ resolveContentLink: (slug: string, generation: string, path: string, href: string) =>
  href.startsWith('https:') ? href : `/${slug}/${generation}/${path}/${href}` }));
vi.mock('@/lib/layout.shared', () => ({ baseOptions: { nav: {} } }));
vi.mock('@/mdx-components', () => ({ getMDXComponents: (components = {}) => ({ a: () => null, ...components }) }));
vi.mock('fumadocs-ui/layouts/docs', () => ({ DocsLayout: state.docsLayout }));
vi.mock('fumadocs-ui/page', () => ({ DocsBody: () => null, DocsDescription: () => null, DocsPage: () => null, DocsTitle: () => null }));
vi.mock('@/components/project-selector', () => ({ ProjectSelector: () => null }));
vi.mock('@/components/project-search', () => ({ ProjectSearch: () => null }));
vi.mock('@/components/private-content-guard', () => ({ AccountControls: state.accountControls, PrivateContentGuard: () => null }));

const generation = '00000000-0000-4000-8000-000000000001';
const renderComponents = vi.fn<(components: Record<string, unknown>) => void>();
const page = {
  path: 'guides/setup', url: `/synthetic-project/guides/setup?g=${generation}`,
  data: { title: 'Setup', description: 'Configured description', frontmatter: { full: true },
    load: async () => ({ render: async (components: Record<string, unknown>) => {
      renderComponents(components);
      return { body: 'Rendered synthetic article', toc: [{ url: '#overview' }] };
    } }) },
};
const loader = { pageTree: { name: 'Synthetic docs' }, getPage: vi.fn(() => page) };
const manifest = { generationId: generation };
const projects = [{ slug: 'synthetic-project', title: 'Synthetic project' }];
const context = { privateContent: false, roleVerifiedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  state.auth.mockResolvedValue(null);
  state.getMongo.mockResolvedValue({ db: { marker: 'synthetic' }, contentRoot: 'content-root' });
  state.listDirectoryCards.mockResolvedValue(projects);
  state.notFound.mockImplementation(() => { throw new Error('NEXT_NOT_FOUND'); });
  state.withRuntimeContent.mockImplementation(async (_db, _root, _slug, _generation, render) =>
    render({ loader, manifest }, new AbortController().signal, context));
  loader.getPage.mockReturnValue(page);
  renderComponents.mockClear();
});

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
}

function signInButtons(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(signInButtons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [...(node.type === SignInButton ? [node] : []), ...signInButtons(node.props.children)];
}

function readerNavHasAccountControls(node: ReactNode): boolean {
  const visit = (node: ReactNode): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!isValidElement<{ children?: ReactNode }>(node)) return false;
    if (node.type === state.docsLayout) {
      const nav = (node.props as { nav: { children: ReactNode } }).nav;
      return visit(nav.children);
    }
    return node.type === state.accountControls || visit(node.props.children);
  };
  return visit(node);
}

const route = (repoSlug = 'synthetic-project', pagePath?: string[], g?: string | string[]) => ({
  params: Promise.resolve({ repoSlug, page: pagePath }), searchParams: Promise.resolve({ g }),
});

it('renders a selected generation page through the guarded runtime loader', async () => {
  const result = await Reader(route('synthetic-project', ['guides', 'setup', 'index'], generation));
  expect(isValidElement(result)).toBe(true);
  expect(state.withRuntimeContent).toHaveBeenCalledWith({ marker: 'synthetic' }, 'content-root', 'synthetic-project', generation, expect.any(Function));
  expect(loader.getPage).toHaveBeenCalledWith(['guides', 'setup']);
  const components = renderComponents.mock.calls.at(-1)?.[0];
  expect(components).toBeDefined();
  const anchor = components!.a as (props: ComponentProps<'a'>) => ReactElement<ComponentProps<'a'>>;
  const image = components!.img as (props: ComponentProps<'img'>) => ReactElement<ComponentProps<'img'>>;
  expect(anchor({ href: 'https://docs.synthetic.invalid/page', children: 'external' }).props).toMatchObject({
    href: 'https://docs.synthetic.invalid/page', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer',
  });
  expect(anchor({ href: '/guide.md' }).props.href).toContain('/synthetic-project/');
  expect(anchor({}).props.href).toBeUndefined();
  expect(image({ src: 'diagram.png', alt: 'Diagram', style: { width: '20px' } }).props).toMatchObject({
    alt: 'Diagram', loading: 'lazy', decoding: 'async', style: { maxWidth: '100%', height: 'auto', width: '20px' },
  });
  expect(image({ src: 42 as unknown as string }).props.src).toBeUndefined();
  expect(readerNavHasAccountControls(result)).toBe(false);
});

it('shows account controls in the public reader when a visitor is signed in', async () => {
  state.auth.mockResolvedValueOnce({ user: { id: 'synthetic-user' } });
  const result = await Reader(route());
  expect(readerNavHasAccountControls(result)).toBe(true);
});

it('wraps private rendering only while role freshness is present and returns safe metadata when denied', async () => {
  state.withRuntimeContent.mockImplementationOnce(async (_db, _root, _slug, _generation, render) =>
    render({ loader, manifest }, new AbortController().signal, { privateContent: true, roleVerifiedAt: 1234 }));
  const privateResult = await Reader(route());
  expect(isValidElement(privateResult) && privateResult.type).toBe(PrivateContentGuard);
  expect(readerNavHasAccountControls(privateResult)).toBe(true);

  state.withRuntimeContent.mockImplementationOnce(async (_db, _root, _slug, _generation, render) =>
    render({ loader, manifest }, new AbortController().signal, { privateContent: true, roleVerifiedAt: null }));
  const staleRole = await Reader(route());
  expect(text(staleRole)).toContain('Restricted project');
  expect(signInButtons(staleRole)).toHaveLength(1);

  state.withRuntimeContent.mockRejectedValueOnce(new Error('unauthorized'));
  expect(await generateMetadata(route())).toEqual({ title: 'Restricted project', description: 'Sign in to request access.' });
  state.withRuntimeContent.mockRejectedValueOnce(new Error('unauthorized'));
  const denied = await Reader(route('synthetic-project', ['guide space'], generation));
  expect(text(denied)).toContain('Restricted project');
  expect(signInButtons(denied)[0].props).toMatchObject({
    redirectTo: '/synthetic-project/guide%20space?g=00000000-0000-4000-8000-000000000001',
  });
  state.withRuntimeContent.mockRejectedValueOnce(new Error('unauthorized'));
  state.auth.mockResolvedValueOnce({ user: { id: 'synthetic-user' } });
  const authenticatedDenied = await Reader(route());
  expect(signInButtons(authenticatedDenied)).toHaveLength(0);
});

it('keeps invalid routes, generations, missing pages and unavailable content fail closed', async () => {
  await expect(Reader(route('Invalid slug'))).rejects.toThrow('NEXT_NOT_FOUND');
  await expect(Reader(route('synthetic-project', undefined, [generation]))).rejects.toThrow('NEXT_NOT_FOUND');
  await expect(Reader(route('synthetic-project', undefined, 'invalid'))).rejects.toThrow('NEXT_NOT_FOUND');
  state.getMongo.mockResolvedValueOnce({ db: {}, contentRoot: null });
  await expect(Reader(route())).rejects.toThrow('storage_unavailable');
  loader.getPage.mockReturnValueOnce(undefined as never);
  await expect(Reader(route())).rejects.toThrow('NEXT_NOT_FOUND');
  state.withRuntimeContent.mockRejectedValueOnce(new Error('not_found'));
  await expect(Reader(route())).rejects.toThrow('NEXT_NOT_FOUND');
  state.withRuntimeContent.mockRejectedValueOnce(new Error('storage_unavailable'));
  await expect(Reader(route())).rejects.toThrow('storage_unavailable');
});

it('returns generation-specific page metadata and rejects unavailable metadata sources', async () => {
  await expect(generateMetadata(route())).resolves.toEqual({ title: 'Setup', description: 'Configured description' });
  state.withRuntimeContent.mockRejectedValueOnce(new Error('content_unavailable'));
  await expect(generateMetadata(route())).rejects.toThrow('NEXT_NOT_FOUND');
  state.getMongo.mockResolvedValueOnce({ db: {}, contentRoot: null });
  await expect(generateMetadata(route())).rejects.toThrow('storage_unavailable');
});
