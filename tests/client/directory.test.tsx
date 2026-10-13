import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Directory, type DirectoryCard } from '../../components/directory';

const state = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock('next-auth/react', () => ({ signIn: state.signIn }));
vi.mock('fumadocs-ui/layouts/shared/slots/theme-switch', () => ({
  ThemeSwitch: () => <button type="button" aria-label="Toggle Theme" />,
}));

let container: HTMLDivElement;
let root: Root;
const cards: DirectoryCard[] = [
  { id: 'atlas-id', slug: 'atlas', title: 'Atlas', publicDescription: 'Public docs', visibility: 'public', canOpen: true,
    url: '/atlas', syncStatus: 'succeeded', syncActive: false },
  { id: 'orion-id', slug: 'orion', title: 'Orion', publicDescription: 'Private docs', visibility: 'private', canOpen: false,
    url: '/orion', syncStatus: 'failed', syncError: 'github_invalid_content', syncActive: false },
];

function jsonResponse(value: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000099' });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function filter(value: string) {
  const input = container.querySelector<HTMLInputElement>('#project-filter')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function batchSyncButton() {
  return container.querySelector<HTMLButtonElement>('button[aria-label^="Sync "][aria-label*="selected"]')!;
}

function batchSyncCount() {
  return batchSyncButton().querySelector('span[aria-hidden="true"]')?.textContent;
}

it('labels access beside titles, aligns the toolbar and controls, and anchors status in the lower-right corner', async () => {
  await act(async () => root.render(<Directory cards={cards} showSignIn canSync />));
  expect(container.textContent).toContain('Documentation Directory');
  expect(container.textContent).toContain('Public');
  expect(container.textContent).toContain('Private');
  expect(container.textContent).not.toContain('Restricted');
  const toolbar = container.querySelector('[role="toolbar"]')!;
  expect(toolbar.getAttribute('aria-label')).toBe('Documentation directory tools');
  expect(container.querySelector('label[for="project-filter"]')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('#project-filter')?.placeholder).toBe('Filter documentation by title');
  expect(container.querySelector<HTMLInputElement>('#project-filter')?.getAttribute('aria-label')).toBe('Search documentation');
  expect([...container.querySelectorAll('nav a[href="/"]')].some(link => link.textContent?.trim() === 'Home')).toBe(true);
  expect(container.querySelector('nav a[href="/repositories"]')?.textContent).toBe('Repositories');
  const atlasCard = container.querySelector('a[href="/atlas"]')!.closest('article')!;
  const select = atlasCard.querySelector<HTMLInputElement>('input[aria-label="Select Atlas"]')!;
  const sync = atlasCard.querySelector<HTMLButtonElement>('button[aria-label="Sync Atlas"]')!;
  const links = atlasCard.querySelectorAll<HTMLAnchorElement>('a[href="/atlas"]');
  const cardLink = links[0]!;
  expect(select.type).toBe('checkbox');
  expect(select.closest('label')).not.toBeNull();
  expect(sync.type).toBe('button');
  const header = sync.parentElement as HTMLElement;
  expect(header.children).toHaveLength(2);
  expect(header.firstElementChild?.firstElementChild).toBe(select.closest('label'));
  expect((header.firstElementChild?.children[1] as HTMLAnchorElement).querySelector('h2')?.textContent).toBe('Atlas');
  expect((header.firstElementChild?.children[1] as HTMLAnchorElement).textContent).toContain('Public');
  expect(select.closest('label')?.parentElement?.parentElement).toBe(header);
  expect(cardLink.querySelector('h2')?.textContent).toBe('Atlas');
  const orionCard = [...container.querySelectorAll('article')].find(article => article.textContent?.includes('Orion'))!;
  expect(orionCard.querySelector('h2')?.textContent).toBe('Orion');
  expect(orionCard.querySelector('a[href="/orion"]')).toBeNull();
  expect(orionCard.textContent).toContain('Documentation is unavailable until a successful sync.');
  const status = atlasCard.querySelector('[aria-label="Sync status: succeeded"]')!;
  expect(status.parentElement?.parentElement).toBe(atlasCard);
  expect(status.parentElement).toBe(atlasCard.lastElementChild);
  expect([...atlasCard.querySelectorAll('span')].some(label => label.textContent === 'Public')).toBe(true);
  expect(container.querySelector('a[href="/atlas"]')).not.toBeNull();
  expect(container.querySelector('a[href="/orion"]')).toBeNull();
  await filter(' ORI ');
  expect(container.querySelectorAll('ul li')).toHaveLength(1);
  expect(container.querySelector('ul')?.textContent).toContain('Orion');
  await filter('private docs');
  expect(container.textContent).toContain('No projects match that title.');
  expect(container.textContent).toContain('Sign in with Zitadel');
});

it('keeps the complete long title and description available', async () => {
  const title = 'An unusually long documentation repository title that exceeds the available card width';
  const description = 'A long description that needs a visual limit. '.repeat(12);
  await act(async () => root.render(<Directory cards={[{ ...cards[0], title, publicDescription: description }]} />));

  const links = container.querySelectorAll<HTMLAnchorElement>('a[href="/atlas"]');
  const heading = links[0]!.querySelector('h2')!;
  const summary = links[1]!.querySelector('p')!;
  expect(heading.title).toBe(title);
  expect(heading.textContent).toBe(title);
  expect(summary.title).toBe(description);
  expect(summary.textContent).toBe(description);
});

it('shows the selection count in the labeled sync button and keeps the checkbox accessible', async () => {
  await act(async () => root.render(<Directory cards={cards} canSync />));
  const select = container.querySelector<HTMLInputElement>('input[aria-label="Select Atlas"]')!;

  await act(async () => select.click());

  expect(select.checked).toBe(true);
  expect(batchSyncButton().getAttribute('aria-label')).toBe('Sync 1 selected document');
  expect(batchSyncCount()).toBe('1');
  expect(batchSyncButton().disabled).toBe(false);
  expect(batchSyncButton().textContent).toContain('Sync');
  expect(select.nextElementSibling?.getAttribute('aria-hidden')).toBe('true');
});

it('falls back to access and initial-sync metadata when no live status exists', async () => {
  const initialCards: DirectoryCard[] = [
    { id: 'ready-id', slug: 'ready', title: 'Ready docs', publicDescription: '', visibility: 'public', canOpen: true,
      url: '/ready' },
    { id: 'first-sync-id', slug: 'first-sync', title: 'First sync', publicDescription: '', visibility: 'private', canOpen: false,
      url: '/first-sync', syncActive: true },
  ];
  await act(async () => root.render(<Directory cards={initialCards} canSync />));

  expect(container.querySelector('[aria-label="Sync status: succeeded"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Sync status: pending"]')).not.toBeNull();
  expect(container.querySelector('a[href="/ready"]')).not.toBeNull();
  expect(container.querySelector('a[href="/first-sync"]')).toBeNull();
  const firstSyncCard = [...container.querySelectorAll('article')].find(article => article.textContent?.includes('First sync'))!;
  expect(firstSyncCard.textContent).toContain('Documentation is unavailable until a successful sync.');
  expect(firstSyncCard.querySelector<HTMLButtonElement>('button[aria-label="Sync First sync"]')?.disabled).toBe(true);
  expect(firstSyncCard.querySelector('a[href="/first-sync"]')).toBeNull();
  expect(firstSyncCard.querySelector('p')?.textContent).toBe('Documentation is unavailable until a successful sync.');
});

it('keeps a first-sync failure non-navigable and exposes a collapsed reportable issue', async () => {
  await act(async () => root.render(<Directory cards={[cards[1]]} />));
  expect(container.querySelector('article a')).toBeNull();
  expect(container.querySelector('[aria-label="Sync status: failed"]')?.textContent).toBe('failed');
  const details = container.querySelector('details')!;
  expect(details.nextElementSibling?.querySelector('[aria-label="Sync status: failed"]')).not.toBeNull();
  expect(details.open).toBe(false);
  expect(details.textContent).toContain('Safe static Fumadocs MDX components are supported');
  details.open = true;
  expect(details.querySelector('[role="alert"]')?.textContent).toContain('github_invalid_content');

  const priorSuccess = { ...cards[0], syncStatus: 'failed' as const, syncError: 'github_unavailable' };
  await act(async () => root.render(<Directory cards={[priorSuccess]} />));
  expect(container.querySelector('a[href="/atlas"]')).not.toBeNull();
  const failedCard = container.querySelector('article')!;
  expect(failedCard.querySelector('details')).not.toBeNull();
  expect(failedCard.lastElementChild?.querySelector('[aria-label="Sync status: failed"]')).not.toBeNull();
});

it('enables batch sync only after selection and posts selected catalogs once with admin CSRF', async () => {
  vi.useFakeTimers();
  let releaseBatch: ((response: Response) => void) | undefined;
  let batchRequest: RequestInit | undefined;
  let pollStatus: 'running' | 'succeeded' = 'running';
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/admin/csrf') return Promise.resolve(jsonResponse({ csrfToken: 'synthetic-csrf' }));
    if (url === '/api/admin/repos/sync') {
      batchRequest = init;
      return new Promise<Response>(resolve => { releaseBatch = resolve; });
    }
    if (url === '/api/admin/repos') return Promise.resolve(jsonResponse({ catalogs: [
      { id: 'atlas-id', status: pollStatus, error: null }, { id: 'orion-id', status: pollStatus, error: null },
    ] }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => root.render(<Directory cards={cards} canSync />));

  expect(batchSyncButton().disabled).toBe(true);
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[aria-label="Select Atlas"]')!.click();
    container.querySelector<HTMLInputElement>('input[aria-label="Select Orion"]')!.click();
  });
  expect(batchSyncButton().getAttribute('aria-label')).toBe('Sync 2 selected documents');
  expect(batchSyncCount()).toBe('2');
  expect(batchSyncButton().disabled).toBe(false);
  await act(async () => { batchSyncButton().click(); await Promise.resolve(); await Promise.resolve(); });
  expect(batchSyncButton().getAttribute('aria-label')).toBe('Sync 2 selected documents');
  expect(releaseBatch).toBeDefined();
  expect(batchRequest).toMatchObject({ method: 'POST', headers: expect.objectContaining({ 'x-csrf-token': 'synthetic-csrf', 'idempotency-key': '00000000-0000-4000-8000-000000000099' }) });
  expect(JSON.parse(String(batchRequest?.body))).toEqual({ ids: ['atlas-id', 'orion-id'] });

  await act(async () => {
    releaseBatch!(jsonResponse({ jobs: [
      { catalogId: 'atlas-id', status: 'pending' }, { catalogId: 'orion-id', status: 'pending' },
    ] }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.querySelector('[aria-label="Sync status: pending"]')).not.toBeNull();
  expect(container.querySelector('details')).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Sync Atlas"]')?.disabled).toBe(true);
  expect(batchSyncButton().disabled).toBe(true);
  expect(batchSyncCount()).toBe('0');

  await act(async () => { await vi.advanceTimersByTimeAsync(750); });
  expect(container.querySelector('[aria-label="Sync status: running"]')).not.toBeNull();
  pollStatus = 'succeeded';
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(container.querySelector('[aria-label="Sync status: succeeded"]')).not.toBeNull();
  expect(container.querySelector('details')).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Sync Atlas"]')?.disabled).toBe(false);
});

it('keeps sync actions admin-only and distinguishes an unavailable directory from an empty one', async () => {
  await act(async () => root.render(<Directory cards={cards} />));
  expect(container.querySelector('button[aria-label="Sync Atlas"]')).toBeNull();
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  await act(async () => root.render(<Directory cards={[]} showSignIn />));
  expect(container.textContent).toContain('No documentation projects are available yet.');
  await act(async () => root.render(<Directory cards={cards} showSignIn unavailable />));
  expect(container.querySelector('[role="status"]')?.textContent).toContain('temporarily unavailable');
  expect(container.querySelector('#project-filter')).toBeNull();
});

it('shows accessible sync badges for pending, running, success, and failure states', async () => {
  const statuses = ['pending', 'running', 'succeeded', 'failed'] as const;
  const statusCards = statuses.map((syncStatus, index) => ({ ...cards[index % cards.length], id: `status-${syncStatus}`, syncStatus }));
  await act(async () => root.render(<Directory cards={statusCards} />));
  for (const status of statuses) {
    const badge = container.querySelector(`[aria-label="Sync status: ${status}"]`);
    expect(badge?.textContent).toBe(status);
  }
});

it('keeps partial sync results visible, supports deselection, and uses safe singular/error feedback', async () => {
  let syncCount = 0;
  let failCsrf = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/admin/csrf') {
      if (failCsrf) { failCsrf = false; throw 'synthetic transport failure'; }
      return jsonResponse({ csrfToken: 'synthetic-csrf' });
    }
    if (url === '/api/admin/repos/sync') {
      syncCount += 1;
      return jsonResponse({ jobs: syncCount === 1
        ? [{ catalogId: 'atlas-id', status: 'succeeded' }]
        : [{ catalogId: 'orion-id', status: 'failed', error: 'sync_storage_unavailable' }] });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => root.render(<Directory cards={cards} canSync />));

  const atlas = container.querySelector<HTMLInputElement>('input[aria-label="Select Atlas"]')!;
  const orion = container.querySelector<HTMLInputElement>('input[aria-label="Select Orion"]')!;
  const select = async (input: HTMLInputElement) => act(async () => {
    input.click();
    await Promise.resolve();
  });
  const batch = batchSyncButton;
  await select(atlas);
  await select(atlas);
  await select(atlas);
  await select(orion);
  await act(async () => { batch().click(); await Promise.resolve(); await Promise.resolve(); });
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Queued sync for 1 documentation source.');
  expect(container.querySelector('[aria-label="Sync status: succeeded"]')).not.toBeNull();
  expect(batchSyncCount()).toBe('0');

  await select(orion);
  await act(async () => { batch().click(); await Promise.resolve(); await Promise.resolve(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('0 of 1 sync requests queued. 1 could not be queued');
  expect(container.querySelector('[aria-label="Sync status: failed"]')).not.toBeNull();
  expect(batchSyncCount()).toBe('1');

  failCsrf = true;
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="Sync Orion"]')!.click();
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The sync request could not be queued.');
});

it('reports CSRF and malformed batch responses while preserving the selected source', async () => {
  let csrfCalls = 0;
  let syncCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/admin/csrf') {
      csrfCalls += 1;
      return csrfCalls === 1 ? jsonResponse({ error: { message: 'Sign-in required.' } }, 503) : jsonResponse({ csrfToken: 'synthetic-csrf' });
    }
    if (url === '/api/admin/repos/sync') {
      syncCalls += 1;
      if (syncCalls === 1) return jsonResponse({ error: { message: 'Sync queue unavailable.' } }, 503);
      return jsonResponse({});
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => root.render(<Directory cards={cards} canSync />));
  await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="Select Atlas"]')!.click(); });
  const batch = batchSyncButton;

  await act(async () => { batch().click(); await Promise.resolve(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Administrator verification failed. Sign in again, then retry.');
  expect(batchSyncCount()).toBe('1');
  await act(async () => { batch().click(); await Promise.resolve(); await Promise.resolve(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Sync queue unavailable.');
  await act(async () => { batch().click(); await Promise.resolve(); await Promise.resolve(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The sync request could not be queued.');
});

it('recovers directory sync-status polling errors and disables a card omitted from the status response', async () => {
  let polls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/admin/csrf') return jsonResponse({ csrfToken: 'synthetic-csrf' });
    if (url === '/api/admin/repos/sync') return jsonResponse({ jobs: [{ catalogId: 'orion-id', status: 'pending' }] });
    if (url === '/api/admin/repos') {
      polls += 1;
      if (polls === 1) throw 'synthetic status transport failure';
      if (polls === 2) return jsonResponse({}, 200);
      return jsonResponse({ catalogs: [] });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => root.render(<Directory cards={cards} canSync />));
  vi.useFakeTimers();

  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="Sync Orion"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(750); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Sync status could not be refreshed.');
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Sync status could not be refreshed.');
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

  expect(container.querySelector('[aria-label="Sync status: failed"]')).not.toBeNull();
  expect(container.querySelector('a[href="/orion"]')).toBeNull();
  expect(container.querySelector('details [role="alert"]')?.textContent).toContain('Issue code: catalog_not_found');
});
