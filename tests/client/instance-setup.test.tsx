import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InstanceSetup } from '../../components/instance-setup';

const identity = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn() }));
vi.mock('next-auth/react', () => ({ signIn: identity.signIn }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: identity.replace }) }));

const checkTypes = ['database', 'zitadel_discovery', 'github_structure', 'github_authentication', 'github_permissions', 'github_installation', 'github_webhook'];
const testLocation = window.location.href;
function snapshot(ownerVerified = false, candidateVersion = 1) {
  return {
    state: 'configuring', expiresAt: '2099-01-01T00:00:00.000Z', editRevision: 1, candidateVersion,
    candidate: {
      version: candidateVersion, preferences: { displayName: 'Synthetic Portal', description: '', docsFolder: 'docs' },
      publicOrigin: 'https://portal.example.test',
      zitadel: { issuer: 'https://identity.example.test', clientId: 'client', projectId: 'project', audience: 'audience' },
      github: { appId: '123' }, checks: [] as { type: string; candidateVersion: number; status: string; code: string }[], ownerVerified,
      impact: { confirmationNonce: 'synthetic-confirmation' } as { confirmationNonce: string } | null,
      secrets: { zitadelClientSecret: { configured: true, updatedAt: null } },
    },
    runtimeCallbackUrl: 'https://portal.example.test/api/auth/callback/zitadel',
    candidateCallbackUrl: 'https://portal.example.test/api/instance/auth/callback/zitadel',
    webhookUrl: 'https://portal.example.test/api/webhooks/github',
  };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

let container: HTMLDivElement;
let root: Root;
let cookies: string;
let current: ReturnType<typeof snapshot>;
let authorized: boolean;
let requests: { url: string; init?: RequestInit }[];
let overrides: Map<string, unknown[]>;

function override(method: string, path: string, ...values: unknown[]) { overrides.set(`${method} /api/instance/${path}`, values); }
function button(label: string, navigation = false) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent?.trim() === label && Boolean(item.closest('nav')) === navigation);
  if (!result) throw new Error(`Missing wizard action: ${label}`);
  return result;
}
async function settle() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise(resolve => setTimeout(resolve, 0));
  });
}
async function click(label: string, navigation = false) { await act(async () => button(label, navigation).click()); await settle(); }
async function input(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
    ?? container.querySelector<HTMLInputElement>('#bootstrap-credential');
  if (!field) throw new Error(`Missing wizard field: ${label}`);
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function render() { await act(async () => root.render(<InstanceSetup />)); await settle(); }
function error() { return container.querySelector('[role="alert"]'); }
function patches() { return requests.filter(item => item.init?.method === 'PATCH'); }
function readyChecks() {
  current.candidate.checks = checkTypes.map(type => ({ type, candidateVersion: current.candidateVersion,
    status: type === 'github_installation' || type === 'github_webhook' ? 'warning' : 'passed',
    code: type === 'github_installation' ? 'installation_missing' : type === 'github_webhook' ? 'delivery_unverified' : 'provider_ok' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState({}, '', testLocation);
  cookies = '';
  vi.spyOn(document, 'cookie', 'get').mockImplementation(() => cookies);
  current = snapshot(); authorized = true; requests = []; overrides = new Map();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const key = `${init?.method ?? 'GET'} ${url}`;
    const queue = overrides.get(key);
    if (queue?.length) {
      const value = queue.shift();
      if (value instanceof Response || value instanceof Promise) return value;
      throw value;
    }
    if (url === '/api/instance/status') { cookies = '__Host-librarian_pre_csrf=synthetic-pre-csrf'; return json({ state: 'setup_required' }); }
    if (url === '/api/instance/setup/authorize') { authorized = true; return json({ csrfToken: 'synthetic-csrf' }); }
    if (url === '/api/instance/setup/check') {
      const { type } = JSON.parse(String(init?.body));
      const check = { type, candidateVersion: current.candidateVersion, status: type === 'github_installation' || type === 'github_webhook' ? 'warning' : 'passed',
        code: type === 'github_installation' ? 'installation_missing' : type === 'github_webhook' ? 'delivery_unverified' : 'provider_ok' };
      current.editRevision++;
      current.candidate.checks = [...current.candidate.checks.filter(item => item.type !== type), check];
      return json(check);
    }
    if (url === '/api/instance/setup/finalize') return json({ state: 'ready' });
    if (url === '/api/instance/setup') {
      if (!authorized) return json({ error: { message: 'Setup authorization required.' } }, 401);
      if (init?.method === 'PATCH') {
        const { changes } = JSON.parse(String(init.body));
        Object.assign(current.candidate.zitadel, changes.zitadel, changes.zitadel?.apiAudience ? { audience: changes.zitadel.apiAudience } : {});
        Object.assign(current.candidate.github, changes.github);
        Object.assign(current.candidate.preferences, Object.fromEntries(Object.entries(changes).filter(([key]) => ['displayName', 'description'].includes(key))),
          changes.defaultDocsFolder ? { docsFolder: changes.defaultDocsFolder } : {});
        current.editRevision++; current.candidateVersion = Math.max(1, current.candidateVersion); current.candidate.version = current.candidateVersion;
      }
      return json(current);
    }
    throw new Error('Unexpected wizard request');
  }));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', testLocation);
});

