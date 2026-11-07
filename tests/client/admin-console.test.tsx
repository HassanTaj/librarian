import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminConsole } from '../../components/admin-console';

vi.mock('fumadocs-ui/layouts/shared/slots/theme-switch', () => ({
  ThemeSwitch: () => <button type="button" aria-label="Toggle Theme" />,
}));

type Catalog = {
  id: string; revision: number; updatedAt: string;
  github: { owner: string; name: string; branch: string; docsPath: string; installationId: number; repositoryId: number };
  slug: string; title: string; publicDescription: string; visibility: 'public' | 'private'; readerRole: string;
  approvalRef: string | null; enabled: boolean; accessState: string; status: 'pending' | 'running' | 'succeeded' | 'failed';
  error: string | null; nextAttemptAt?: string | null; publishedCommit: string | null; lastSuccessAt: string | null;
};

let container: HTMLDivElement;
let root: Root;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function catalog(overrides: Partial<Catalog> = {}): Catalog {
  return { id: 'catalog-1', revision: 2, updatedAt: '2026-10-12T00:00:00.000Z',
    github: { owner: 'synthetic', name: 'docs', branch: 'main', docsPath: 'docs', installationId: 61, repositoryId: 51 },
    slug: 'synthetic-docs', title: 'Synthetic docs', publicDescription: 'Safe description', visibility: 'private',
    readerRole: 'docs:synthetic-docs:reader', approvalRef: null, enabled: true, accessState: 'ready', status: 'pending',
    error: null, publishedCommit: null, lastSuccessAt: null, ...overrides };
}

function api(initial: Catalog[] = []) {
  let catalogs = [...initial];
  const requests: { url: string; init?: RequestInit }[] = [];
  const listResponses: Catalog[][] = [];
  const creates: Response[] = [];
  const patches: Response[] = [];
  const deletes: Response[] = [];
  const syncs: Response[] = [];
  const throws = { create: [] as unknown[], patch: [] as unknown[], delete: [] as unknown[], sync: [] as unknown[] };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === '/api/admin/csrf') return json({ csrfToken: 'csrf-synthetic' });
    if (url === '/api/admin/repos' && !init?.method) return json({ catalogs: listResponses.shift() ?? catalogs });
    if (url === '/api/admin/repos' && init?.method === 'POST') {
      if (throws.create.length) throw throws.create.shift();
      if (creates.length) return creates.shift()!;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      catalogs = [...catalogs, catalog({ id: `catalog-${catalogs.length + 1}`, github: body.github as Catalog['github'],
        slug: String(body.slug), title: String(body.title), visibility: body.visibility as Catalog['visibility'],
        approvalRef: body.approvalRef as string | null ?? null, readerRole: String(body.readerRole ?? 'docs:default:reader') })];
      return json({ catalog: catalogs.at(-1), revision: 1 }, 201);
    }
    if (url.startsWith('/api/admin/repos/catalog-1/') && url.endsWith('/sync')) {
      if (throws.sync.length) throw throws.sync.shift();
      return syncs.shift() ?? json({ status: 'pending' }, 202);
    }
    if (url === '/api/admin/repos/catalog-1' && init?.method === 'DELETE') {
      if (throws.delete.length) throw throws.delete.shift();
      const response = deletes.shift() ?? new Response(null, { status: 204 });
      if (response.ok) catalogs = catalogs.filter(item => item.id !== 'catalog-1');
      return response;
    }
    if (url === '/api/admin/repos/catalog-1' && init?.method === 'PATCH') {
      if (throws.patch.length) throw throws.patch.shift();
      const response = patches.shift();
      if (response && !response.ok) return response;
      const body = JSON.parse(String(init.body)) as Partial<Catalog>;
      let updated: Catalog | undefined;
      catalogs = catalogs.map(item => {
        if (item.id !== 'catalog-1') return item;
        updated = { ...item, ...body, github: body.github ?? item.github,
          revision: item.revision + 1, updatedAt: '2026-10-12T00:00:01.000Z' };
        return updated;
      });
      return response ?? json({ catalog: updated, revision: updated?.revision });
    }
    return json({ error: { message: 'Not found.' } }, 404);
  });
  return { fetchMock, requests, creates, patches, deletes, syncs, listResponses, throws };
}

