import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountControls, PrivateContentGuard } from '../../components/private-content-guard';

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

it('renders a no-script explanation and hides the protected body on pagehide', async () => {
  const element = <PrivateContentGuard verifiedAt={Date.now() + 60_000}><p>Synthetic private body</p></PrivateContentGuard>;
  expect(renderToString(element)).toContain('Enable JavaScript to use this restricted reader');
  expect(renderToString(element)).toContain('data-private-state="hidden"');

  await act(async () => root.render(element));
  const protectedRoot = container.querySelector<HTMLElement>('[data-private-content]')!;
  expect(protectedRoot.dataset.privateState).toBe('visible');
  expect(protectedRoot.inert).toBe(false);
  await act(async () => { window.dispatchEvent(new Event('pagehide')); });
  expect(protectedRoot.dataset.privateState).toBe('hidden');
  expect(protectedRoot.getAttribute('aria-hidden')).toBe('true');
  expect(protectedRoot.inert).toBe(true);

  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(protectedRoot.dataset.privateState).toBe('hidden');
});

it('keeps the private body hidden and reports an unconfirmed sign-out', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({})))
    .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'synthetic-csrf' })))
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => root.render(<>
    <PrivateContentGuard verifiedAt={Date.now() + 60_000}>Synthetic private body</PrivateContentGuard>
    <AccountControls />
  </>));

  await act(async () => container.querySelector('button')!.click());
  const protectedRoot = container.querySelector<HTMLElement>('[data-private-content]')!;
  expect(protectedRoot.dataset.privateState).toBe('hidden');
  expect(container.textContent).toContain('Reload to check your session.');

  await act(async () => container.querySelector('button')!.click());
  expect(protectedRoot.dataset.privateState).toBe('hidden');
  expect(container.textContent).toContain('Sign-out could not be confirmed.');
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('keeps the compact reader sign-out control accessible on narrow screens', async () => {
  await act(async () => root.render(<AccountControls compact />));
  const button = container.querySelector('button')!;
  expect(button.getAttribute('aria-label')).toBe('Sign out');
  expect(button.className).toContain('size-10');
  expect(button.className).toContain('rounded-full');
  expect(button.textContent).toBe('Sign out');
  expect(button.querySelector('span')?.className).toBe('sr-only');
  expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(button.querySelector('svg')?.getAttribute('class')).toContain('size-4');
});

it('keeps visible content active for non-persisted restores and hides safely without a private root', async () => {
  await act(async () => root.render(<PrivateContentGuard verifiedAt={Date.now() + 60_000}>Synthetic private body</PrivateContentGuard>));
  const protectedRoot = container.querySelector<HTMLElement>('[data-private-content]')!;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  const pageshow = new Event('pageshow');
  Object.defineProperty(pageshow, 'persisted', { value: false });
  await act(async () => window.dispatchEvent(pageshow));
  expect(protectedRoot.dataset.privateState).toBe('visible');
  expect(protectedRoot.inert).toBe(false);

  await act(async () => root.unmount());
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  await act(async () => root.render(<AccountControls />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('Reload to check your session.');
});