it('saves only changed provider/preferences values, uses revisions and clears submitted secrets', async () => {
  cookies = '__Host-librarian_setup_csrf=synthetic-cookie-csrf';
  await render(); await click('Continue');
  expect(container.querySelector('h2')?.textContent).toBe('Database');
  await click('Continue');
  await input('Zitadel issuer', 'https://new-identity.example.test'); await input('Client ID', 'new-client');
  await input('Project ID', 'new-project'); await input('API audience', 'new-audience'); await input('Client secret', 'SYNTHETIC_CLIENT_SECRET');
  await click('Continue');
  expect(JSON.parse(String(patches()[0].init?.body))).toEqual({ candidateVersion: 1, changes: { zitadel: {
    issuer: 'https://new-identity.example.test', clientId: 'new-client', projectId: 'new-project', apiAudience: 'new-audience' } },
    secretReplacements: { zitadelClientSecret: { action: 'replace', value: 'SYNTHETIC_CLIENT_SECRET' } } });
  expect(patches()[0].init?.headers).toMatchObject({ 'if-match': '"1"', 'x-csrf-token': 'synthetic-cookie-csrf' });
  await input('GitHub App ID', '456'); await input('GitHub private key', 'SYNTHETIC_PRIVATE_KEY'); await input('Webhook secret', 'SYNTHETIC_WEBHOOK_SECRET');
  await click('Continue');
  expect(JSON.parse(String(patches()[1].init?.body))).toMatchObject({ changes: { github: { appId: '456' } }, secretReplacements: {
    githubPrivateKey: { action: 'replace', value: 'SYNTHETIC_PRIVATE_KEY' }, githubWebhookSecret: { action: 'replace', value: 'SYNTHETIC_WEBHOOK_SECRET' } } });
  await input('Display name', 'New portal'); await input('Description', 'Synthetic description'); await input('Default docs folder', 'guides');
  expect(container.textContent).toContain(current.runtimeCallbackUrl); expect(container.textContent).toContain(current.webhookUrl);
  await click('Continue'); expect(button('Review').disabled).toBe(true);
  await click('Back'); await click('Continue'); expect(patches()).toHaveLength(3);
  await click('Zitadel', true); expect(container.querySelector<HTMLInputElement>('[aria-label="Client secret"]')?.value).toBe('');
  await click('Continue'); await click('Continue'); expect(patches()).toHaveLength(3);
  await click('Review', true); expect(button('Complete setup').disabled).toBe(true);
  await click('Review'); expect(error()?.textContent).toContain('Verify the instance owner'); expect(document.activeElement).toBe(error());
  await click('Welcome', true); expect(error()).toBeNull();
  expect(container.innerHTML).not.toContain('SYNTHETIC_PRIVATE_KEY'); expect(container.innerHTML).not.toContain('SYNTHETIC_WEBHOOK_SECRET');
});

it('authorizes after obtaining pre-session CSRF and keeps bootstrap material out of the rendered result', async () => {
  authorized = false; await render(); await input('Bootstrap credential', 'SYNTHETIC_BOOTSTRAP'); await click('Authorize setup');
  expect(requests.find(item => item.url.endsWith('/authorize'))?.init?.headers).toMatchObject({ 'x-csrf-token': 'synthetic-pre-csrf' });
  expect(container.querySelector('#bootstrap-credential')).toBeNull(); expect(container.innerHTML).not.toContain('SYNTHETIC_BOOTSTRAP');
  expect(container.textContent).toContain('Setup authorized.');
});

