'use client';

import { useEffect, useMemo, useState } from 'react';
import { SiteNavigation } from '@/components/site-navigation';
import { SyncStatusBadge, type SyncStatus } from '@/components/sync-status-badge';
import styles from './directory.module.css';

export type DirectoryCard = {
  id: string; slug: string; title: string; publicDescription: string; visibility: 'public' | 'private';
  canOpen: boolean; url: string; syncStatus?: SyncStatus; syncError?: string | null; syncActive?: boolean;
};

type SyncResult = { catalogId: string; status: SyncStatus; error?: string | null };
type SyncSnapshot = { status: SyncStatus; error: string | null };

const syncIssueMessages: Record<string, string> = {
  access_lost: 'The GitHub App no longer has access to this repository. Update its installation, then retry.',
  github_access_denied: 'The GitHub App cannot read this repository. Check its installation and Contents read access.',
  github_docs_missing: 'The configured documentation folder was not found on this branch. Check the branch and folder values.',
  github_invalid_content: 'The documentation source did not satisfy a content validation rule. Safe static Fumadocs MDX components are supported; share the issue code when reporting it.',
  github_tree_invalid: 'GitHub returned an incomplete or inconsistent documentation tree. Retry the sync, then report this code if it repeats.',
  github_unsafe_path: 'A file or folder name uses unsupported path characters. Rename it to a portable name, then retry.',
  github_unsafe_entry: 'The documentation tree contains a symlink, submodule, executable, or other unsupported Git entry. Replace it with a regular file, then retry.',
  github_content_limit: 'The supported documentation files exceed a configured size or count limit. Reduce this folder or review the limits before changing them.',
  github_no_pages: 'No supported Markdown or MDX page was found in the configured documentation folder.',
  github_blob_mismatch: 'GitHub returned content that did not match the selected commit. Retry the sync, then report this code if it repeats.',
  invalid_content: 'A Markdown or MDX page uses unsupported syntax. Safe static Fumadocs components are supported; executable content is rejected.',
  sync_catalog_unavailable: 'This documentation source is not ready to synchronize. Check its configuration in Administration.',
  sync_rate_limited: 'The synchronization request limit was reached. Wait a little, then try again.',
  sync_quota_exhausted: 'The synchronization request limit was reached. Wait for older requests to expire, then try again.',
  sync_storage_unavailable: 'Synchronization storage is temporarily unavailable. Try again later.',
};

function issueMessage(code: string) {
  return syncIssueMessages[code] ?? `Synchronization failed with code ${code}. Share this code when reporting the issue.`;
}

