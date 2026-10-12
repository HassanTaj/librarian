import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminConsole } from '../../components/admin-console';

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
  const creates: Response[] = [];
  const patches: Response[] = [];
  const deletes: Response[] = [];
  const syncs: Response[] = [];
  const throws = { create: [] as unknown[], patch: [] as unknown[], delete: [] as unknown[], sync: [] as unknown[] };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === '/api/admin/csrf') return json({ csrfToken: 'csrf-synthetic' });
    if (url === '/api/admin/repos' && !init?.method) return json({ catalogs });
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
  return { fetchMock, requests, creates, patches, deletes, syncs, throws };
}

async function render() {
  await act(async () => root.render(<AdminConsole />));
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
}

function forms() { return [...container.querySelectorAll('form')]; }
function field(form: HTMLFormElement, name: string) {
  const label = [...form.querySelectorAll('label')].find(item => item.textContent?.startsWith(name));
  const input = label?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
  if (!input) throw new Error(`Missing test field: ${name}`);
  return input;
}

async function setField(form: HTMLFormElement, name: string, value: string) {
  const input = field(form, name);
  await act(async () => {
    const constructor = input instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
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
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')?.click());
  await submit(forms()[1]!);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The catalog could not be saved.');
});

it('creates private catalogs without a public approval reference and creates public catalogs only with one', async () => {
  const server = api();
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  expect(container.textContent).toContain('No repositories are configured.');
  const createForm = forms()[0];
  for (const [name, value] of [['GitHub owner', 'synthetic'], ['Repository name', 'private-docs'], ['GitHub installation ID', '61'], ['Portal route slug', 'private-docs'], ['Display title', 'Private docs'], ['Required reader role', 'docs:private-docs:reader']] as const) {
    await setField(createForm, name, value);
  }
  await submit(createForm);
  expect(container.textContent).toContain('Private catalog saved.');
  const privateRequest = server.requests.find(item => item.url === '/api/admin/repos' && item.init?.method === 'POST')!;
  const privateBody = JSON.parse(String(privateRequest.init?.body));
  expect(privateBody).toMatchObject({ visibility: 'private', slug: 'private-docs', readerRole: 'docs:private-docs:reader' });
  expect(privateBody).not.toHaveProperty('approvalRef');

  const currentCreateForm = forms()[0];
  for (const [name, value] of [['GitHub owner', 'synthetic'], ['Repository name', 'public-docs'], ['GitHub installation ID', '62'], ['Portal route slug', 'public-docs'], ['Display title', 'Public docs']] as const) {
    await setField(currentCreateForm, name, value);
  }
  await setField(currentCreateForm, 'Repository type', 'public');
  await setField(currentCreateForm, 'Owner approval reference', 'owner-ticket-synthetic');
  await submit(currentCreateForm);
  const publicRequest = server.requests.filter(item => item.url === '/api/admin/repos' && item.init?.method === 'POST').at(-1)!;
  expect(JSON.parse(String(publicRequest.init?.body))).toMatchObject({ visibility: 'public', approvalRef: 'owner-ticket-synthetic' });
  expect(container.textContent).toContain('Public catalog saved.');
});

it('reports a safe fallback when catalog creation throws a non-Error value', async () => {
  const server = api();
  server.throws.create.push('network unavailable');
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  const createForm = forms()[0];
  for (const [name, value] of [['GitHub owner', 'synthetic'], ['Repository name', 'docs'], ['GitHub installation ID', '61'], ['Portal route slug', 'synthetic-docs'], ['Display title', 'Synthetic docs']] as const) {
    await setField(createForm, name, value);
  }
  await submit(createForm);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The catalog could not be saved.');
});

it('reports a server rejection when catalog creation returns a non-success response', async () => {
  const server = api();
  server.creates.push(json({ error: { message: 'Repository access was rejected.' } }, 409));
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  const createForm = forms()[0];
  for (const [name, value] of [['GitHub owner', 'synthetic'], ['Repository name', 'docs'], ['GitHub installation ID', '61'],
    ['Portal route slug', 'synthetic-docs'], ['Display title', 'Synthetic docs'], ['Required reader role', 'docs:synthetic-docs:reader']] as const) {
    await setField(createForm, name, value);
  }
  await submit(createForm);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Repository access was rejected.');
});

it('uses safe defaults when a settings form omits disabled fields or its revision marker', async () => {
  const server = api([catalog({ enabled: false })]);
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  expect(container.textContent).toContain('EnabledNo');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')?.click());

  const form = forms()[1]!;
  form.querySelector('[data-etag]')?.remove();
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) control.disabled = true;
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
  expect(container.textContent).toContain('Latest issue: The latest synchronization failed. Review the repository settings and retry.');
  expect(container.textContent).not.toContain('sync_unavailable');
  expect(container.textContent).toContain('Next retry:');
  expect(container.textContent).toContain('No successful sync');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')?.click());
  const editForm = forms()[1];
  await setField(editForm, 'GitHub owner', 'changed-owner');
  await setField(editForm, 'Display title', 'Renamed docs');
  await submit(editForm);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Catalog changed. Refresh and retry.');
  await submit(forms()[1]);
  expect(container.textContent).toContain('Catalog settings saved.');
  expect(container.querySelector('article h3')?.textContent).toBe('Renamed docs');
  const patch = server.requests.filter(item => item.init?.method === 'PATCH').at(-1)!;
  expect(patch.init?.headers).toMatchObject({ 'if-match': '"2026-10-12T00:00:00.000Z"', 'x-csrf-token': 'csrf-synthetic' });
  expect(JSON.parse(String(patch.init?.body))).toMatchObject({ title: 'Renamed docs', github: { owner: 'changed-owner' } });

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')?.click());
  for (const [name, value] of [['Repository name', 'renamed-docs'], ['Branch', 'release/docs'], ['Documentation folder', 'manual'], ['GitHub installation ID', '62']] as const) {
    const editButton = container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')!;
    if (editButton.getAttribute('aria-expanded') !== 'true') await act(async () => editButton.click());
    await setField(forms()[1]!, name, value);
    await submit(forms()[1]!);
    const update = server.requests.filter(item => item.init?.method === 'PATCH').at(-1)!;
    expect(JSON.parse(String(update.init?.body)).github, name).toBeDefined();
  }
});