async function render(defaultDocsFolder?: string) {
  await act(async () => root.render(<AdminConsole defaultDocsFolder={defaultDocsFolder} />));
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
}

function forms() { return [...container.querySelectorAll('form')]; }
function field(form: HTMLFormElement, name: string) {
  const label = [...form.querySelectorAll('label')].find(item => item.textContent?.startsWith(name));
  const input = label?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea');
  if (!input) throw new Error(`Missing test field: ${name}`);
  return input;
}

async function showConfigure() {
  const button = container.querySelector<HTMLButtonElement>('button[aria-controls="new-catalog-form"]');
  if (button?.getAttribute('aria-expanded') !== 'true') await act(async () => button?.click());
}

async function expandCatalog(title = 'Synthetic docs') {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === `View ${title} details`);
  if (button) await act(async () => button.click());
}

async function editCatalog(title?: string) {
  const target = title ?? container.querySelector('article h3')?.textContent ?? 'Synthetic docs';
  let button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === `Edit ${target}`);
  if (!button) {
    await expandCatalog(target);
    button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === `Edit ${target}`);
  }
  if (!button) throw new Error(`Missing editor action for ${target}`);
  await act(async () => button!.click());
}

async function setField(form: HTMLFormElement, name: string, value: string) {
  const input = field(form, name);
  await act(async () => {
    const constructor = input instanceof HTMLSelectElement ? HTMLSelectElement : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(constructor.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('keeps repository controls and copy out of the skeleton while the list is pending', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  await act(async () => { root.render(<AdminConsole />); await Promise.resolve(); });

  expect(container.querySelector('[aria-label="Loading configured repositories"]')).not.toBeNull();
  expect(container.querySelectorAll('article[aria-hidden="true"]')).toHaveLength(3);
  expect(container.querySelector('dl')).toBeNull();
  expect(container.textContent).not.toContain('Configured Repositories');
  expect(container.textContent).not.toContain('Configure repository sources and review synchronization status.');
  expect(container.textContent).not.toContain('Configure');
  expect(container.textContent).not.toContain('Repository type');
  expect(container.textContent).not.toContain('Enabled');
  expect(container.textContent).not.toContain('Published commit');
  expect(container.textContent).not.toContain('Last successful sync');
});

it('starts catalog loading without waiting for CSRF and removes the skeleton as soon as both responses are ready', async () => {
  let resolveCsrf!: (response: Response) => void;
  let resolveCatalogs!: (response: Response) => void;
  const csrf = new Promise<Response>(resolve => { resolveCsrf = resolve; });
  const catalogs = new Promise<Response>(resolve => { resolveCatalogs = resolve; });
  const fetchMock = vi.fn((url: string) => url === '/api/admin/csrf' ? csrf : catalogs);
  vi.stubGlobal('fetch', fetchMock);
  await render();
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/repos', { cache: 'no-store' });
  expect(container.querySelector('[aria-label="Loading configured repositories"]')).not.toBeNull();
  await act(async () => { resolveCatalogs({ ok: true, json: async () => ({ catalogs: [catalog()] }) } as Response); });
  await act(async () => {
    resolveCsrf({ ok: true, json: async () => ({ csrfToken: 'csrf-synthetic' }) } as Response);
  });
  expect(container.querySelector('[aria-label="Loading configured repositories"]')).toBeNull();
  expect(container.textContent).toContain('Synthetic docs');
});

it('fails closed when CSRF or catalog status cannot be loaded', async () => {
  const failedCsrf = vi.fn().mockResolvedValueOnce(new Response('invalid', { status: 503 }));
  vi.stubGlobal('fetch', failedCsrf);
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('The request could not be completed.');
  expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);

  await act(async () => root.unmount());
  root = createRoot(container);
  const failedList = vi.fn()
    .mockResolvedValueOnce(json({ csrfToken: 'csrf-synthetic' }))
    .mockResolvedValueOnce(json({ error: { message: 'Catalog status unavailable.' } }, 503));
  vi.stubGlobal('fetch', failedList);
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Catalog status unavailable.');
  expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
});

it('shows card-shaped skeleton rows while the initial repository list is loading', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
  await act(async () => root.render(<AdminConsole />));
  expect(container.querySelector('[role="status"][aria-label="Loading configured repositories"]')?.getAttribute('aria-busy')).toBe('true');
  expect(container.querySelectorAll('[role="status"] article')).toHaveLength(3);
  expect(container.textContent).not.toContain('Loading administration');
});

it('uses the bounded fallback message for non-Error status and update failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce('synthetic transport failure'));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Administration is unavailable.');

  await act(async () => root.unmount());
  root = createRoot(container);
  const server = api([catalog()]);
  server.throws.patch.push('synthetic transport failure');
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  await editCatalog();
  await submit(forms()[1]!);
  expect(container.querySelector('details summary')?.textContent).toContain('Repository could not be saved');
  expect(container.querySelector('#catalog-settings-catalog-1')?.hasAttribute('hidden')).toBe(false);
});

