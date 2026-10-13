import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSearch } from '../../components/project-search';
import { FrameworkProvider } from 'fumadocs-core/framework';

let container: HTMLDivElement;
let root: Root;
const navigate = vi.fn();

function SearchTestFramework({ children }: { children: ReactNode }) {
  return <FrameworkProvider
    usePathname={() => '/librarian'}
    useParams={() => ({ repoSlug: 'librarian' })}
    useRouter={() => ({ push: navigate, refresh: () => {} })}
    Link={({ href, children, ...props }: ComponentProps<'a'> & { prefetch?: boolean }) => <a href={href} {...props}>{children}</a>}>
    {children}
  </FrameworkProvider>;
}

beforeEach(() => {
  navigate.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openSearch() {
  await act(async () => root.render(<SearchTestFramework><ProjectSearch slug="librarian" generation="gen-1" /></SearchTestFramework>));
  const button = container.querySelector('button')!;
  expect(button.getAttribute('aria-label')).toBe('Open Search');
  expect(button.hasAttribute('data-search')).toBe(true);
  expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  await act(async () => button.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  return dialog.querySelector<HTMLInputElement>('[role="combobox"]')!;
}

async function enterQuery(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function waitForSearch() {
  await act(async () => new Promise(resolve => setTimeout(resolve, 220)));
}

it('shows only same-project, same-generation results and caps the list', async () => {
  const valid = (index: number) => ({
    id: `page-${index}`, type: 'page', url: `/librarian/page-${index}?g=gen-1`, content: 'Search result', breadcrumbs: [],
  });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify([
    { id: 'missing-type', url: '/librarian/missing-type?g=gen-1', content: 'MISSING_TYPE_SENTINEL', breadcrumbs: [] },
    valid(0),
    { ...valid(1), url: '/other/page?g=gen-1' },
    { ...valid(2), url: '/librarian/page?g=other' },
    { ...valid(3), url: 'https://elsewhere.invalid/librarian/page?g=gen-1' },
    { ...valid(4), breadcrumbs: ['safe', 42] },
    null,
    ...Array.from({ length: 30 }, (_, index) => valid(index + 5)),
  ]), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  const input = await openSearch();
  await enterQuery(input, '  guide  ');
  await waitForSearch();

  expect(fetchMock).toHaveBeenCalledWith('/api/search/librarian?query=guide&g=gen-1', expect.objectContaining({ cache: 'no-store' }));
  const options = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [role="option"]');
  expect(options.length).toBe(20);
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('MISSING_TYPE_SENTINEL');
  expect(options[0].textContent).toContain('Documentation page');
  await act(async () => options[0].click());
  expect(navigate).toHaveBeenCalledWith('/librarian/page-0?g=gen-1');
});

it('reports empty results and clears them when closed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  const input = await openSearch();
  await enterQuery(input, 'missing');
  await waitForSearch();
  expect(container.textContent).toContain('No matching pages.');

  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close Search"]')!.click());
  expect(document.querySelector('[role="combobox"]')).toBeNull();
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Open Search');
});

it('shows a safe error when the search service fails or returns a malformed payload', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValueOnce(new Response('{"not":"an array"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const input = await openSearch();

  await enterQuery(input, 'first');
  await waitForSearch();
  expect(document.body.textContent).toContain('Search is temporarily unavailable.');

  await enterQuery(input, 'second');
  await waitForSearch();
  expect(document.body.textContent).toContain('Search is temporarily unavailable.');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
