'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { SiteNavigation } from '@/components/site-navigation';
import { SyncStatusBadge } from '@/components/sync-status-badge';
import { LIMITS } from '@/lib/limits';
import styles from './admin-console.module.css';
import syncStyles from './directory.module.css';

type CatalogRow = {
  id: string; revision: number; updatedAt: string; github: { owner: string; name: string; branch: string; docsPath: string; installationId: number; repositoryId: number };
  slug: string; title: string; publicDescription: string; visibility: 'public' | 'private'; readerRole: string;
  approvalRef: string | null;
  enabled: boolean; accessState: string; status: 'pending' | 'running' | 'succeeded' | 'failed'; error: string | null;
  nextAttemptAt?: string | null; publishedCommit: string | null; lastSuccessAt: string | null;
};

const syncIssueMessages: Record<string, string> = {
  public_approval_required: 'Librarian could not validate an owner-approved record for this catalog’s exact scope and content. Check the manifest, reference, reviewed commit, and content digest.',
  github_invalid_content: 'The documentation source did not satisfy a content validation rule. Safe static Fumadocs MDX components are supported; report the issue code if it repeats.',
  github_tree_invalid: 'GitHub returned an incomplete or inconsistent documentation tree. Retry the sync, then report this code if it repeats.',
  github_unsafe_path: 'A file or folder name uses unsupported path characters. Rename it to a portable name, then retry.',
  github_unsafe_entry: 'The documentation tree contains a symlink, submodule, executable, or other unsupported Git entry. Replace it with a regular file, then retry.',
  github_content_limit: 'The supported documentation files exceed a configured size or count limit. Reduce this folder or review the limits before changing them.',
  github_no_pages: 'No supported Markdown or MDX page was found in the configured documentation folder.',
  github_blob_mismatch: 'GitHub returned content that did not match the selected commit. Retry the sync, then report this code if it repeats.',
  invalid_content: 'A Markdown or MDX page uses unsupported syntax. Safe static Fumadocs components are supported; executable content is rejected.',
  github_access_denied: 'The GitHub App cannot read this repository. Check its installation and Contents read access.',
  github_docs_missing: 'The configured documentation folder was not found on this branch. Check the branch and folder values.',
  access_lost: 'The GitHub App no longer has access to this repository. Update its installation, then retry.',
};

const skeletonStyle = { backgroundColor: 'rgba(128, 128, 128, 0.35)' };

async function responseError(response: Response) {
  const value = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return value?.error?.message ?? 'The request could not be completed.';
}

function Icon({ name, className = '' }: { name: 'info' | 'error' | 'sync' | 'edit' | 'delete' | 'save' | 'cancel' | 'refresh' | 'view'; className?: string }) {
  const paths = {
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
    error: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3h.01" /></>,
    sync: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" /></>,
    edit: <><path d="m14 5 5 5M4 20l4.3-.9L19 8.4 15.6 5 5 15.7 4 20Z" /></>,
    delete: <><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
    save: <><path d="M5 4h12l3 3v13H4V4h1Z" /><path d="M8 4v6h8V4M8 20v-6h8v6" /></>,
    cancel: <><path d="m6 6 12 12M18 6 6 18" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" /></>,
    view: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  };
  return <svg style={{ width: 16, height: 16, flexShrink: 0 }} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 shrink-0 ${className}`}>{paths[name]}</svg>;
}

function FeedbackBanner({ children, tone, role }: { children: ReactNode; tone: 'info' | 'error' | 'success'; role: 'status' | 'alert' }) {
  const error = tone === 'error';
  const success = tone === 'success';
  return <div role={role} aria-live={role === 'alert' ? 'assertive' : 'polite'} className={`flex items-start gap-2 rounded-md border p-3 text-sm ${error ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300' : success ? 'border-green-700/40 bg-green-700/10 text-green-800 dark:text-green-300' : 'border-primary/30 bg-primary/5 text-foreground'}`}>
    <Icon name={error ? 'error' : 'info'} className="mt-0.5" /><div>{children}</div>
  </div>;
}

function Skeleton({ width = '100%', height = 20, pill = false }: { width?: number | string; height?: number; pill?: boolean }) {
  return <div aria-hidden="true" style={{ ...skeletonStyle, width, height, maxWidth: '100%', borderRadius: pill ? 9999 : 6 }} className="animate-pulse motion-reduce:animate-none" />;
}

const circleButtonStyle = { width: 32, height: 32, minWidth: 32, minHeight: 32, flex: '0 0 32px', padding: 0, borderRadius: '50%' };

export function AdminSkeletonCards() {
  return <div className="grid gap-4">
    {[0, 1, 2].map(item => <article key={item} aria-hidden="true" className="rounded-xl border p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Skeleton height={28} width={240} />
          <div className="mt-1"><Skeleton height={16} width={480} /></div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton width={32} height={32} pill />
          <Skeleton width={32} height={32} pill />
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map(field => <div key={field} style={{ display: 'grid', gap: 4 }}>
          <Skeleton height={16} width={128} />
          <Skeleton width={160} />
        </div>)}
      </div>
      <div className="mt-4" style={{ display: 'flex', justifyContent: 'flex-start' }}><Skeleton width={96} height={26} pill /></div>
    </article>)}
  </div>;
}