it('creates private catalogs without a public approval reference and creates public catalogs only with one', async () => {
  const server = api();
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  expect(container.textContent).toContain('No repositories are configured.');
  await showConfigure();
  const createForm = forms()[0];
  for (const [name, value] of [['GitHub owner', 'synthetic'], ['Repository name', 'private-docs'], ['GitHub installation ID', '61'], ['Portal route slug', 'private-docs'], ['Display title', 'Private docs'], ['Required reader role', 'docs:private-docs:reader']] as const) {
    await setField(createForm, name, value);
  }
  await submit(createForm);
  expect(container.textContent).toContain('Private repository saved.');
  expect(container.querySelector('#new-catalog-form')?.closest('section')?.hasAttribute('hidden')).toBe(true);
  const privateRequest = server.requests.find(item => item.url === '/api/admin/repos' && item.init?.method === 'POST')!;
  const privateBody = JSON.parse(String(privateRequest.init?.body));
  expect(privateBody).toMatchObject({ visibility: 'private', slug: 'private-docs', readerRole: 'docs:private-docs:reader' });
  expect(privateBody).not.toHaveProperty('approvalRef');

  await showConfigure();
  const currentCreateForm = forms()[0];
  for (const [name, value] of [['GitHub owner', 'synthetic'], ['Repository name', 'public-docs'], ['GitHub installation ID', '62'], ['Portal route slug', 'public-docs'], ['Display title', 'Public docs']] as const) {
    await setField(currentCreateForm, name, value);
  }
  await setField(currentCreateForm, 'Repository type', 'public');
  await setField(currentCreateForm, 'Owner approval reference', 'owner-ticket-synthetic');
  await submit(currentCreateForm);
  const publicRequest = server.requests.filter(item => item.url === '/api/admin/repos' && item.init?.method === 'POST').at(-1)!;
  expect(JSON.parse(String(publicRequest.init?.body))).toMatchObject({ visibility: 'public', approvalRef: 'owner-ticket-synthetic' });
  expect(container.textContent).toContain('Public repository saved.');
});

it('uses the active documentation-folder default only for new drafts and resets to it after saving', async () => {
  const server = api();
  vi.stubGlobal('fetch', server.fetchMock);
  await render('handbook/reference');
  await showConfigure();
  const form = forms()[0]!;
  expect(field(form, 'Documentation folder').value).toBe('handbook/reference');
  for (const [name, value] of [['GitHub owner', 'synthetic'], ['Repository name', 'new-docs'], ['GitHub installation ID', '61'],
    ['Portal route slug', 'new-docs'], ['Display title', 'New docs']] as const) await setField(form, name, value);
  await submit(form);
  const created = server.requests.find(item => item.url === '/api/admin/repos' && item.init?.method === 'POST')!;
  expect(JSON.parse(String(created.init?.body))).toMatchObject({ github: { docsPath: 'handbook/reference' } });

  await showConfigure();
  expect(field(forms()[0]!, 'Documentation folder').value).toBe('handbook/reference');
});

it('keeps an existing catalog folder when the active default changes', async () => {
  const server = api([catalog({ github: { ...catalog().github, docsPath: 'existing/manual' } })]);
  vi.stubGlobal('fetch', server.fetchMock);
  await render('instance/defaults');
  await editCatalog();
  expect(field(forms()[1]!, 'Documentation folder').value).toBe('existing/manual');
});

