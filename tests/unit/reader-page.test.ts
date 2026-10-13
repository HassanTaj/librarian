import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CardProps } from 'fumadocs-ui/components/card';
import Reader, { generateMetadata } from '../../app/[repoSlug]/[[...page]]/page';
import Link from 'next/link';
import { ProjectSearch } from '../../components/project-search';
import { RuntimeSidebarFolder, RuntimeSidebarItem } from '../../components/runtime-sidebar';
import { PrivateContentGuard } from '../../components/private-content-guard';
import { SignInButton } from '../../components/sign-in-button';
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';

const state = vi.hoisted(() => ({ auth: vi.fn(), getMongo: vi.fn(), withRuntimeContent: vi.fn(), notFound: vi.fn(), docsLayout: () => null, accountControls: () => null }));
vi.mock('next/navigation', () => ({ notFound: state.notFound }));
vi.mock('../../auth', () => ({ auth: state.auth }));
vi.mock('../../components/sign-in-button', () => ({ SignInButton: vi.fn(() => null) }));
vi.mock('@/lib/catalog', () => ({ isCatalogSlug: (value: string) => /^[a-z][a-z0-9-]{0,62}$/.test(value) }));
vi.mock('@/lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('@/lib/content/source', () => ({ withRuntimeContent: state.withRuntimeContent }));
vi.mock('@/lib/content/paths', () => ({ resolveContentLink: (slug: string, generation: string, path: string, href: string) =>
  href.startsWith('https:') ? href : `/${slug}/${generation}/${path}/${href}` }));
vi.mock('@/lib/layout.shared', () => ({ baseOptions: { nav: {} } }));
vi.mock('@/mdx-components', () => ({ getMDXComponents: (components = {}) => ({ a: () => null, ...components }) }));
vi.mock('fumadocs-ui/layouts/docs', () => ({ DocsLayout: state.docsLayout }));
vi.mock('fumadocs-ui/page', () => ({ DocsBody: () => null, DocsDescription: () => null, DocsPage: () => null, DocsTitle: () => null }));
vi.mock('@/components/runtime-sidebar', () => ({ RuntimeSidebarFolder: () => null, RuntimeSidebarItem: () => null }));
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
const context = { privateContent: false, roleVerifiedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  state.auth.mockResolvedValue(null);
  state.getMongo.mockResolvedValue({ db: { marker: 'synthetic' }, contentRoot: 'content-root' });
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
      const props = node.props as { nav: { children: ReactNode }; sidebar: { banner: ReactNode; footer: ReactNode } };
      return visit(props.nav.children) || visit(props.sidebar.banner) || visit(props.sidebar.footer);
    }
    return node.type === state.accountControls || visit(node.props.children);
  };
  return visit(node);
}

function readerNav(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(readerNav);
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === state.docsLayout) {
    const props = node.props as { nav: { children: ReactNode }; sidebar: { banner: ReactNode; footer: ReactNode } };
    return [props.nav.children, props.sidebar.banner, props.sidebar.footer];
  }
  return readerNav(node.props.children);
}

function elements(node: ReactNode): ReactElement<Record<string, unknown> & { children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown> & { children?: ReactNode }>(node)) return [];
  return [node, ...elements(node.props.children)];
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

it('resolves MDX Card links within the selected generation and leaves unlinked cards without a target', async () => {
  await Reader(route('synthetic-project', ['guides', 'setup'], generation));
  const components = renderComponents.mock.calls.at(-1)?.[0];
  const card = components!.Card as (props: CardProps) => ReactElement<CardProps>;

  const linked = card({ title: 'Reference', href: 'reference.md', children: 'Read reference' });
  const unlinked = card({ title: 'Overview', children: 'Read overview' });

  expect(linked.props.href).toBe(`/synthetic-project/${generation}/guides/setup/reference.md`);
  expect(unlinked.props.href).toBeUndefined();
});

it('shows account controls in the public reader when a visitor is signed in', async () => {
  state.auth.mockResolvedValueOnce({ user: { id: 'synthetic-user' } });
  const result = await Reader(route());
  expect(readerNavHasAccountControls(result)).toBe(true);
  const layout = elements(result).find(node => node.type === state.docsLayout)!;
  const layoutProps = layout.props as { themeSwitch: { enabled: boolean }; sidebar: { banner?: ReactNode; footer: ReactNode; components: { Folder: unknown; Item: unknown } } };
  expect(layoutProps.themeSwitch).toEqual({ enabled: false });
  expect(layoutProps.sidebar.components).toEqual({ Folder: RuntimeSidebarFolder, Item: RuntimeSidebarItem });
  const banner = elements(layoutProps.sidebar.banner);
  const footer = elements(layoutProps.sidebar.footer);
  expect(banner.some(node => node.type === state.accountControls)).toBe(false);
  expect(banner.some(node => node.type === ProjectSearch)).toBe(false);
  expect(footer.some(node => node.type === ProjectSearch)).toBe(true);
  expect(footer.find(node => node.type === state.accountControls)?.props).toMatchObject({ compact: true });
  expect(footer.find(node => node.type === ThemeSwitch)?.props.className).toContain('rounded-full');
  const actionGroup = footer.find(node => node.props['data-reader-sidebar-actions'] === true);
  expect(actionGroup).toBeDefined();
  const actionItems = elements(actionGroup!.props.children);
  expect(actionItems.some(node => node.type === ProjectSearch)).toBe(true);
  expect(actionItems.some(node => node.type === Link && node.props['aria-label'] === 'Home')).toBe(true);
  const nav = elements(readerNav(result));
  expect(nav.some(node => node.type === Link && node.props['aria-label'] === 'Home')).toBe(true);
  expect(layoutProps.sidebar.banner).toBeUndefined();
  expect(nav.some(node => node.type === ProjectSearch)).toBe(true);
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