it.each([
  ['status denied', () => override('GET', 'status', json({ state: 'ready' }, 503)), 'Setup status could not be loaded.'],
  ['status already ready', () => override('GET', 'status', json({ state: 'ready' })), 'Setup status could not be loaded.'],
  ['missing pre-session cookie', () => override('GET', 'status', json({ state: 'setup_required' })), 'request could not be verified'],
  ['rejected authority', () => override('POST', 'setup/authorize', json({ error: { message: 'Setup denied.' } }, 401)), 'Setup denied.'],
  ['malformed authority response', () => override('POST', 'setup/authorize', new Response('invalid')), 'request could not be completed'],
  ['missing session CSRF', () => override('POST', 'setup/authorize', json({})), 'request could not be completed'],
  ['network failure', () => override('POST', 'setup/authorize', new Error('Network unavailable.')), 'Network unavailable.'],
  ['non-error failure', () => override('POST', 'setup/authorize', 'failed'), 'Setup authorization failed.'],
] as const)('clears the bootstrap input and focuses an accessible error for %s', async (_name, setup, message) => {
  authorized = false; await render(); setup();
  if (!_name.startsWith('status') && _name !== 'missing pre-session cookie') cookies = '__Host-librarian_pre_csrf=existing';
  await input('Bootstrap credential', 'SYNTHETIC_REJECTED_BOOTSTRAP'); await click('Authorize setup');
  expect(error()?.textContent).toContain(message); expect(document.activeElement).toBe(error());
  expect(container.querySelector<HTMLInputElement>('#bootstrap-credential')?.value).toBe('');
});

it.each([
  ['server denial', json({ error: { message: 'Host maintenance.' } }, 503), 'Host maintenance.'],
  ['malformed response', new Response('invalid'), 'request could not be completed'],
  ['network failure', new Error('network'), 'Setup status could not be loaded.'],
] as const)('renders a safe initial error for %s', async (_name, response, message) => {
  override('GET', 'setup', response); await render(); expect(error()?.textContent).toContain(message);
});

it('ignores a status response arriving after the wizard is unmounted', async () => {
  let resolve!: (value: Response) => void;
  override('GET', 'setup', new Promise<Response>(done => { resolve = done; }));
  await render(); await act(async () => root.unmount()); await act(async () => resolve(json(current)));
  expect(container.childElementCount).toBe(0);
});

it.each([
  ['revision conflict', json({ error: { message: 'Reload the changed draft.' } }, 409), 'Reload the changed draft.'],
  ['invalid JSON', new Response('invalid'), 'request could not be completed'],
  ['network error', new Error('Storage unavailable.'), 'Storage unavailable.'],
  ['non-error rejection', 'failed', 'setup draft could not be saved'],
] as const)('keeps the current editing step and focuses the error after %s', async (_name, response, message) => {
  await render(); await click('Preferences', true); await input('Display name', 'Changed portal');
  override('PATCH', 'setup', response); await click('Continue');
  expect(container.querySelector('legend')?.textContent).toBe('Preferences'); expect(error()?.textContent).toContain(message);
  expect(document.activeElement).toBe(error());
});

it('creates the durable empty draft before retrying the host-only database connection', async () => {
  current = snapshot(false, 0); await render(); await click('Database', true); await click('Retry connection');
  expect(JSON.parse(String(patches()[0].init?.body))).toEqual({ candidateVersion: 0, changes: { description: '' } });
  expect(container.textContent).toContain('Database connection passed.');
  expect(requests.find(item => item.url.endsWith('/check'))?.init?.headers).toMatchObject({ 'if-match': '"2"' });
});

it('shows a recoverable error if the newly saved database draft cannot be reloaded', async () => {
  current = snapshot(false, 0); await render(); await click('Database', true);
  override('GET', 'setup', json({ error: { message: 'Draft reload unavailable.' } }, 503));
  await click('Retry connection');
  expect(error()?.textContent).toContain('Draft reload unavailable.');
  expect(button('Retry connection').disabled).toBe(false);
  expect(requests.filter(item => item.url.endsWith('/check'))).toHaveLength(0);
});

it('does not run a database check when creating the initial draft is rejected', async () => {
  current = snapshot(false, 0); await render(); await click('Database', true);
  override('PATCH', 'setup', json({ error: { message: 'Draft conflict.' } }, 409)); await click('Retry connection');
  expect(error()?.textContent).toContain('Draft conflict.');
  expect(requests.filter(item => item.url.endsWith('/check'))).toHaveLength(0);
});

it.each([
  ['failed check', json({ type: 'database', candidateVersion: 1, status: 'failed', code: 'storage_unavailable' }), 'Database connection needs attention.'],
  ['server error', json({ error: { message: 'Database offline.' } }, 503), 'Database offline.'],
  ['network error', new Error('Database request failed.'), 'Database request failed.'],
  ['non-error rejection', 'failed', 'Database connection check failed.'],
] as const)('reports %s without pretending the database is ready', async (_name, response, message) => {
  await render(); await click('Database', true); override('POST', 'setup/check', response); await click('Retry connection');
  expect(container.textContent).toContain(message);
});

