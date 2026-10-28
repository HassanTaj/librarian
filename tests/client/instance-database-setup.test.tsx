import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InstanceDatabaseSetup } from '../../components/instance-database-setup';

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let container: HTMLDivElement;
let root: Root;

async function render() { await act(async () => root.render(<InstanceDatabaseSetup />)); }
async function submit() {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
function fill(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  navigation.refresh.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('holds the submit state until the database check finishes and refreshes after setup', async () => {
  let resolveFetch!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; })));
  await render();
  fill('credential', 'synthetic-setup-credential');
  fill('mongodbUri', 'mongodb://synthetic:secret@127.0.0.1:27018/');
  fill('mongodbDatabase', 'librarian_test');
  await submit();
  const button = container.querySelector('button')!;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe('Checking connection…');
  await act(async () => { resolveFetch(json({ status: 'configured' })); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(navigation.refresh).toHaveBeenCalledOnce();
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe('Connect and continue');
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({
    credential: 'synthetic-setup-credential', mongodbUri: 'mongodb://synthetic:secret@127.0.0.1:27018/', mongodbDatabase: 'librarian_test',
  });
});

it('shows server errors and safe fallbacks for missing messages and network failures', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(json({ error: { message: 'The target database is not empty.' } }, 409))
    .mockResolvedValueOnce(json({}, 503))
    .mockRejectedValueOnce('synthetic network failure');
  vi.stubGlobal('fetch', request);
  await render();
  fill('credential', 'synthetic-setup-credential');
  fill('mongodbUri', 'mongodb://synthetic:secret@127.0.0.1:27018/');
  fill('mongodbDatabase', 'librarian_test');

  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The target database is not empty.');
  expect(navigation.refresh).not.toHaveBeenCalled();
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The database connection could not be configured.');
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The database connection could not be configured.');
  expect(request).toHaveBeenCalledTimes(3);
});
