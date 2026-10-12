import type { EffectCallback } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  effect: undefined as EffectCallback | undefined,
  element: null as unknown,
}));

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: (effect: EffectCallback) => { hooks.effect = effect; },
    useRef: (initial: unknown) => ({ current: hooks.element ?? initial }),
    useState: (initial: unknown) => [initial, vi.fn()],
  } as unknown as typeof actual;
});

import { AccountControls, PrivateContentGuard } from '../../components/private-content-guard';

const windowListeners = new Map<string, EventListener>();
const documentListeners = new Map<string, EventListener>();
const location = { reload: vi.fn(), replace: vi.fn() };
const attributes = new Map<string, string>();
const privateRoot = {
  dataset: {} as DOMStringMap,
  inert: true,
  setAttribute: vi.fn((name: string, value: string) => attributes.set(name, value)),
} as unknown as HTMLDivElement;

class TestBroadcastChannel {
  static latest: TestBroadcastChannel;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  postMessage = vi.fn();
  constructor() { TestBroadcastChannel.latest = this; }
}

function installBrowser() {
  windowListeners.clear();
  documentListeners.clear();
  attributes.clear();
  privateRoot.dataset.privateState = 'hidden';
  privateRoot.inert = true;
  location.reload.mockClear();
  location.replace.mockClear();
  vi.stubGlobal('window', {
    location,
    addEventListener: (name: string, handler: EventListener) => windowListeners.set(name, handler),
    removeEventListener: vi.fn((name: string) => windowListeners.delete(name)),
  });
  const fakeDocument = {
    visibilityState: 'visible' as DocumentVisibilityState,
    querySelector: () => privateRoot,
    addEventListener: (name: string, handler: EventListener) => documentListeners.set(name, handler),
    removeEventListener: vi.fn((name: string) => documentListeners.delete(name)),
  };
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
  return fakeDocument;
}

afterEach(() => {
  hooks.effect = undefined;
  hooks.element = null;
  vi.unstubAllGlobals();
});

it('hides on page lifecycle events and refreshes after BFCache or visibility restoration', () => {
  const fakeDocument = installBrowser();
  hooks.element = privateRoot;
  PrivateContentGuard({ children: null, verifiedAt: Date.now() + 60_000 });
  const cleanup = hooks.effect?.();

  expect(privateRoot.dataset.privateState).toBe('visible');
  windowListeners.get('pageshow')?.(Object.assign(new Event('pageshow'), { persisted: false }));
  documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
  expect(location.reload).not.toHaveBeenCalled();
  windowListeners.get('pagehide')?.(new Event('pagehide'));
  expect(privateRoot.inert).toBe(true);
  expect(attributes.get('aria-hidden')).toBe('true');

  fakeDocument.visibilityState = 'hidden';
  documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
  fakeDocument.visibilityState = 'visible';
  documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
  windowListeners.get('pageshow')?.(Object.assign(new Event('pageshow'), { persisted: true }));
  expect(location.reload).toHaveBeenCalledTimes(2);

  TestBroadcastChannel.latest.onmessage?.({ data: 'other' } as MessageEvent);
  expect(location.replace).not.toHaveBeenCalled();
  TestBroadcastChannel.latest.onmessage?.({ data: 'signed-out' } as MessageEvent);
  expect(location.replace).toHaveBeenCalledWith('/');
  expect(privateRoot.dataset.privateState).toBe('hidden');

  cleanup?.();
  expect(TestBroadcastChannel.latest.close).toHaveBeenCalledOnce();
  expect(windowListeners.size).toBe(0);
  expect(documentListeners.size).toBe(0);
});

it('fails closed if the protected root was removed before lifecycle setup', () => {
  installBrowser();
  hooks.element = null;
  PrivateContentGuard({ children: null, verifiedAt: Date.now() });
  expect(hooks.effect?.()).toBeUndefined();
  expect(windowListeners.size).toBe(0);
});

it('completes sign-out only after CSRF validation and posts the cross-tab event', async () => {
  installBrowser();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf-synthetic' })))
    .mockResolvedValueOnce(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  const tree = AccountControls() as unknown as { props: { children: Array<{ props: { onClick: () => Promise<void> } }> } };
  await tree.props.children[0].props.onClick();

  expect(location.replace).toHaveBeenCalledWith('/');
  expect(TestBroadcastChannel.latest.postMessage).toHaveBeenCalledWith('signed-out');
  expect(TestBroadcastChannel.latest.close).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