it.each([undefined, { ok: false }, { ok: true }, { ok: true, url: 'https://wrong.example.test/authorize' }, new Error('Provider unavailable.'), 'failed'])
  ('does not navigate to an unverified candidate login result %#', async result => {
    const location = new URL(testLocation); location.searchParams.set('step', 'owner'); window.history.replaceState({}, '', location);
    identity.signIn.mockImplementation(async () => { if (result instanceof Error || typeof result === 'string') throw result; return result; });
    await render(); await click('Verify owner / Sign in with Zitadel');
    expect(identity.signIn).toHaveBeenCalledWith('zitadel', { redirect: false, redirectTo: '/instance/setup?step=owner' });
    expect(error()).not.toBeNull(); expect(new URL(window.location.href).searchParams.get('step')).toBe('owner');
  });

it('checks every current provider revision, accepts only documented warnings and avoids duplicate checks', async () => {
  current = snapshot(true); await render(); await click('Review');
  const checks = requests.filter(item => item.url.endsWith('/check'));
  expect(checks.map(item => JSON.parse(String(item.init?.body)).type)).toEqual(checkTypes);
  expect(checks.map(item => (item.init?.headers as Record<string, string>)['if-match'])).toEqual(['"1"', '"2"', '"3"', '"4"', '"5"', '"6"', '"7"']);
  expect(container.textContent).toContain('Warnings:'); expect(button('Complete setup').disabled).toBe(false);
  await click('Review'); expect(requests.filter(item => item.url.endsWith('/check'))).toHaveLength(7);
  await click('Complete setup'); expect(identity.replace).toHaveBeenCalledWith('/instance/setup');
  expect(JSON.parse(String(requests.find(item => item.url.endsWith('/finalize'))?.init?.body))).toEqual({ candidateVersion: 1, confirmationNonce: 'synthetic-confirmation', confirm: true });
});

it.each([
  ['check rejection', json({ error: { message: 'Provider failed.' } }, 400), 'Provider failed.'],
  ['invalid check response', new Response('invalid'), 'request could not be completed'],
  ['unknown failure', 'failed', 'provider check could not be completed'],
] as const)('stops review after %s', async (_name, response, message) => {
  current = snapshot(true); await render(); override('POST', 'setup/check', response); await click('Review');
  expect(error()?.textContent).toContain(message); expect(button('Complete setup').disabled).toBe(true);
  expect(requests.filter(item => item.url.endsWith('/check'))).toHaveLength(1);
});

it.each(['stale', 'github_installation', 'github_webhook'])('does not accept %s check evidence', async invalid => {
  current = snapshot(true); readyChecks();
  if (invalid === 'stale') current.candidate.checks[0].candidateVersion = 0;
  else current.candidate.checks.find(item => item.type === invalid)!.code = 'unknown_warning';
  await render(); expect(button('Complete setup').disabled).toBe(true);
});

it('keeps completion disabled without a current confirmation nonce', async () => {
  current = snapshot(true); readyChecks(); current.candidate.impact = null;
  await render(); expect(button('Complete setup').disabled).toBe(true);
});

it.each([
  ['conflict', json({ error: { message: 'Candidate changed.' } }, 409), 'Candidate changed.'],
  ['malformed failure', new Response('invalid', { status: 500 }), 'request could not be completed'],
  ['unknown failure', 'failed', 'Setup could not be completed.'],
] as const)('keeps finalization open for recovery after %s', async (_name, response, message) => {
  current = snapshot(true); readyChecks(); await render(); override('POST', 'setup/finalize', response); await click('Complete setup');
  expect(error()?.textContent).toContain(message); expect(identity.replace).not.toHaveBeenCalled(); expect(button('Complete setup').disabled).toBe(false);
});

it('waits for adoption after a pending finalization without submitting a second finalize', async () => {
  current = snapshot(true); readyChecks(); await render(); vi.useFakeTimers();
  override('POST', 'setup/finalize', json({ state: 'pending' }, 202));
  override('GET', 'status', json({ state: 'maintenance' }), json({ state: 'ready' }));
  await click('Complete setup'); expect(identity.replace).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(identity.replace).toHaveBeenCalledWith('/instance/setup');
  expect(requests.filter(item => item.url.endsWith('/finalize'))).toHaveLength(1);
});

it('bounds pending-adoption polling and reloads the guarded setup route after the deadline', async () => {
  current = snapshot(true); readyChecks(); await render(); vi.useFakeTimers();
  override('POST', 'setup/finalize', json({ state: 'pending' }, 202));
  override('GET', 'status', ...Array.from({ length: 20 }, () => Promise.resolve({
    ok: true, status: 200, json: async () => ({ state: 'maintenance' }),
  } as Response)));
  await click('Complete setup'); await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(requests.filter(item => item.url.endsWith('/status'))).toHaveLength(20);
  expect(requests.filter(item => item.url.endsWith('/finalize'))).toHaveLength(1);
  expect(identity.replace).toHaveBeenCalledOnce();
});
