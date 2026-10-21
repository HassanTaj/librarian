import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InstanceLegacyEnrollment, InstanceRecovery } from '../../components/instance-setup';

const identity = vi.hoisted(() => ({ refresh: vi.fn(), signIn: vi.fn() }));
vi.mock('next-auth/react', () => ({ signIn: identity.signIn }));
vi.mock('next/navigation', () => ({ useRouter: () => identity }));

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let container: HTMLDivElement;
let root: Root;
let requests: { url: string; init?: RequestInit }[];
let respond: (url: string, init?: RequestInit) => Promise<Response>;

async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function render(element: ReactNode) { await act(async () => root.render(element)); await settle(); }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  if (!button) throw new Error(`Missing action: ${label}`);
  await act(async () => button.click()); await settle();
}
async function enterCredential(value: string) {
  const field = container.querySelector<HTMLInputElement>('input[type="password"]');
  if (!field) throw new Error('Missing credential field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  identity.refresh.mockReset(); identity.signIn.mockReset().mockResolvedValue(undefined);
  requests = [];
  respond = async () => json({});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-librarian_pre_csrf=synthetic-pre-csrf');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init }); return respond(url, init);
  }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('reviews and confirms only the exact authorized legacy import', async () => {
  respond = async (url, init) => {
    if (url === '/api/admin/csrf') return json({ csrfToken: 'synthetic-admin-csrf' });
    if (url.endsWith('/migration/authorize')) return json({ confirmationNonce: 'synthetic-import-proof', editRevision: 7 });
    if (url.endsWith('/migration')) return json({ state: 'ready' });
    throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
  };
  await render(<InstanceLegacyEnrollment />);
  await enterCredential('SYNTHETIC_LEGACY_CREDENTIAL'); await click('Authorize enrollment');
  expect(requests[1].init).toMatchObject({ method: 'POST', headers: { 'X-CSRF-Token': 'synthetic-admin-csrf' },
    body: JSON.stringify({ credential: 'SYNTHETIC_LEGACY_CREDENTIAL' }) });
  expect(container.querySelector('input')).toBeNull();
  expect(container.innerHTML).not.toContain('SYNTHETIC_LEGACY_CREDENTIAL');
  expect(container.textContent).toContain('Confirm importing the exact reviewed legacy configuration.');
  await click('Confirm legacy import');
  expect(requests.find(item => item.url === '/api/instance/migration')?.init).toMatchObject({ method: 'POST', headers: { 'If-Match': '"7"', 'X-CSRF-Token': 'synthetic-admin-csrf' },
    body: JSON.stringify({ confirmImport: true, confirmationNonce: 'synthetic-import-proof' }) });
  expect(identity.refresh).toHaveBeenCalledOnce();
});

it.each([
  ['missing legacy administrator permission', async () => json({}, 403), 'Current administrator authorization is required.', false],
  ['rejected legacy credential', async (url: string) => url === '/api/admin/csrf' ? json({ csrfToken: 'synthetic-admin-csrf' })
    : json({ error: { message: 'Enrollment authority expired.' } }, 403), 'Enrollment authority expired.', true],
  ['non-error network rejection', async () => { throw 'offline'; }, 'Enrollment failed.', false],
] as const)('keeps legacy enrollment closed after %s', async (_name, response, message, clearsCredential) => {
  respond = response;
  await render(<InstanceLegacyEnrollment />); await enterCredential('SYNTHETIC_REJECTED_CREDENTIAL'); await click('Authorize enrollment');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
  expect(container.textContent).not.toContain('Confirm importing the exact reviewed legacy configuration.');
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(clearsCredential ? '' : 'SYNTHETIC_REJECTED_CREDENTIAL');
  expect(identity.refresh).not.toHaveBeenCalled();
});

it('authorizes a recovery target with the pre-session token and displays only the refreshed proof', async () => {
  let setupReads = 0;
  respond = async url => {
    if (url === '/api/instance/setup') return ++setupReads === 1 ? json({}) : json({ recovery: true, recoveryProofId: 'synthetic-proof-id', recoveryControlRevision: 9 });
    if (url === '/api/instance/status') return json({ state: 'maintenance' }, 503);
    if (url.endsWith('/setup/authorize')) return json({ purpose: 'recovery' });
    throw new Error(`Unexpected request: ${url}`);
  };
  await render(<InstanceRecovery />); await enterCredential('SYNTHETIC_RECOVERY_CREDENTIAL'); await click('Authorize target verification');
  expect(requests.find(item => item.url.endsWith('/setup/authorize'))?.init).toMatchObject({
    headers: { 'X-CSRF-Token': 'synthetic-pre-csrf' }, body: JSON.stringify({ credential: 'SYNTHETIC_RECOVERY_CREDENTIAL' }),
  });
  expect(container.querySelector('input')).toBeNull();
  expect(container.innerHTML).not.toContain('SYNTHETIC_RECOVERY_CREDENTIAL');
  expect(container.textContent).toContain('Target identity verified.');
  expect(container.textContent).toContain('synthetic-proof-id');
  expect(container.textContent).toContain('control revision 9');
});

it('requires the recovery purpose and reports an authorization failure safely', async () => {
  respond = async url => url.endsWith('/setup/authorize') ? json({ purpose: 'bootstrap' }) : json({});
  await render(<InstanceRecovery />); await enterCredential('SYNTHETIC_WRONG_PURPOSE'); await click('Authorize target verification');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Recovery authorization failed.');
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
});

it('starts recovery target sign-in only after operator authorization and handles provider refusal', async () => {
  respond = async () => json({ recovery: true, recoveryProofId: null, recoveryControlRevision: 9 });
  identity.signIn.mockRejectedValue(new Error('Synthetic provider refused login.'));
  await render(<InstanceRecovery />); await click('Sign in as the recovery target');
  expect(identity.signIn).toHaveBeenCalledWith('zitadel', { redirectTo: '/instance/setup' }, { prompt: 'login' });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Target login could not start.');
});

it('ignores a late recovery status response after unmount', async () => {
  let finish!: (response: Response) => void;
  respond = () => new Promise<Response>(resolve => { finish = resolve; });
  await render(<InstanceRecovery />);
  await act(async () => root.unmount());
  await act(async () => finish(json({ recovery: true, recoveryProofId: 'stale-proof' })));
  expect(container.textContent).toBe('');
});
