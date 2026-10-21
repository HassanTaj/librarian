import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InstanceSettings } from '../../components/instance-settings';

const identity = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock('next-auth/react', () => ({ signIn: identity.signIn }));
const initial = () => ({
  state: 'ready', editRevision: 1, activeVersion: 1, candidateVersion: null as number | null, candidate: null as ReturnType<typeof bundle> | null,
  active: bundle(), csrfToken: 'synthetic-csrf', bindingKind: 'owner', previousVersion: null as number | null, rollbackNonce: 'synthetic-nonce',
  impact: null as { categories: string[]; confirmationNonce: string } | null,
  ownerProofId: null as string | null,
  runtimeCallbackUrl: 'https://portal.example.test/api/auth/callback/zitadel',
  candidateCallbackUrl: 'https://portal.example.test/api/instance/auth/callback/zitadel', webhookUrl: 'https://portal.example.test/api/webhooks/github',
});
function bundle() {
  return { version: 1, preferences: { displayName: 'Synthetic portal', description: 'Documentation', docsFolder: 'docs' },
    publicOrigin: 'https://portal.example.test', zitadel: { issuer: 'https://identity.example.test', clientId: 'client', projectId: 'project', audience: 'audience' },
    runtime: { mongodbDatabase: 'librarian', trustHost: true, workerEnabled: false, authSecretConfigured: true, oauthTokenEncryptionKeyConfigured: true, mongodbUriConfigured: true },
    github: { appId: '123', webhookUrl: 'https://portal.example.test/api/webhooks/github' }, checks: [] as { type: string; status: string; code: string }[],
    secrets: { zitadelClientSecret: { configured: true, updatedAt: null }, githubPrivateKey: { configured: true, updatedAt: null }, githubWebhookSecret: { configured: true, updatedAt: null } },
  };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let container: HTMLDivElement; let root: Root; let snapshot: ReturnType<typeof initial>;
let requests: { url: string; init?: RequestInit }[]; let saveStatus: number; let activateStatus: number; let denied: boolean; let rejectPatch: boolean; let auditPage: number; let rejectAudit: boolean;
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!;
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function render() { await act(async () => root.render(<InstanceSettings />)); await settle(); }
async function input(name: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(label: string) { await act(async () => {
  const target = button(label);
  if (target.getAttribute('role') === 'tab') target.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  else target.click();
}); await settle(); }
beforeEach(() => {
  snapshot = initial(); requests = []; saveStatus = 200; activateStatus = 202; denied = false; rejectPatch = false; auditPage = 0; rejectAudit = false;
  identity.signIn.mockReset(); identity.signIn.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (denied) return json({ error: { message: 'Instance administrator access is required.' } }, 403);
    if (init?.method === 'PATCH') {
      if (rejectPatch) return Promise.reject('synthetic network failure');
      if (saveStatus !== 200) return json({ error: { message: 'Stale revision.' } }, saveStatus);
      const submitted = JSON.parse(init.body as string);
      snapshot = { ...snapshot, editRevision: 2, candidateVersion: 2, candidate: { ...bundle(), version: 2, github: { ...bundle().github, ...submitted.changes.github }, runtime: { ...bundle().runtime, mongodbDatabase: submitted.changes.database?.mongodbDatabase ?? bundle().runtime.mongodbDatabase }, preferences: { ...bundle().preferences, displayName: 'Canonical server name' } },
        impact: { categories: ['preferences'], confirmationNonce: 'synthetic-nonce' } };
      return json(snapshot);
    }
    if (String(url).endsWith('/activate')) {
      if (activateStatus === 200) snapshot = { ...snapshot, activeVersion: 2, active: snapshot.candidate ?? snapshot.active, candidate: null, candidateVersion: null, impact: null };
      return json({ ...snapshot, status: activateStatus === 202 ? 'pending' : 'active' }, activateStatus);
    }
    if (String(url).endsWith('/check')) {
      snapshot.candidate!.checks = [{ type: 'database', status: 'passed', code: 'database_ok' }];
      return json(snapshot.candidate!.checks[0]);
    }
    if (String(url).includes('/audit')) {
      if (rejectAudit) return json({ error: { message: 'Audit unavailable.' } }, 503);
      const page = auditPage++;
      return json({ events: [{ id: `event-${page + 1}`, at: '2026-10-20T00:00:00Z', actor: 'operator', operation: 'candidate_saved', resultCode: 'accepted' }], nextCursor: page === 0 ? 'synthetic-next-cursor' : null });
    }
    return json(snapshot);
  }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('renders supported groups and configured indicators without revealing saved credentials', async () => {
  await render();
  for (const name of ['General', 'Authentication', 'GitHub Integration', 'Documentation', 'Security', 'System and audit']) expect(container.textContent).toContain(name);
  for (const element of container.querySelectorAll<HTMLInputElement>('input[type="password"]')) expect(element.value).toBe('');
  expect(container.textContent).toContain('Up to date · v1'); expect(button('Save draft').disabled).toBe(true);
  expect(button('Run database connection check').disabled).toBe(true);
});

it('cancels unsaved values without writing and consumes the canonical successful PATCH snapshot', async () => {
  await render(); await input('displayName', 'Unsaved client name');
  expect(button('Save draft').disabled).toBe(false);
  await click('Cancel');
  expect(container.querySelector<HTMLInputElement>('[name="displayName"]')!.value).toBe('Synthetic portal');
  expect(requests.filter(item => item.init?.method === 'PATCH')).toHaveLength(0);
  await input('displayName', 'Submitted name'); await click('Save draft');
  expect(container.querySelector<HTMLInputElement>('[name="displayName"]')!.value).toBe('Canonical server name');
  expect(container.textContent).toContain('Draft saved · v1');
  const saved = requests.find(item => item.init?.method === 'PATCH')!;
  expect(new Headers(saved.init?.headers).get('If-Match')).toBe('"1"');
  expect(new Headers(saved.init?.headers).get('X-CSRF-Token')).toBe('synthetic-csrf');
  expect(JSON.parse(saved.init!.body as string).secretReplacements).toEqual({});
});

it('discards an unsaved draft when refresh confirms against the same server revision', async () => {
  await render(); await input('displayName', 'Discard this draft');
  await click('Refresh');
  expect(container.querySelector<HTMLInputElement>('[name="displayName"]')!.value).toBe('Synthetic portal');
  expect(button('Save draft').disabled).toBe(true);
  expect(requests.some(item => item.url === '/api/instance/settings' && !item.init?.method)).toBe(true);
});

it('retains edits after server and network save failures with safe feedback', async () => {
  await render(); await input('displayName', 'Keep this local value'); saveStatus = 503;
  await click('Save draft');
  expect(container.querySelector<HTMLInputElement>('[name="displayName"]')!.value).toBe('Keep this local value');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Stale revision.');
  saveStatus = 200; rejectPatch = true;
  await click('Save draft');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The request failed.');
  expect(container.querySelector<HTMLInputElement>('[name="displayName"]')!.value).toBe('Keep this local value');
});

it('requires an explicit nonempty replacement and clears entered secrets after a canonical save', async () => {
  await render();
  await act(async () => container.querySelector<HTMLInputElement>('[name="replace-githubWebhookSecret"]')!.click());
  await click('Save draft');
  expect(container.textContent).toContain('Enter a nonempty value');
  expect(requests.filter(item => item.init?.method === 'PATCH')).toHaveLength(0);
  await input('githubWebhookSecret', 'SYNTHETIC_SECRET_SENTINEL'); await click('Save draft');
  const saved = requests.find(item => item.init?.method === 'PATCH')!;
  expect(JSON.parse(saved.init!.body as string).secretReplacements).toEqual({ githubWebhookSecret: { action: 'replace', value: 'SYNTHETIC_SECRET_SENTINEL' } });
  expect(container.querySelector<HTMLInputElement>('[name="githubWebhookSecret"]')!.value).toBe('');
  expect(container.innerHTML).not.toContain('SYNTHETIC_SECRET_SENTINEL');
});

it('preserves unsaved input on conflict, warns before refresh and displays pending activation truthfully', async () => {
  await render(); await input('displayName', 'Unmerged local edit'); saveStatus = 409;
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  const link = document.createElement('a'); link.href = '#another-page'; document.body.append(link);
  const navigation = new MouseEvent('click', { bubbles: true, cancelable: true });
  vi.mocked(window.confirm).mockReturnValue(false);
  link.dispatchEvent(navigation);
  expect(navigation.defaultPrevented).toBe(true); link.remove();
  await click('Save draft');
  expect(container.textContent).toContain('Refresh and review');
  expect(container.querySelector<HTMLInputElement>('[name="displayName"]')!.value).toBe('Unmerged local edit');
  vi.mocked(window.confirm).mockReturnValue(false);
  const reads = requests.length; await click('Refresh'); expect(requests).toHaveLength(reads);
  vi.mocked(window.confirm).mockReturnValue(true); saveStatus = 200; await click('Save draft');
  await click('Run database connection check'); expect(container.textContent).toContain('Database connection: passed (database_ok)');
  await click('Verify candidate owner'); expect(identity.signIn).toHaveBeenCalledWith('zitadel', { redirectTo: '/instance/settings' }, { prompt: 'login' });
  await click('Activate saved draft');
  expect(container.textContent).toContain('Activation is pending'); expect(container.textContent).toContain('Draft saved · v1');
  await click('Load audit'); expect(container.textContent).toContain('candidate_saved');
});

it('renders a safe failure instead of editable controls for denied initial reads', async () => {
  denied = true; await render(); expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Settings could not be loaded. Refresh to try again.');
});

it('paginates the opaque audit cursor and reports unavailable audit safely', async () => {
  await render(); await click('Load audit');
  expect(button('Next audit page')).toBeTruthy();
  await click('Next audit page');
  expect(requests.at(-1)?.url).toContain('cursor=synthetic-next-cursor');
  expect(requests.filter(item => item.url.includes('/api/instance/audit'))).toHaveLength(2);
  rejectAudit = true; await click('Load audit');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Audit unavailable.');
});

it('requires the exact activation confirmation and distinguishes completed activation from pending work', async () => {
  snapshot.candidateVersion = 2; snapshot.candidate = { ...bundle(), version: 2 };
  snapshot.impact = { categories: ['identity'], confirmationNonce: 'synthetic-activation-nonce' };
  await render(); vi.mocked(window.confirm).mockReturnValue(false); await click('Activate saved draft');
  expect(requests.some(item => item.url.endsWith('/activate'))).toBe(false);
  vi.mocked(window.confirm).mockReturnValue(true); activateStatus = 200; await click('Activate saved draft');
  const request = requests.find(item => item.url.endsWith('/activate'))!;
  expect(JSON.parse(String(request.init?.body))).toEqual({ candidateVersion: 2, confirmationNonce: 'synthetic-activation-nonce', confirm: true });
  expect(container.textContent).toContain('The configuration is active. Sign in again');
  expect(container.textContent).toContain('Up to date · v2');
});

it('does not allow a non-owner to prepare a rollback draft', async () => {
  snapshot.candidateVersion = 2; snapshot.candidate = { ...bundle(), version: 2 };
  snapshot.previousVersion = 1; snapshot.impact = { categories: ['preferences'], confirmationNonce: 'synthetic-impact' };
  snapshot.bindingKind = 'admin'; await render();
  expect(button('Prepare rollback').disabled).toBe(true);
  await click('Prepare rollback');
  expect(requests.some(item => item.url.endsWith('/rollback'))).toBe(false);
});

it('saves a rollback candidate only after explicit owner confirmation', async () => {
  snapshot.candidateVersion = 2; snapshot.candidate = { ...bundle(), version: 2 };
  snapshot.previousVersion = 1; snapshot.bindingKind = 'owner'; snapshot.impact = { categories: ['preferences'], confirmationNonce: 'synthetic-impact' };
  await render(); vi.mocked(window.confirm).mockReturnValue(false); await click('Prepare rollback');
  expect(requests.some(item => item.url.endsWith('/rollback'))).toBe(false);
  vi.mocked(window.confirm).mockReturnValue(true); await click('Prepare rollback');
  expect(requests.find(item => item.url.endsWith('/rollback'))?.init?.body).toBe(JSON.stringify({ previousVersion: 1, confirmationNonce: 'synthetic-nonce', confirm: true }));
  expect(container.textContent).toContain('Rollback draft saved. Verify the owner and providers before activation.');
});

it('reports failed target-owner login safely', async () => {
  snapshot.candidateVersion = 2; snapshot.candidate = { ...bundle(), version: 2 };
  snapshot.bindingKind = 'owner'; snapshot.impact = { categories: ['identity'], confirmationNonce: 'synthetic-impact' };
  await render(); identity.signIn.mockRejectedValue(new Error('Synthetic login failure.'));
  await click('Verify candidate owner');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Synthetic login failure.');
  expect(requests.some(item => item.url.endsWith('/rollback'))).toBe(false);
});

it('keeps an authorized unsaved draft visible when a confirmed refresh fails', async () => {
  await render(); await input('displayName', 'Local draft'); denied = true;
  await click('Refresh');
  expect(container.querySelector<HTMLInputElement>('[name="displayName"]')?.value).toBe('Local draft');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Instance administrator access is required.');
  expect(button('Save draft').disabled).toBe(false);
});

it('shows missing credential metadata and a verified target proof without displaying a secret value', async () => {
  snapshot.active.secrets.githubPrivateKey.configured = false; snapshot.ownerProofId = 'synthetic-verified-target-proof';
  await render();
  expect(container.textContent).toContain('synthetic-verified-target-proof'); expect(container.textContent).toContain('missing');
  for (const element of container.querySelectorAll<HTMLInputElement>('input[type="password"]')) expect(element.value).toBe('');
});

it('retains local edits and gives safe fallback feedback when error responses omit a message', async () => {
  await render(); await input('displayName', 'Retained local draft');
  vi.mocked(fetch).mockImplementation(async () => json({}, 503));
  await click('Save draft'); expect(container.querySelector('[role="alert"]')?.textContent).toBe('The request failed.');
  await click('Refresh'); expect(container.querySelector('[role="alert"]')?.textContent).toBe('Settings could not be loaded.');
  expect(container.querySelector<HTMLInputElement>('[name="displayName"]')!.value).toBe('Retained local draft');
  await click('Load audit'); expect(container.querySelector('[role="alert"]')?.textContent).toBe('Audit unavailable.');
});

it('gives safe fallback guidance for an initial error without a server message', async () => {
  vi.mocked(fetch).mockImplementation(async () => json({}, 403)); await render();
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Settings could not be loaded. Refresh to try again.');
});

it.each(['resolve', 'reject'] as const)('discards a late initial %s after navigation unmounts Settings', async outcome => {
  let resolve!: (response: Response) => void; let reject!: (error: Error) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((yes, no) => { resolve = yes; reject = no; }));
  await render(); await act(async () => root.unmount());
  if (outcome === 'resolve') resolve(json(snapshot)); else reject(new Error('Synthetic late response'));
  await settle(); expect(container.innerHTML).toBe('');
});

it('switches real sections while retaining unsaved webhook and database fields', async () => {
  await render();
  await click('GitHub');
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('GitHub');
  await input('webhookUrl', 'https://hooks.example.test/librarian/github');
  await click('Database');
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Database');
  await input('mongodbDatabase', 'librarian_new');
  await act(async () => container.querySelector<HTMLInputElement>('[name="replace-database"]')!.click());
  await input('mongodbUri', 'mongodb://synthetic-user:synthetic-password@database.example.test/librarian_new');
  await click('GitHub');
  expect(container.querySelector<HTMLInputElement>('[name="webhookUrl"]')!.value).toBe('https://hooks.example.test/librarian/github');
  await click('Save draft');
  const saved = JSON.parse(requests.find(item => item.init?.method === 'PATCH')!.init!.body as string);
  expect(saved.changes.github.webhookUrl).toBe('https://hooks.example.test/librarian/github');
  expect(saved.changes.database).toEqual({ mongodbDatabase: 'librarian_new', mongodbUri: 'mongodb://synthetic-user:synthetic-password@database.example.test/librarian_new' });
  await click('Refresh');
  expect(container.querySelector<HTMLInputElement>('[name="webhookUrl"]')!.value).toBe('https://hooks.example.test/librarian/github');
  expect(container.querySelector<HTMLInputElement>('[name="mongodbUri"]')!.value).toBe('');
  expect(container.textContent).not.toContain('synthetic-password');
});

it('submits multiline App keys only after explicit replacement and clears the field after saving', async () => {
  await render(); await click('Security');
  await act(async () => container.querySelector<HTMLInputElement>('[name="replace-githubPrivateKey"]')!.click());
  const pem = '-----BEGIN PRIVATE KEY-----\nSYNTHETIC MULTILINE VALUE\n-----END PRIVATE KEY-----';
  await input('githubPrivateKey', pem); await click('Save draft');
  const saved = JSON.parse(requests.find(item => item.init?.method === 'PATCH')!.init!.body as string);
  expect(saved.secretReplacements.githubPrivateKey).toEqual({ action: 'replace', value: pem });
  expect(container.querySelector<HTMLTextAreaElement>('[name="githubPrivateKey"]')!.value).toBe('');
});

it('allows a non-owner to save preferences without submitting disabled database fields', async () => {
  snapshot.bindingKind = 'administrator'; await render();
  await input('displayName', 'Updated preference'); await click('Save draft');
  const saved = JSON.parse(requests.find(item => item.init?.method === 'PATCH')!.init!.body as string);
  expect(saved.changes).not.toHaveProperty('database');
});

it('opens the section containing an invalid field when saving from another tab', async () => {
  await render(); await click('GitHub'); await input('webhookUrl', 'invalid-url'); await click('General');
  await click('Save draft');
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('GitHub');
  expect(requests.some(item => item.init?.method === 'PATCH')).toBe(false);
});