it('keeps Configure disabled while open and places Cancel beside Save', async () => {
  const server = api();
  vi.stubGlobal('fetch', server.fetchMock);
  await render();

  const configure = container.querySelector<HTMLButtonElement>('button[aria-controls="new-catalog-form"]')!;
  expect(configure.textContent).toBe('Configure');
  expect(configure.disabled).toBe(false);
  await act(async () => configure.click());
  expect(configure.textContent).toBe('Configure');
  expect(configure.disabled).toBe(true);
  expect(configure.getAttribute('aria-expanded')).toBe('true');
  const form = container.querySelector<HTMLFormElement>('#new-catalog-form')!;
  const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const cancel = [...form.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')!;
  expect(save.parentElement).toBe(cancel.parentElement);
  await act(async () => cancel.click());
  expect(configure.disabled).toBe(false);
  expect(configure.getAttribute('aria-expanded')).toBe('false');
  expect(form.closest('section')?.hasAttribute('hidden')).toBe(true);
});

it('reports a safe fallback when catalog creation throws a non-Error value', async () => {
  const server = api();
  server.throws.create.push('network unavailable');
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  await showConfigure();
  const createForm = forms()[0];
  for (const [name, value] of [['GitHub owner', 'synthetic'], ['Repository name', 'docs'], ['GitHub installation ID', '61'], ['Portal route slug', 'synthetic-docs'], ['Display title', 'Synthetic docs']] as const) {
    await setField(createForm, name, value);
  }
  await submit(createForm);
  expect(container.querySelector('details summary')?.textContent).toContain('Repository could not be saved');
  expect(container.querySelector('#new-catalog-form')?.closest('section')?.hasAttribute('hidden')).toBe(false);
});

it('reports a server rejection when catalog creation returns a non-success response', async () => {
  const server = api();
  const approvalMessage = 'This is a publication safety check, not a GitHub App Installation ID problem.';
  server.creates.push(json({ error: { code: 'public_approval_required', message: approvalMessage } }, 409));
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  await showConfigure();
  const createForm = forms()[0];
  for (const [name, value] of [['GitHub owner', 'synthetic'], ['Repository name', 'docs'], ['GitHub installation ID', '61'],
    ['Portal route slug', 'synthetic-docs'], ['Display title', 'Synthetic docs'], ['Required reader role', 'docs:synthetic-docs:reader']] as const) {
    await setField(createForm, name, value);
  }
  await submit(createForm);
  expect(container.querySelector('details summary')?.textContent).toContain('Repository could not be saved');
  await act(async () => container.querySelector('details')?.setAttribute('open', ''));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(approvalMessage);
});

it('uses safe defaults when a settings form omits disabled fields or its revision marker', async () => {
  const server = api([catalog({ enabled: false })]);
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  await expandCatalog();
  expect(container.textContent).toContain('EnabledNo');
  await editCatalog();

  const form = forms()[1]!;
  form.querySelector('[data-etag]')?.remove();
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')) control.disabled = true;
  await submit(form);

  const update = server.requests.filter(item => item.init?.method === 'PATCH').at(-1)!;
  expect(update.init?.headers).toMatchObject({ 'if-match': '', 'x-csrf-token': 'csrf-synthetic' });
  expect(JSON.parse(String(update.init?.body))).toMatchObject({ title: '', publicDescription: '', readerRole: '', enabled: false,
    slug: 'synthetic-docs', visibility: 'private', approvalRef: '', github: { owner: '', name: '', branch: '', docsPath: '', installationId: 0 } });
});

it('shows sanitized catalog status and handles source-changing conflicts and saves', async () => {
  const initial = catalog({ status: 'failed', error: 'sync_unavailable', nextAttemptAt: '2026-10-12T01:00:00.000Z' });
  const server = api([initial]);
  server.patches.push(json({ error: { message: 'Catalog changed. Refresh and retry.' } }, 409));
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  await expandCatalog();
  expect(container.textContent).toContain('Latest issue: The latest synchronization failed. Review the repository settings and retry.');
  expect(container.querySelector('[role="alert"]')?.className).toContain('bg-red-50');
  expect(container.textContent).not.toContain('sync_unavailable');
  expect(container.textContent).toContain('Next retry:');
  expect(container.textContent).toContain('No successful sync');
  await editCatalog();
  const editForm = forms()[1];
  await setField(editForm, 'GitHub owner', 'changed-owner');
  await setField(editForm, 'Display title', 'Renamed docs');
  await submit(editForm);
  expect(container.querySelector('details summary')?.textContent).toContain('Repository could not be saved');
  const formError = [...container.querySelectorAll('details')].find(item => item.querySelector('[role="alert"]')?.textContent === 'Catalog changed. Refresh and retry.');
  expect(formError).toBeDefined();
  await submit(forms()[1]);
  expect(container.textContent).toContain('Catalog settings saved.');
  expect(container.querySelector('article h3')?.textContent).toBe('Renamed docs');
  const patch = server.requests.filter(item => item.init?.method === 'PATCH').at(-1)!;
  expect(patch.init?.headers).toMatchObject({ 'if-match': '"2026-10-12T00:00:00.000Z"', 'x-csrf-token': 'csrf-synthetic' });
  expect(JSON.parse(String(patch.init?.body))).toMatchObject({ title: 'Renamed docs', github: { owner: 'changed-owner' } });

  for (const [name, value] of [['Repository name', 'renamed-docs'], ['Branch', 'release/docs'], ['Documentation folder', 'manual'], ['GitHub installation ID', '62']] as const) {
    await editCatalog('Renamed docs');
    await setField(forms()[1]!, name, value);
    await submit(forms()[1]!);
    const update = server.requests.filter(item => item.init?.method === 'PATCH').at(-1)!;
    expect(JSON.parse(String(update.init?.body)).github, name).toBeDefined();
  }
});

it('renders the canonical saved catalog immediately without waiting for a second list request', async () => {
  const initial = catalog();
  const updated = catalog({ title: 'Updated catalog title', revision: 3, updatedAt: '2026-10-12T00:00:01.000Z' });
  const other = catalog({ id: 'catalog-2', title: 'Other docs' });
  let listRequests = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/admin/csrf') return json({ csrfToken: 'csrf-synthetic' });
    if (url === '/api/admin/repos' && !init?.method) { listRequests += 1; return json({ catalogs: [initial, other] }); }
    if (url === '/api/admin/repos/catalog-1' && init?.method === 'PATCH') return json({ catalog: updated, revision: updated.revision });
    return json({ error: { message: 'Not found.' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  await render();
  await editCatalog();
  await setField(forms()[1]!, 'Display title', updated.title);
  await submit(forms()[1]!);

  expect([...container.querySelectorAll('article h3')].map(item => item.textContent)).toEqual(['Other docs', 'Updated catalog title']);
  expect(container.querySelector('#catalog-settings-catalog-1')?.hasAttribute('hidden')).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Catalog settings saved.');
  expect(listRequests).toBe(1);
});

it('starts configured repositories collapsed and expands an accessible editor with private and public types', async () => {
  const commit = 'a'.repeat(40);
  const server = api([catalog({ publishedCommit: commit, lastSuccessAt: '2026-10-12T00:30:00.000Z', status: 'succeeded' })]);
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  const view = container.querySelector<HTMLButtonElement>('button[aria-label="View Synthetic docs details"]')!;
  expect(view.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('input[name="owner"]')).toBeNull();
  expect((field(forms()[0]!, 'Repository type') as HTMLSelectElement).options).toHaveLength(2);
  const article = container.querySelector('article')!;
  const refreshButton = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh status"]')!;
  expect(refreshButton.type).toBe('button');
  const summary = container.querySelector<HTMLElement>('#catalog-summary-catalog-1')!;
  expect(summary.textContent).toContain('Repository typePrivate');
  expect(summary.textContent).toContain('EnabledYes');
  expect(summary.textContent).toContain('Last successful sync');
  const summaryCommit = summary.querySelector<HTMLElement>(`[aria-label="Published commit ${commit}"]`)!;
  expect(summaryCommit.textContent).toBe('aaaaaaa…');
  expect(summaryCommit.title).toBe(commit);
  expect(container.querySelector('#catalog-details-catalog-1')?.hasAttribute('hidden')).toBe(true);
  const actionButtons = ['View Synthetic docs details', 'Sync Synthetic docs'].map(label =>
    article.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!);
  expect(actionButtons.every(button => button.type === 'button')).toBe(true);
  const status = article.querySelector<HTMLElement>('[aria-label="Sync status: succeeded"]')!;
  expect(status.parentElement?.parentElement).toBe(article);

  await expandCatalog();
  expect(container.querySelector('button[aria-label="Edit Synthetic docs"]')).not.toBeNull();
  expect(container.querySelector('#catalog-details-catalog-1')?.hasAttribute('hidden')).toBe(false);
  expect(container.querySelector('#catalog-details-catalog-1')?.textContent).toContain('GitHub installation ID61');
  expect(container.querySelector('#catalog-details-catalog-1')?.textContent).not.toContain('Last successful sync');
  const deleteAction = container.querySelector<HTMLButtonElement>('button[aria-label="Delete Synthetic docs"]');
  const editAction = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Synthetic docs"]');
  expect(deleteAction).not.toBeNull();
  expect(deleteAction?.type).toBe('button');
  expect(editAction).not.toBeNull();
  await editCatalog();
  expect(container.querySelector('button[aria-label="Edit Synthetic docs"]')).toBeNull();
  expect(container.querySelector('#catalog-settings-catalog-1')?.hasAttribute('hidden')).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Hide Synthetic docs details"]')?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Delete Synthetic docs"]')?.disabled).toBe(true);
  expect(container.textContent).not.toContain('Cancel edit');
  expect(forms()[1]?.querySelector('button[type="submit"]')?.textContent).toContain('Save');
  expect([...forms()[1]!.querySelectorAll('button')].find(button => button.textContent?.includes('Cancel'))).toBeDefined();
  const type = field(forms()[1]!, 'Repository type') as HTMLSelectElement;
  expect([...type.options].map(option => option.textContent)).toEqual(['Private', 'Public']);
  expect((field(forms()[1]!, 'GitHub owner') as HTMLInputElement).disabled).toBe(false);
  expect(field(forms()[1]!, 'Directory description')).toBeInstanceOf(HTMLTextAreaElement);
  const cancelEdit = [...forms()[1]!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Cancel'))!;
  await act(async () => cancelEdit.click());
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Hide Synthetic docs details"]')!.click());
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="View Synthetic docs details"]')?.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('#catalog-details-catalog-1')?.hasAttribute('hidden')).toBe(true);
});

it('confirms repository deletion, sends the optimistic version, and reports a busy catalog safely', async () => {
  const server = api([catalog()]);
  vi.stubGlobal('fetch', server.fetchMock);
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  vi.stubGlobal('confirm', confirm);
  await render();
  await expandCatalog();
  const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="Delete Synthetic docs"]')!;
  await act(async () => { deleteButton.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(server.requests.some(item => item.init?.method === 'DELETE')).toBe(false);
  expect(container.querySelector('article')?.textContent).toContain('Synthetic docs');
  await act(async () => { deleteButton.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const deletion = server.requests.find(item => item.init?.method === 'DELETE')!;
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Synthetic docs'));
  expect(deletion.init?.headers).toMatchObject({ 'if-match': '"2026-10-12T00:00:00.000Z"', 'x-csrf-token': 'csrf-synthetic' });
  expect(container.textContent).toContain('Repository removed.');
  for (let attempt = 0; attempt < 10 && container.textContent.includes('Synthetic docs'); attempt += 1) {
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  }
  expect(container.textContent).toContain('No repositories are configured.');

  await act(async () => root.unmount());
  root = createRoot(container);
  const blocked = api([catalog()]);
  blocked.deletes.push(json({ error: { message: 'A synchronization or reader request is active.' } }, 409));
  vi.stubGlobal('fetch', blocked.fetchMock);
  vi.stubGlobal('confirm', vi.fn(() => true));
  await render();
  await expandCatalog();
  const blockedDeleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="Delete Synthetic docs"]')!;
  await act(async () => { blockedDeleteButton.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('A synchronization or reader request is active.');
  expect(container.querySelector('article')?.textContent).toContain('Synthetic docs');
});

it('keeps a repository when deletion encounters a non-Error transport failure', async () => {
  const server = api([catalog()]);
  server.throws.delete.push('synthetic transport failure');
  vi.stubGlobal('fetch', server.fetchMock);
  vi.stubGlobal('confirm', vi.fn(() => true));
  await render();
  await expandCatalog();

  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Delete Synthetic docs"]')!.click(); await Promise.resolve(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The repository could not be removed.');
  expect(container.querySelector('article')?.textContent).toContain('Synthetic docs');
});

it('provides shared navigation, theme control, and readable color-coded sync states', async () => {
  const statuses = ['pending', 'running', 'succeeded', 'failed'] as const;
  const expectedColors = ['text-amber-800', 'text-green-800', 'text-primary', 'text-red-800'];
  const server = api(statuses.map(status => catalog({ id: `catalog-${status}`, status,
    error: status === 'failed' ? 'github_invalid_content' : null })));
  vi.stubGlobal('fetch', server.fetchMock);
  await render();

  expect(container.querySelector('nav[aria-label="Primary navigation"] a[href="/"]')?.textContent).toBe('Perspective V / Docs');
  expect(container.querySelector('nav a[href="/repositories"]')?.textContent).toBe('Repositories');
  expect(container.querySelector('button[aria-label="Toggle Theme"]')).not.toBeNull();
  expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Sign out')).toBe(true);
  for (const [index, status] of statuses.entries()) {
    const badge = container.querySelector(`[aria-label="Sync status: ${status}"]`);
    expect(badge?.className).toContain(expectedColors[index]);
    expect(badge?.textContent).toBe(status);
  }
  expect(container.textContent).toContain('Safe static Fumadocs MDX components are supported');
  expect(container.textContent).not.toContain('github_invalid_content');
});

it('explains why synchronization is disabled', async () => {
  const server = api([catalog({ enabled: false, accessState: 'blocked' })]);
  vi.stubGlobal('fetch', server.fetchMock);
  await render();

  await editCatalog();
  expect(container.textContent).toContain('Sync requires this repository to be enabled and GitHub App access to be ready.');
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Sync Synthetic docs"]')?.disabled).toBe(true);
});

it('saves metadata without resubmitting an unchanged source and handles synchronization errors', async () => {
  const initial = catalog({ visibility: 'public', approvalRef: 'owner-review-synthetic', status: 'succeeded',
    publishedCommit: 'a'.repeat(40), lastSuccessAt: '2026-10-12T00:30:00.000Z' });
  const server = api([initial]);
  server.syncs.push(json({ status: 'pending' }, 202), json({ error: { message: 'Sync queue unavailable.' } }, 503));
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  await expandCatalog();
  expect(container.textContent).toContain('Repository typePublic');
  expect(container.textContent).toContain('Published commit');
  const shortCommit = container.querySelector<HTMLElement>('[aria-label="Published commit ' + 'a'.repeat(40) + '"]')!;
  expect(shortCommit.textContent).toBe('aaaaaaa…');
  expect(shortCommit.title).toBe('a'.repeat(40));
  expect(container.querySelector('#catalog-summary-catalog-1')?.textContent).toContain('Last successful sync');
  expect(container.textContent).not.toContain('Latest issue:');
  expect(container.textContent).not.toContain('Next retry:');
  await editCatalog();
  const editForm = forms()[1];
  await setField(editForm, 'Display title', 'Updated metadata');
  await submit(editForm);
  await editCatalog('Updated metadata');
  const patch = server.requests.filter(item => item.init?.method === 'PATCH').at(-1)!;
  expect(JSON.parse(String(patch.init?.body))).not.toHaveProperty('github');
  await setField(forms()[1]!, 'Repository type', 'private');
  await submit(forms()[1]!);
  const privatePatch = server.requests.filter(item => item.init?.method === 'PATCH').at(-1)!;
  expect(JSON.parse(String(privatePatch.init?.body))).toMatchObject({ visibility: 'private', approvalRef: null, enabled: true });
  const clickSync = async () => {
    let button: HTMLButtonElement | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
      button = container.querySelector<HTMLButtonElement>('article button[aria-label^="Sync "]') ?? undefined;
      if (button && !button.disabled) break;
    }
    if (!button || button.disabled) throw new Error('Sync button is unavailable.');
    await act(async () => {
      button!.click();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  };
  await clickSync();
  expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe('Synchronization request was durably accepted.');
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  await clickSync();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Sync queue unavailable.');
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  server.throws.sync.push('transport failure');
  await clickSync();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Synchronization could not be queued.');
  await editCatalog('Updated metadata');
  const enabled = field(forms()[1]!, 'Enabled') as HTMLInputElement;
  await act(async () => { enabled.checked = false; enabled.dispatchEvent(new Event('input', { bubbles: true })); });
  await submit(forms()[1]!);
  const disabledPatch = server.requests.filter(item => item.init?.method === 'PATCH').at(-1)!;
  expect(JSON.parse(String(disabledPatch.init?.body))).toMatchObject({ enabled: false });
  const sync = server.requests.find(item => item.url.endsWith('/sync'))!;
  expect(sync.init?.headers).toMatchObject({ 'x-csrf-token': 'csrf-synthetic' });
  expect(String((sync.init?.headers as Record<string, string>)['idempotency-key'])).toMatch(/^[0-9a-f-]{36}$/i);
});

it('shows sync failures without a manual refresh and dismisses the acceptance banner after ten seconds', async () => {
  const initial = catalog({ status: 'succeeded' });
  const queued = catalog({ status: 'pending' });
  const failed = catalog({ status: 'failed', error: 'github_invalid_content' });
  const server = api([initial]);
  server.listResponses.push([initial], [queued], [failed]);
  server.syncs.push(json({ status: 'pending' }, 202));
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  vi.useFakeTimers();

  const syncButton = container.querySelector<HTMLButtonElement>('button[aria-label="Sync Synthetic docs"]')!;
  await act(async () => {
    syncButton.click();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe('Synchronization request was durably accepted.');
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Synchronization queued for Synthetic docs"]')?.disabled).toBe(true);

  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Safe static Fumadocs MDX components are supported');
  expect(container.querySelector('[role="alert"]')?.className).toContain('bg-red-50');
  expect(container.querySelector('[aria-label="Sync status: failed"]')?.textContent).toBe('failed');
  expect(server.requests.filter(item => item.url === '/api/admin/repos' && !item.init?.method)).toHaveLength(3);

  await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
  expect(container.querySelector('[role="status"][aria-live="polite"]')).toBeNull();
  vi.useRealTimers();
});

it('tracks manual sync through running, scheduled retry, transport error, and terminal failure', async () => {
  const initial = catalog({ status: 'succeeded' });
  const server = api([initial, catalog({ id: 'catalog-2', title: 'Other docs' })]);
  const fetchOriginal = server.fetchMock.getMockImplementation()!;
  let statusReads = 0;
  server.fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/admin/repos' && !init?.method) {
      statusReads += 1;
      if (statusReads === 5) return json({ error: { message: 'Status feed unavailable.' } }, 503);
      if (statusReads === 6) throw 'synthetic transport failure';
    }
    return fetchOriginal(input, init);
  });
  server.syncs.push(json({ status: 'pending' }, 202), json({ status: 'succeeded' }, 202));
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  vi.useFakeTimers();

  const queued = catalog({ status: 'pending' });
  const retry = catalog({ status: 'running', nextAttemptAt: new Date(Date.now() + 10_000).toISOString() });
  const running = catalog({ status: 'running' });
  const failed = catalog({ status: 'failed', error: 'github_invalid_content' });
  server.listResponses.push([queued], [retry], [running], [failed]);
  const syncButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Sync Synthetic docs"]')!;

  await act(async () => { syncButton().click(); await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(container.querySelector('button[aria-label="Synchronization in progress for Synthetic docs"]')).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(7_250); });
  expect(container.querySelector('button[aria-label="Synchronization in progress for Synthetic docs"]')).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Status feed unavailable.');
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Synchronization status could not be refreshed.');
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(container.querySelector('[aria-label="Sync status: failed"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Safe static Fumadocs MDX components are supported');

  await act(async () => {
    syncButton().click();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
  for (let attempt = 0; attempt < 3 && !container.textContent?.includes('Other docs'); attempt += 1) {
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
  }
  expect(container.querySelector('[aria-label="Sync status: succeeded"]')).not.toBeNull();
  expect(container.textContent).toContain('Other docs');
  vi.useRealTimers();
});

it('stops polling when its bounded synchronization deadline expires', async () => {
  const server = api([catalog({ status: 'running' })]);
  vi.stubGlobal('fetch', server.fetchMock);
  vi.useFakeTimers();
  await act(async () => { root.render(<AdminConsole />); await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const statusReadCount = () => server.requests.filter(item => item.url === '/api/admin/repos' && !item.init?.method).length;
  const readsBeforeExpiry = statusReadCount();
  expect(readsBeforeExpiry).toBeGreaterThanOrEqual(1);
  const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1_000);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(statusReadCount()).toBe(readsBeforeExpiry);
  expect(container.querySelector('button[aria-label="Synchronization in progress for Synthetic docs"]')).not.toBeNull();
  dateNow.mockRestore();
  vi.useRealTimers();
});