export function AdminSkeleton() {
  return <main role="status" aria-label="Loading configured repositories" aria-busy="true" className="mx-auto max-w-6xl px-5 py-10">
    <span className="sr-only">Loading configured repositories…</span>
    <nav aria-hidden="true" className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-2"><Skeleton width={32} height={32} /><Skeleton width={176} /></div>
      <div className="flex flex-wrap items-center gap-4">
        <Skeleton width={48} /><Skeleton width={96} /><Skeleton width={80} height={40} /><Skeleton width={64} height={40} pill />
      </div>
    </nav>
    <div aria-hidden="true" className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <Skeleton height={36} width={360} />
        <div className="mt-2"><Skeleton height={24} width={540} /></div>
      </div>
      <div className="flex items-center gap-3"><Skeleton width={36} height={36} pill /><Skeleton width={104} height={40} /></div>
    </div>
    <section className="mt-8"><AdminSkeletonCards /></section>
  </main>;
}
export function AdminConsole({ defaultDocsFolder = 'docs', showInstanceSettings = false, displayName }: { defaultDocsFolder?: string; showInstanceSettings?: boolean; displayName?: string }) {
  const [catalogs, setCatalogs] = useState<CatalogRow[]>([]);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [startingSyncId, setStartingSyncId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [watchingSync, setWatchingSync] = useState<{ id: string; startedAt: number } | null>(null);
  const [draft, setDraft] = useState({ owner: '', name: '', installationId: '', branch: 'main', docsPath: defaultDocsFolder, slug: '', title: '', publicDescription: '', readerRole: '', visibility: 'private' as 'public' | 'private', approvalRef: '' });

  async function reload() {
    setError('');
    try {
      const csrf = await fetch('/api/admin/csrf', { cache: 'no-store' });
      if (!csrf.ok) throw new Error(await responseError(csrf));
      const csrfBody = await csrf.json() as { csrfToken: string };
      const response = await fetch('/api/admin/repos', { cache: 'no-store' });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json() as { catalogs: CatalogRow[] };
      setToken(csrfBody.csrfToken);
      setCatalogs(body.catalogs);
      setWatchingSync(current => {
        if (current && body.catalogs.some(catalog => catalog.id === current.id && (catalog.status === 'pending' || catalog.status === 'running'))) return current;
        const active = body.catalogs.find(catalog => catalog.status === 'running' || (catalog.status === 'pending' && catalog.nextAttemptAt));
        return active ? { id: active.id, startedAt: Date.now() } : null;
      });
    } catch (caught) { setCatalogs([]); setToken(''); setError(caught instanceof Error ? caught.message : 'Administration is unavailable.'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    const timer = setTimeout(() => { void reload(); }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 10_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!watchingSync) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let deadline = watchingSync.startedAt + LIMITS.attemptTimeoutMs + LIMITS.recoveryDeadlineMs;
    let previousStatus: CatalogRow['status'] = 'pending';
    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setWatchingSync(current => current?.id === watchingSync.id ? null : current);
        return;
      }
      try {
        const response = await fetch('/api/admin/repos', { cache: 'no-store' });
        if (!response.ok) throw new Error(await responseError(response));
        const body = await response.json() as { catalogs: CatalogRow[] };
        if (cancelled) return;
        setCatalogs(body.catalogs);
        setError('');
        const catalog = body.catalogs.find(item => item.id === watchingSync.id);
        if (!catalog || (catalog.status !== 'pending' && catalog.status !== 'running')) {
          setWatchingSync(current => current?.id === watchingSync.id ? null : current);
          return;
        }
        if (catalog.status === 'running' && previousStatus !== 'running') {
          deadline = Math.max(deadline, Date.now() + LIMITS.attemptTimeoutMs + LIMITS.recoveryDeadlineMs);
        }
        const nextAttempt = catalog.nextAttemptAt ? Date.parse(catalog.nextAttemptAt) : Number.NaN;
        if (Number.isFinite(nextAttempt) && nextAttempt > Date.now()) {
          deadline = Math.max(deadline, nextAttempt + LIMITS.attemptTimeoutMs + LIMITS.recoveryDeadlineMs);
          timer = setTimeout(poll, nextAttempt - Date.now() + 250);
        } else {
          timer = setTimeout(poll, 5_000);
        }
        previousStatus = catalog.status;
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : 'Synchronization status could not be refreshed.');
        timer = setTimeout(poll, 5_000);
      }
    };
    timer = setTimeout(poll, 3_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [watchingSync]);

  async function createCatalog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(''); setFormError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/repos', { method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ github: { owner: draft.owner, name: draft.name, branch: draft.branch, docsPath: draft.docsPath,
          installationId: Number(draft.installationId) }, slug: draft.slug, title: draft.title,
          publicDescription: draft.publicDescription, visibility: draft.visibility,
          ...(draft.readerRole ? { readerRole: draft.readerRole } : {}),
          ...(draft.visibility === 'public' ? { approvalRef: draft.approvalRef } : {}) }) });
      if (!response.ok) throw new Error(await responseError(response));
      setNotice(`${draft.visibility === 'public' ? 'Public' : 'Private'} repository saved. Queue its first synchronization when ready.`);
      setConfigurationOpen(false);
      setDraft({ owner: '', name: '', installationId: '', branch: 'main', docsPath: defaultDocsFolder, slug: '', title: '', publicDescription: '', readerRole: '', visibility: 'private', approvalRef: '' });
      await reload();
    } catch (caught) { setFormError(caught instanceof Error ? caught.message : 'The repository could not be saved.'); }
    finally { setBusy(false); }
  }

  async function saveCatalog(event: FormEvent<HTMLFormElement>, catalog: CatalogRow, form: FormData) {
    event.preventDefault();
    setBusy(true); setError(''); setFormError(''); setNotice('');
    const version = (event.currentTarget.querySelector('[data-etag]') as HTMLInputElement | null)?.value;
    const github = { owner: String(form.get('owner') ?? ''), name: String(form.get('name') ?? ''),
      branch: String(form.get('branch') ?? ''), docsPath: String(form.get('docsPath') ?? ''),
      installationId: Number(form.get('installationId') ?? 0) };
    const sourceChanged = github.owner !== catalog.github.owner || github.name !== catalog.github.name ||
      github.branch !== catalog.github.branch || github.docsPath !== catalog.github.docsPath || github.installationId !== catalog.github.installationId;
    try {
      const response = await fetch(`/api/admin/repos/${catalog.id}`, { method: 'PATCH', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'if-match': version ?? '', 'x-csrf-token': token },
        body: JSON.stringify({ title: String(form.get('title') ?? ''), publicDescription: String(form.get('publicDescription') ?? ''),
          readerRole: String(form.get('readerRole') ?? ''), enabled: form.get('enabled') === 'on',
          slug: String(form.get('slug') ?? catalog.slug), visibility: String(form.get('visibility') ?? catalog.visibility),
          approvalRef: form.get('visibility') === 'private' ? null : String(form.get('approvalRef') ?? ''),
          ...(sourceChanged ? { github } : {}) }) });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json() as { catalog: CatalogRow };
      setCatalogs(current => current.map(item => item.id === catalog.id ? body.catalog : item)
        .sort((left, right) => left.title.localeCompare(right.title)));
      setNotice('Catalog settings saved.');
      setEditingId(null);
      setFormError('');
    } catch (caught) { setFormError(caught instanceof Error ? caught.message : 'The catalog could not be saved.'); }
    finally { setBusy(false); }
  }

  async function removeCatalog(catalog: CatalogRow) {
    if (!window.confirm(`Delete "${catalog.title}"? Its repository settings and stored documentation will be removed.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/repos/${catalog.id}`, { method: 'DELETE', cache: 'no-store',
        headers: { 'if-match': `"${new Date(catalog.updatedAt).toISOString()}"`, 'x-csrf-token': token } });
      if (!response.ok) throw new Error(await responseError(response));
      setEditingId(null);
      setViewingId(null);
      setNotice('Repository removed.');
      await reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The repository could not be removed.'); }
    finally { setBusy(false); }
  }

  async function synchronize(catalog: CatalogRow) {
    setStartingSyncId(catalog.id);
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/repos/${catalog.id}/sync`, { method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-csrf-token': token }, body: '{}' });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { status: CatalogRow['status']; error?: string };
      setCatalogs(current => current.map(item => item.id === catalog.id ? { ...item, status: result.status, error: result.error ?? null } : item));
      if (result.status === 'pending' || result.status === 'running') setWatchingSync({ id: catalog.id, startedAt: Date.now() });
      setNotice('Synchronization request was durably accepted.');
      await reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Synchronization could not be queued.'); }
    finally { setBusy(false); setStartingSyncId(null); }
  }

  if (loading) return <AdminSkeleton />;

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <SiteNavigation showAccountControls showInstanceSettings={showInstanceSettings} displayName={displayName} />
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-3xl font-semibold">Configured Repositories</h1>
        <p className="mt-2 text-muted-foreground">Configure repository sources and review synchronization status.</p></div>
      <div className="flex flex-wrap items-center gap-3">
        <button style={{ ...circleButtonStyle, width: 36, height: 36, minWidth: 36, minHeight: 36, flexBasis: 36 }} type="button" onClick={() => void reload()} disabled={busy} aria-label="Refresh status" title="Refresh status" className={styles.circleButton + " inline-flex h-9 w-9 min-h-9 min-w-9 shrink-0 aspect-square items-center justify-center rounded-full border border-secondary p-0 text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"}><Icon name="refresh" /></button>
        <button type="button" onClick={() => setConfigurationOpen(true)} disabled={configurationOpen || busy} aria-expanded={configurationOpen} aria-controls="new-catalog-form" className="rounded-md border border-primary px-4 py-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60">Configure</button>
      </div>
    </div>
    {error ? <div className="mt-5"><FeedbackBanner tone="error" role="alert">{error}</FeedbackBanner></div> : null}
    {notice ? <div className="mt-5"><FeedbackBanner tone={notice === 'Synchronization request was durably accepted.' ? 'info' : 'success'} role="status">{notice}</FeedbackBanner></div> : null}
    <section hidden={!configurationOpen} className="mt-8 rounded-xl border p-5" aria-labelledby="new-catalog-title">
      <h2 id="new-catalog-title" className="text-xl font-semibold">Add a repository</h2>
      <p className="mt-2 text-sm text-muted-foreground">The selected GitHub App installation is checked before saving. Public catalogs also require a matching owner approval reference.</p>
      <form id="new-catalog-form" onSubmit={createCatalog} className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {([['owner', 'GitHub owner'], ['name', 'Repository name'], ['installationId', 'GitHub installation ID'], ['branch', 'Branch'], ['docsPath', 'Documentation folder'], ['slug', 'Portal route slug'], ['title', 'Display title'], ['readerRole', 'Required reader role']] as const).map(([key, label]) =>
          <label key={key} className="grid gap-1 text-sm font-medium">{label}<input required={key !== 'readerRole'} inputMode={key === 'installationId' ? 'numeric' : undefined}
            value={draft[key]} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))}
            className="rounded-md border bg-background px-3 py-2 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>)}
        <label className="grid gap-1 text-sm font-medium">Repository type<select value={draft.visibility} onChange={event => setDraft(previous => ({ ...previous, visibility: event.target.value as 'public' | 'private' }))} className="rounded-md border bg-background px-3 py-2 font-normal"><option value="private">Private</option><option value="public">Public</option></select></label>
        {draft.visibility === 'public' ? <label className="grid gap-1 text-sm font-medium">Owner approval reference<input required value={draft.approvalRef} onChange={event => setDraft(previous => ({ ...previous, approvalRef: event.target.value }))} className="rounded-md border bg-background px-3 py-2 font-normal" /></label> : null}
        <label className="grid gap-1 text-sm font-medium sm:col-span-2 lg:col-span-3">Directory description<textarea value={draft.publicDescription} onChange={event => setDraft(previous => ({ ...previous, publicDescription: event.target.value }))} rows={3} className="rounded-md border bg-background px-3 py-2 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
        {formError ? <details className="rounded-md sm:col-span-2 lg:col-span-3"><summary className="cursor-pointer text-sm text-red-800 dark:text-red-300">Repository could not be saved. Expand for details.</summary><div className="mt-2"><FeedbackBanner tone="error" role="alert">{formError}</FeedbackBanner></div></details> : null}
        <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
          <button type="submit" disabled={busy || !token} className="rounded-md border border-primary bg-transparent px-4 py-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">Save</button>
          <button type="button" disabled={busy} onClick={() => { setConfigurationOpen(false); setFormError(''); }} className="rounded-md border px-4 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">Cancel</button>
        </div>
      </form>
    </section>
    <section className="mt-8">
      {catalogs.length === 0 ? <p className="mt-4 text-muted-foreground">No repositories are configured.</p> : null}
      <div className="grid gap-4">
        {catalogs.map(catalog => {
          const editing = editingId === catalog.id;
          const viewing = viewingId === catalog.id;
          const settingsId = `catalog-settings-${catalog.id}`;
          const detailsId = `catalog-details-${catalog.id}`;
          const summaryId = `catalog-summary-${catalog.id}`;
          const starting = startingSyncId === catalog.id;
          const syncColor = starting ? 'var(--color-fd-muted-foreground)' : catalog.status === 'pending' ? 'var(--color-fd-warning)' : catalog.status === 'running' ? 'var(--color-fd-secondary)' : catalog.status === 'failed' ? 'var(--color-fd-error)' : 'var(--color-fd-primary)';
          const syncing = starting || watchingSync?.id === catalog.id || catalog.status === 'running' || (catalog.status === 'pending' && Boolean(catalog.nextAttemptAt));
          const syncLabel = catalog.status === 'running' ? `Synchronization in progress for ${catalog.title}`
            : catalog.nextAttemptAt ? `Synchronization retry scheduled for ${catalog.title}`
              : syncing ? `Synchronization queued for ${catalog.title}` : `Sync ${catalog.title}`;
          return <article key={catalog.id} className="rounded-xl border p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1"><h3 className="break-words text-lg font-semibold">{catalog.title}</h3><p className="mt-1 break-words text-sm text-muted-foreground">{catalog.github.owner}/{catalog.github.name} · {catalog.github.branch}/{catalog.github.docsPath} · /{catalog.slug}</p></div>
            <div className="flex shrink-0 flex-nowrap items-center gap-2">
              <button style={{ ...circleButtonStyle, color: "var(--color-fd-warning)", borderColor: "var(--color-fd-warning)" }} type="button" disabled={editing} onClick={() => setViewingId(viewing ? null : catalog.id)} aria-label={`${viewing ? 'Hide' : 'View'} ${catalog.title} details`} title={`${viewing ? 'Hide' : 'View'} ${catalog.title} details`} aria-expanded={viewing} aria-controls={detailsId} className={styles.circleButton + " inline-flex h-8 w-8 min-h-8 min-w-8 shrink-0 items-center justify-center rounded-full border p-0 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"}><Icon name="view" /></button>
              {viewing && !editing ? <button style={circleButtonStyle} type="button" disabled={busy} onClick={() => setEditingId(catalog.id)} aria-label={`Edit ${catalog.title}`} title={`Edit ${catalog.title}`} aria-controls={settingsId} aria-expanded="false" className={styles.circleButton + " inline-flex h-8 w-8 min-h-8 min-w-8 shrink-0 items-center justify-center rounded-full border border-secondary p-0 text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"}><Icon name="edit" /></button> : null}
              {viewing ? <button style={circleButtonStyle} type="button" disabled={busy || !token || editing} onClick={() => void removeCatalog(catalog)} aria-label={`Delete ${catalog.title}`} title={`Delete ${catalog.title}`} className={styles.circleButton + " inline-flex h-8 w-8 min-h-8 min-w-8 shrink-0 items-center justify-center rounded-full border border-red-300 p-0 text-red-800 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"}><Icon name="delete" /></button> : null}
              <button style={{ ...circleButtonStyle, color: syncColor, borderColor: syncColor }} type="button" disabled={busy || syncing || !token || !catalog.enabled || catalog.accessState !== 'ready'} onClick={() => void synchronize(catalog)} aria-label={syncLabel} title={syncLabel} className={styles.circleButton + " inline-flex h-8 w-8 min-h-8 min-w-8 shrink-0 items-center justify-center rounded-full border border-primary bg-transparent p-0 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"}><span style={{ display: 'inline-flex', width: 16, height: 16 }} className={syncing ? syncStyles.spinning : undefined}><Icon name="sync" /></span></button>
            </div>
          </div>
          <dl id={summaryId} className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-muted-foreground">Repository type</dt><dd>{catalog.visibility === 'private' ? 'Private' : 'Public'}</dd></div>
            <div><dt className="text-muted-foreground">Enabled</dt><dd>{catalog.enabled ? 'Yes' : 'No'}</dd></div>
            <div><dt className="text-muted-foreground">Published commit</dt><dd>{catalog.publishedCommit ? <span title={catalog.publishedCommit} aria-label={`Published commit ${catalog.publishedCommit}`}>{catalog.publishedCommit.length > 12 ? `${catalog.publishedCommit.slice(0, 7)}…` : catalog.publishedCommit}</span> : 'No successful sync'}</dd></div>
            <div><dt className="text-muted-foreground">Last successful sync</dt><dd>{catalog.lastSuccessAt ? new Date(catalog.lastSuccessAt).toLocaleString() : 'Never'}</dd></div>
          </dl>
          <div id={detailsId} hidden={!viewing}>
            {viewing ? <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-muted-foreground">GitHub owner</dt><dd>{catalog.github.owner}</dd></div>
              <div><dt className="text-muted-foreground">Repository name</dt><dd>{catalog.github.name}</dd></div>
              <div><dt className="text-muted-foreground">GitHub installation ID</dt><dd>{catalog.github.installationId}</dd></div>
              <div><dt className="text-muted-foreground">Branch</dt><dd>{catalog.github.branch}</dd></div>
              <div><dt className="text-muted-foreground">Documentation folder</dt><dd>{catalog.github.docsPath}</dd></div>
              <div><dt className="text-muted-foreground">Portal route slug</dt><dd>/{catalog.slug}</dd></div>
              <div><dt className="text-muted-foreground">Display title</dt><dd>{catalog.title}</dd></div>
              <div><dt className="text-muted-foreground">Required reader role</dt><dd>{catalog.readerRole}</dd></div>
              <div><dt className="text-muted-foreground">Owner approval reference</dt><dd>{catalog.approvalRef || 'None'}</dd></div>
              <div className="sm:col-span-2 lg:col-span-4"><dt className="text-muted-foreground">Directory description</dt><dd>{catalog.publicDescription || 'None'}</dd></div>
            </dl> : null}
          </div>
          {catalog.error ? <div className="mt-3"><FeedbackBanner tone="error" role="alert"><strong>Latest issue:</strong> {syncIssueMessages[catalog.error] ?? 'The latest synchronization failed. Review the repository settings and retry.'}</FeedbackBanner></div> : null}
          {catalog.nextAttemptAt ? <p className="mt-2 text-sm text-muted-foreground">Next retry: {new Date(catalog.nextAttemptAt).toLocaleString()}</p> : null}
          <div id={settingsId} hidden={!editing}>
          {editing ? <form className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={event => void saveCatalog(event, catalog, new FormData(event.currentTarget))}>
            <input type="hidden" data-etag value={`"${new Date(catalog.updatedAt).toISOString()}"`} />
            <label className="grid gap-1 text-sm">GitHub owner<input name="owner" defaultValue={catalog.github.owner} required className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="grid gap-1 text-sm">Repository name<input name="name" defaultValue={catalog.github.name} required className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="grid gap-1 text-sm">GitHub installation ID<input name="installationId" inputMode="numeric" defaultValue={catalog.github.installationId} required className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="grid gap-1 text-sm">Branch<input name="branch" defaultValue={catalog.github.branch} required className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="grid gap-1 text-sm">Documentation folder<input name="docsPath" defaultValue={catalog.github.docsPath} required className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="grid gap-1 text-sm">Portal route slug<input name="slug" defaultValue={catalog.slug} required className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="grid gap-1 text-sm">Display title<input name="title" defaultValue={catalog.title} required className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="grid gap-1 text-sm">Repository type<select name="visibility" defaultValue={catalog.visibility} className="rounded-md border bg-background px-3 py-2">
              <option value="private">Private</option><option value="public">Public</option>
            </select></label>
            <label className="grid gap-1 text-sm">Required reader role<input name="readerRole" defaultValue={catalog.readerRole} required className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="grid gap-1 text-sm">Owner approval reference<input name="approvalRef" defaultValue={catalog.approvalRef ?? ''} className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={catalog.enabled} />Enabled</label>
            <label className="grid gap-1 text-sm sm:col-span-2 lg:col-span-3">Directory description<textarea name="publicDescription" defaultValue={catalog.publicDescription} rows={3} className="rounded-md border bg-background px-3 py-2" /></label>
            {formError ? <details className="rounded-md sm:col-span-2 lg:col-span-3"><summary className="cursor-pointer text-sm text-red-800 dark:text-red-300">Settings could not be saved. Expand for details.</summary><div className="mt-2"><FeedbackBanner tone="error" role="alert">{formError}</FeedbackBanner></div></details> : null}
            <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
              <button type="submit" disabled={busy || !token} className="inline-flex items-center gap-2 rounded-md border border-secondary bg-transparent px-3 py-2 text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"><Icon name="save" />Save</button>
              <button type="button" disabled={busy} onClick={() => setEditingId(null)} className="inline-flex items-center gap-2 rounded-md border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"><Icon name="cancel" />Cancel</button>
            </div>
            {!catalog.enabled || catalog.accessState !== 'ready' ? <p className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-3" role="note">Sync requires this repository to be enabled and GitHub App access to be ready.</p> : null}
          </form> : null}
          </div>
          <div className="mt-4" style={{ display: 'flex', justifyContent: 'flex-start' }}><SyncStatusBadge status={catalog.status} /></div>
        </article>;
        })}
      </div>
    </section>
  </main>;
}
