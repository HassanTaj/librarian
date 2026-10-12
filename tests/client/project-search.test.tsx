import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSearch } from '../../components/project-search';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  await act(async () => root.render(<ProjectSearch slug="librarian" generation="gen-1" />));
  await act(async () => container.querySelector('button')!.click());
  return container.querySelector<HTMLInputElement>('#project-search')!;
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
  const links = container.querySelectorAll<HTMLAnchorElement>('#project-search-panel a');
  expect(links.length).toBe(20);
  expect(links[0].getAttribute('href')).toBe('/librarian/page-0?g=gen-1');
  expect(links[0].textContent).toContain('Documentation page');
});

it('reports empty results and clears them when closed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  const input = await openSearch();
  await enterQuery(input, 'missing');
  await waitForSearch();
  expect(container.textContent).toContain('No matching pages.');

  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('#project-search')).toBeNull();
  expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
});

it('shows a safe error when the search service fails or returns a malformed payload', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValueOnce(new Response('{"not":"an array"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const input = await openSearch();

  await enterQuery(input, 'first');
  await waitForSearch();
  expect(container.textContent).toContain('Search is temporarily unavailable.');

  await enterQuery(input, 'second');
  await waitForSearch();
  expect(container.textContent).toContain('Search is temporarily unavailable.');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