it('renders the canonical saved catalog immediately without waiting for a second list request', async () => {
  const initial = catalog();
  const updated = catalog({ title: 'Updated catalog title', revision: 3, updatedAt: '2026-10-12T00:00:01.000Z' });
  let listRequests = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/admin/csrf') return json({ csrfToken: 'csrf-synthetic' });
    if (url === '/api/admin/repos' && !init?.method) { listRequests += 1; return json({ catalogs: [initial] }); }
    if (url === '/api/admin/repos/catalog-1' && init?.method === 'PATCH') return json({ catalog: updated, revision: updated.revision });
    return json({ error: { message: 'Not found.' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')?.click());
  await setField(forms()[1]!, 'Display title', updated.title);
  await submit(forms()[1]!);

  expect(container.querySelector('article h3')?.textContent).toBe(updated.title);
  expect(listRequests).toBe(1);
});

it('starts configured repositories collapsed and expands an accessible editor with private and public types', async () => {
  const server = api([catalog()]);
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  const edit = container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')!;
  expect(edit.textContent).toBe('Edit');
  expect(edit.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('input[name="owner"]')).toBeNull();
  expect((field(forms()[0]!, 'Repository type') as HTMLSelectElement).options).toHaveLength(2);

  await act(async () => edit.click());
  expect(edit.getAttribute('aria-expanded')).toBe('true');
  const type = field(forms()[1]!, 'Repository type') as HTMLSelectElement;
  expect([...type.options].map(option => option.textContent)).toEqual(['Private', 'Public']);
  expect((field(forms()[1]!, 'GitHub owner') as HTMLInputElement).disabled).toBe(false);
});

it('confirms repository deletion, sends the optimistic version, and reports a busy catalog safely', async () => {
  const server = api([catalog()]);
  vi.stubGlobal('fetch', server.fetchMock);
  const confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  await render();
  const deleteButton = [...container.querySelectorAll('button')].find(button => button.textContent === 'Delete')!;
  await act(async () => { deleteButton.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const deletion = server.requests.find(item => item.init?.method === 'DELETE')!;
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Synthetic docs'));
  expect(deletion.init?.headers).toMatchObject({ 'if-match': '"2026-10-12T00:00:00.000Z"', 'x-csrf-token': 'csrf-synthetic' });
  expect(container.textContent).toContain('Repository removed.');
  expect(container.textContent).toContain('No repositories are configured.');

  await act(async () => root.unmount());
  root = createRoot(container);
  const blocked = api([catalog()]);
  blocked.deletes.push(json({ error: { message: 'A synchronization or reader request is active.' } }, 409));
  vi.stubGlobal('fetch', blocked.fetchMock);
  vi.stubGlobal('confirm', vi.fn(() => true));
  await render();
  const blockedDeleteButton = [...container.querySelectorAll('button')].find(button => button.textContent === 'Delete')!;
  await act(async () => { blockedDeleteButton.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('A synchronization or reader request is active.');
  expect(container.querySelector('article')?.textContent).toContain('Synthetic docs');
});

it('provides return-home and sign-out controls and readable color-coded sync states', async () => {
  const statuses = ['pending', 'running', 'succeeded', 'failed'] as const;
  const expectedColors = ['text-amber-800', 'text-green-800', 'text-primary', 'text-red-800'];
  const server = api(statuses.map(status => catalog({ id: `catalog-${status}`, status,
    error: status === 'failed' ? 'github_invalid_content' : null })));
  vi.stubGlobal('fetch', server.fetchMock);
  await render();

  expect(container.querySelector('a[href="/"]')?.textContent).toBe('Back to home');
  expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Sign out')).toBe(true);
  for (const [index, status] of statuses.entries()) {
    const badge = container.querySelector(`[aria-label="Sync status: ${status}"]`);
    expect(badge?.className).toContain(expectedColors[index]);
    expect(badge?.textContent).toBe(status);
  }
  expect(container.textContent).toContain('unsupported or oversized content');
  expect(container.textContent).not.toContain('github_invalid_content');
});

it('explains why synchronization is disabled', async () => {
  const server = api([catalog({ enabled: false, accessState: 'blocked' })]);
  vi.stubGlobal('fetch', server.fetchMock);
  await render();

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')?.click());
  expect(container.textContent).toContain('Sync requires this repository to be enabled and GitHub App access to be ready.');
  expect([...container.querySelectorAll('button')].find(item => item.textContent === 'Sync now')?.disabled).toBe(true);
});

it('saves metadata without resubmitting an unchanged source and handles synchronization errors', async () => {
  const initial = catalog({ visibility: 'public', approvalRef: 'owner-review-synthetic', status: 'succeeded',
    publishedCommit: 'a'.repeat(40), lastSuccessAt: '2026-10-12T00:30:00.000Z' });
  const server = api([initial]);
  server.syncs.push(json({ status: 'pending' }, 202), json({ error: { message: 'Sync queue unavailable.' } }, 503));
  vi.stubGlobal('fetch', server.fetchMock);
  await render();
  expect(container.textContent).toContain('Repository typePublic');
  expect(container.textContent).toContain('Published commit');
  expect(container.textContent).not.toContain('Latest issue:');
  expect(container.textContent).not.toContain('Next retry:');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')?.click());
  const editForm = forms()[1];
  await setField(editForm, 'Display title', 'Updated metadata');
  await submit(editForm);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')?.click());
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
      button = [...container.querySelectorAll('button')].find(item => item.textContent === 'Sync now');
      if (button && !button.disabled) break;
    }
    if (!button || button.disabled) throw new Error('Sync button is unavailable.');
    await act(async () => {
      button!.click();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  };
  await clickSync();
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Synchronization request was durably accepted.');
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  await clickSync();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Sync queue unavailable.');
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  server.throws.sync.push('transport failure');
  await clickSync();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Synchronization could not be queued.');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls="catalog-settings-catalog-1"]')?.click());
  const enabled = field(forms()[1]!, 'Enabled') as HTMLInputElement;
  await act(async () => { enabled.checked = false; enabled.dispatchEvent(new Event('input', { bubbles: true })); });
  await submit(forms()[1]!);
  const disabledPatch = server.requests.filter(item => item.init?.method === 'PATCH').at(-1)!;
  expect(JSON.parse(String(disabledPatch.init?.body))).toMatchObject({ enabled: false });
  const sync = server.requests.find(item => item.url.endsWith('/sync'))!;
  expect(sync.init?.headers).toMatchObject({ 'x-csrf-token': 'csrf-synthetic' });
  expect(String((sync.init?.headers as Record<string, string>)['idempotency-key'])).toMatch(/^[0-9a-f-]{36}$/i);
});