export function filterDirectoryCards(cards: DirectoryCard[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized ? cards.filter(card => card.title.toLocaleLowerCase().includes(normalized)) : cards;
}

function SyncIcon({ spinning = false, className = '' }: { spinning?: boolean; className?: string }) {
  return <span className={`inline-flex size-5 shrink-0 items-center justify-center ${spinning ? styles.spinning : ''}`}>
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={`size-5 ${className}`}>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" />
    </svg>
  </span>;
}

async function readJson(response: Response) {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every(id => right.includes(id));
}

export function Directory({ cards, unavailable = false, showSignIn = false, showAccountControls = false, canSync = false, showInstanceSettings = false, displayName, description }: {
  cards: DirectoryCard[]; unavailable?: boolean; showSignIn?: boolean; showAccountControls?: boolean; canSync?: boolean;
  showInstanceSettings?: boolean; displayName?: string; description?: string;
}) {
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [syncStates, setSyncStates] = useState<Record<string, SyncSnapshot>>({});
  const [watchingIds, setWatchingIds] = useState<string[]>(() => canSync ? cards.filter(card => card.syncActive).map(card => card.id) : []);
  const [startingSyncIds, setStartingSyncIds] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [toolbarSyncing, setToolbarSyncing] = useState(false);
  const [toolbarWatchingIds, setToolbarWatchingIds] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const visible = useMemo(() => filterDirectoryCards(cards, query), [cards, query]);

  useEffect(() => {
    if (!feedback || feedback.tone !== 'info') return;
    const timer = setTimeout(() => setFeedback(null), 10_000);
    return () => clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!watchingIds.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch('/api/admin/repos', { cache: 'no-store' });
        const body = await readJson(response) as { catalogs?: Array<{ id: string; status: SyncStatus; error: string | null }> } | null;
        if (!response.ok || !body?.catalogs) throw new Error('Sync status could not be refreshed.');
        if (cancelled) return;
        const rows = new Map(body.catalogs.map(row => [row.id, row]));
        const active = watchingIds.filter(id => {
          const status = rows.get(id)?.status;
          return status === 'pending' || status === 'running';
        });
        setSyncStates(current => {
          const next = { ...current };
          for (const id of watchingIds) {
            const row = rows.get(id);
            if (!row) next[id] = { status: 'failed', error: 'catalog_not_found' };
            else next[id] = { status: row.status, error: row.error };
          }
          return next;
        });
        setWatchingIds(current => sameIds(current, active) ? current : active);
        setToolbarWatchingIds(current => current.filter(id => active.includes(id)));
        if (active.length) timer = setTimeout(poll, 3_000);
      } catch (error) {
        if (cancelled) return;
        setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'Sync status could not be refreshed.' });
        timer = setTimeout(poll, 3_000);
      }
    };
    timer = setTimeout(poll, 750);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [watchingIds]);

  async function requestSync(ids: string[], fromToolbar = false) {
    if (!canSync || !ids.length || syncing) return;
    setStartingSyncIds(current => [...new Set([...current, ...ids])]);
    setSyncing(true);
    if (fromToolbar) setToolbarSyncing(true);
    setFeedback(null);
    try {
      const csrfResponse = await fetch('/api/admin/csrf', { cache: 'no-store' });
      const csrf = await readJson(csrfResponse) as { csrfToken?: string } | null;
      if (!csrfResponse.ok || !csrf?.csrfToken) throw new Error('Administrator verification failed. Sign in again, then retry.');
      const response = await fetch('/api/admin/repos/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.csrfToken, 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ ids }),
      });
      const body = await readJson(response) as { jobs?: SyncResult[]; error?: { message?: string } } | null;
      if (!response.ok || !body?.jobs) throw new Error(body?.error?.message ?? 'The sync request could not be queued.');
      const results = body.jobs;
      const byId = new Map(results.map(result => [result.catalogId, result]));
      setSyncStates(current => {
        const next = { ...current };
        for (const id of ids) {
          const result = byId.get(id);
          if (result) next[id] = { status: result.status, error: result.error ?? null };
        }
        return next;
      });
      const activeIds = results.filter(result => result.status === 'pending' || result.status === 'running').map(result => result.catalogId);
      setWatchingIds(current => [...new Set([...current, ...activeIds])]);
      if (fromToolbar) setToolbarWatchingIds(current => [...new Set([...current, ...activeIds])]);
      const rejected = results.filter(result => result.error);
      const accepted = results.length - rejected.length;
      const rejectedIds = new Set(rejected.map(result => result.catalogId));
      setSelectedIds(current => current.filter(id => rejectedIds.has(id)));
      setFeedback(rejected.length
        ? { tone: 'error', text: `${accepted} of ${ids.length} sync requests queued. ${rejected.length} could not be queued; open the affected card's sync issue for details.` }
        : { tone: 'info', text: `Queued sync for ${accepted} ${accepted === 1 ? 'documentation source' : 'documentation sources'}.` });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'The sync request could not be queued.' });
    } finally {
      setSyncing(false);
      if (fromToolbar) setToolbarSyncing(false);
      setStartingSyncIds(current => current.filter(id => !ids.includes(id)));
    }
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id));
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8">
      <header className="mb-8">
        <SiteNavigation showSignIn={showSignIn} showAccountControls={showAccountControls} showInstanceSettings={showInstanceSettings} displayName={displayName} />
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Documentation Directory</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">{description ?? 'Browse the documentation configured for this portal.'}</p>
      </header>
      {unavailable ? (
        <p role="status" className="rounded-lg border p-5">The documentation directory is temporarily unavailable. Please try again shortly.</p>
      ) : (
        <>
          {feedback ? <p role={feedback.tone === 'error' ? 'alert' : 'status'} aria-live={feedback.tone === 'error' ? 'assertive' : 'polite'} className={`rounded-md border p-3 text-sm ${feedback.tone === 'error' ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300' : ''}`} style={{
            marginBottom: 20,
            ...(feedback.tone === 'info' ? {
              backgroundColor: 'color-mix(in srgb, var(--color-fd-info) 12%, transparent)',
              borderColor: 'color-mix(in srgb, var(--color-fd-info) 35%, transparent)',
              color: 'var(--color-fd-info)',
            } : {}),
          }}>{feedback.text}</p> : null}
          <div role="toolbar" aria-label="Documentation directory tools" className="mb-7 flex flex-col gap-4 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="w-full max-w-md">
              <input id="project-filter" aria-label="Search documentation" type="search" value={query} onInput={event => setQuery(event.currentTarget.value)}
                placeholder="Filter documentation by title" className="w-full rounded-md border bg-background px-3 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            </div>
            {canSync ? <div className="flex items-center sm:justify-end">
              <button type="button" aria-label={`Sync ${selectedIds.length} selected ${selectedIds.length === 1 ? 'document' : 'documents'}`} title={`Sync ${selectedIds.length} selected ${selectedIds.length === 1 ? 'document' : 'documents'}`} disabled={!selectedIds.length || syncing} onClick={() => void requestSync(selectedIds, true)}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-primary bg-transparent px-3 text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <SyncIcon spinning={toolbarSyncing || toolbarWatchingIds.length > 0} />
                <span>Sync</span>
                <span aria-hidden="true" className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1 py-0.5 text-xs font-semibold leading-none" style={{ color: 'var(--color-fd-primary-foreground)' }}>{selectedIds.length}</span>
              </button>
            </div> : null}
          </div>
          {visible.length ? (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Documentation sources">
              {visible.map(card => {
                const live = syncStates[card.id];
                const status = live?.status ?? card.syncStatus ?? (card.canOpen ? 'succeeded' : 'pending');
                const error = live ? live.error : card.syncError ?? null;
                const active = watchingIds.includes(card.id) || (live
                  ? status === 'pending' || status === 'running'
                  : status === 'running' || (status === 'pending' && card.syncActive === true));
                const canSelect = canSync && !active && !syncing;
                const selected = selectedIds.includes(card.id);
                const starting = startingSyncIds.includes(card.id);
                const iconColor = starting ? 'text-muted-foreground' : status === 'pending'
                  ? 'text-amber-800 dark:text-amber-300'
                  : status === 'running' ? 'text-green-800 dark:text-green-300'
                    : status === 'failed' ? 'text-red-800 dark:text-red-300' : 'text-primary';
                const title = <>
                  <h2 className="min-w-0 flex-1 truncate text-lg font-semibold" title={card.title}>{card.title}</h2>
                  <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">{card.visibility === 'public' ? 'Public' : 'Private'}</span>
                </>;
                return <li key={card.id}>
                  <article className="flex h-full flex-col rounded-lg border bg-card p-5 transition-colors hover:bg-muted/30">
                    <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        {canSync ? <label className={`relative flex size-8 shrink-0 items-center justify-center rounded-full bg-card ${canSelect ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                          <input type="checkbox" aria-label={`Select ${card.title}`} checked={selected} disabled={!canSelect}
                            onChange={event => toggleSelected(card.id, event.target.checked)} className="size-5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            style={{
                              cursor: canSelect ? 'pointer' : 'not-allowed',
                              appearance: 'none',
                              border: '1px solid var(--color-fd-border)',
                              borderRadius: '50%',
                              backgroundColor: selected ? 'var(--color-fd-primary)' : 'var(--color-fd-card)',
                            }} />
                          <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" className="pointer-events-none absolute size-3"
                            style={{ inset: 0, margin: 'auto', opacity: selected ? 1 : 0, color: 'var(--color-fd-primary-foreground)' }}>
                            <path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </label> : null}
                        {card.canOpen
                          ? <a href={card.url} title={card.title} className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{title}</a>
                          : <div className="flex min-h-9 min-w-0 flex-1 items-center gap-2">{title}</div>}
                      </div>
                      {canSync ? <button type="button" aria-label={`Sync ${card.title}`} title={`Sync ${card.title}`} disabled={syncing || active}
                        onClick={() => void requestSync([card.id])} className="inline-flex size-8 flex-none items-center justify-center rounded-full p-0 hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <SyncIcon className={iconColor} spinning={active || starting} />
                      </button> : null}
                    </div>
                    {!card.canOpen ? <p className="sr-only">Documentation is unavailable until a successful sync.</p> : null}
                    {card.publicDescription ? card.canOpen
                      ? <a href={card.url} className="flex min-w-0 flex-col rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <p className="mt-2 line-clamp-3 text-sm text-muted-foreground" title={card.publicDescription}>{card.publicDescription}</p>
                      </a>
                      : <div className="flex min-w-0 flex-col"><p className="mt-2 line-clamp-3 text-sm text-muted-foreground" title={card.publicDescription}>{card.publicDescription}</p></div>
                      : null}
                    {error ? <details className="relative z-10 mt-4 overflow-hidden rounded-md border border-red-300 bg-red-50 text-sm dark:border-red-800 dark:bg-red-950/40">
                      <summary className="cursor-pointer px-3 py-2 font-medium text-red-800 dark:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Sync issue · read and report</summary>
                      <div role="alert" className="border-t border-red-300 px-3 py-3 text-foreground dark:border-red-800">
                        <p>{issueMessage(error)}</p>
                        <p className="mt-2 text-xs text-muted-foreground">Issue code: <code>{error}</code>. Share this code when reporting the issue.</p>
                      </div>
                    </details> : null}
                    <div className="mt-auto pt-3" style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-start' }}><SyncStatusBadge status={status} /></div>
                  </article>
                </li>;
              })}
            </ul>
          ) : (
            <p role="status" className="rounded-lg border p-5">{cards.length ? 'No projects match that title.' : 'No documentation projects are available yet.'}</p>
          )}
        </>
      )}
    </main>
  );
}
