'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LIMITS } from '@/lib/limits';

function hidePrivateContent() {
  const element = document.querySelector<HTMLElement>('[data-private-content]');
  if (!element) return;
  element.dataset.privateState = 'hidden';
  element.setAttribute('aria-hidden', 'true');
  element.inert = true;
}

export function AccountControls() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setFailed(false); hidePrivateContent();
        try {
          const csrf = await fetch('/api/auth/csrf', { cache: 'no-store' }).then(response => response.json()) as { csrfToken?: string };
          if (!csrf.csrfToken) throw new Error();
          const response = await fetch('/api/auth/signout', { method: 'POST', cache: 'no-store',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' },
            body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: '/' }) });
          if (!response.ok) throw new Error();
          const channel = new BroadcastChannel('librarian-private-session');
          channel.postMessage('signed-out'); channel.close();
          window.location.replace('/');
        } catch { setFailed(true); setBusy(false); }
      }} className="inline-flex min-h-10 items-center rounded-md border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      {failed ? <span role="status" className="text-sm">Sign-out could not be confirmed. Reload to check your session.</span> : null}
    </div>
  );
}

export function PrivateContentGuard({ children, verifiedAt }: { children: ReactNode; verifiedAt: number }) {
  const root = useRef<HTMLDivElement>(null);
  const [javascriptReady, setJavascriptReady] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let hidden = false;
    const hide = () => {
      element.dataset.privateState = 'hidden';
      element.setAttribute('aria-hidden', 'true');
      element.inert = true;
      hidden = true;
    };
    const refresh = () => { hide(); window.location.reload(); };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide();
      else if (hidden) refresh();
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) refresh(); };
    const channel = new BroadcastChannel('librarian-private-session');
    channel.onmessage = event => { if (event.data === 'signed-out') { hide(); window.location.replace('/'); } };
    const timer = setTimeout(refresh, Math.max(0, verifiedAt + LIMITS.roleFreshMs - Date.now()));
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibility);
    element.dataset.privateState = 'visible';
    element.setAttribute('aria-hidden', 'false');
    element.inert = false;
    setJavascriptReady(true);
    return () => {
      clearTimeout(timer);
      channel.close();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [verifiedAt]);
  return (
    <div ref={root} data-private-content data-private-state="hidden" aria-hidden="true" inert>
      <div data-private-body>{children}</div>
      {!javascriptReady ? <p role="status" className="mx-auto max-w-3xl px-5 py-8">Enable JavaScript to use this restricted reader. Access is checked again before the page is shown.</p> : null}
    </div>
  );
}
