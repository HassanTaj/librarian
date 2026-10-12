'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AccountControls } from '@/components/private-content-guard';
import { SyncStatusBadge } from '@/components/sync-status-badge';

type CatalogRow = {
  id: string; revision: number; updatedAt: string; github: { owner: string; name: string; branch: string; docsPath: string; installationId: number; repositoryId: number };
  slug: string; title: string; publicDescription: string; visibility: 'public' | 'private'; readerRole: string;
  approvalRef: string | null;
  enabled: boolean; accessState: string; status: 'pending' | 'running' | 'succeeded' | 'failed'; error: string | null;
  nextAttemptAt?: string | null; publishedCommit: string | null; lastSuccessAt: string | null;
};

const syncIssueMessages: Record<string, string> = {
  github_invalid_content: 'The documentation folder contains unsupported or oversized content. Use Markdown files and check the sync limits.',
  github_access_denied: 'The GitHub App cannot read this repository. Check its installation and Contents read access.',
  github_docs_missing: 'The configured documentation folder was not found on this branch. Check the branch and folder values.',
  access_lost: 'The GitHub App no longer has access to this repository. Update its installation, then retry.',
};

async function responseError(response: Response) {
  const value = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return value?.error?.message ?? 'The request could not be completed.';
}

export function AdminConsole() {
  const [catalogs, setCatalogs] = useState<CatalogRow[]>([]);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ owner: '', name: '', installationId: '', branch: 'main', docsPath: 'docs', slug: '', title: '', publicDescription: '', readerRole: '', visibility: 'private' as 'public' | 'private', approvalRef: '' });

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
    } catch (caught) { setCatalogs([]); setToken(''); setError(caught instanceof Error ? caught.message : 'Administration is unavailable.'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    const timer = setTimeout(() => { void reload(); }, 0);
    return () => clearTimeout(timer);
  }, []);

  async function createCatalog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/repos', { method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ github: { owner: draft.owner, name: draft.name, branch: draft.branch, docsPath: draft.docsPath,
          installationId: Number(draft.installationId) }, slug: draft.slug, title: draft.title,
          publicDescription: draft.publicDescription, visibility: draft.visibility,
          ...(draft.readerRole ? { readerRole: draft.readerRole } : {}),
          ...(draft.visibility === 'public' ? { approvalRef: draft.approvalRef } : {}) }) });
      if (!response.ok) throw new Error(await responseError(response));
      setNotice(`${draft.visibility === 'public' ? 'Public' : 'Private'} catalog saved. Queue its first synchronization when ready.`);
      setDraft({ owner: '', name: '', installationId: '', branch: 'main', docsPath: 'docs', slug: '', title: '', publicDescription: '', readerRole: '', visibility: 'private', approvalRef: '' });
      await reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The catalog could not be saved.'); }
    finally { setBusy(false); }
  }

  async function saveCatalog(event: FormEvent<HTMLFormElement>, catalog: CatalogRow, form: FormData) {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The catalog could not be saved.'); }
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
      setNotice('Repository removed.');
      await reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The repository could not be removed.'); }
    finally { setBusy(false); }
  }

  async function synchronize(catalog: CatalogRow) {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/repos/${catalog.id}/sync`, { method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-csrf-token': token }, body: '{}' });
      if (!response.ok) throw new Error(await responseError(response));
      setNotice('Synchronization request was durably accepted.');
      await reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Synchronization could not be queued.'); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-sm text-muted-foreground">Perspective V / Docs</p><h1 className="mt-2 text-3xl font-semibold">Administration</h1>
        <p className="mt-2 text-muted-foreground">Configure repository sources and review synchronization status.</p></div>
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/" className="inline-flex min-h-10 items-center rounded-md border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Back to home</Link>
        <AccountControls />
        <button type="button" onClick={() => void reload()} disabled={busy} className="rounded-md border border-secondary bg-transparent px-3 py-2 text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">Refresh status</button>
      </div>
    </div>
    {error ? <p className="mt-5 rounded-md border border-destructive/40 p-3 text-destructive" role="alert">{error}</p> : null}
    {notice ? <p className="mt-5 rounded-md border p-3" role="status">{notice}</p> : null}
    <section className="mt-8 rounded-xl border p-5" aria-labelledby="new-catalog-title">
      <h2 id="new-catalog-title" className="text-xl font-semibold">Add a repository</h2>
      <p className="mt-2 text-sm text-muted-foreground">The selected GitHub App installation is checked before saving. Public catalogs also require a matching owner approval reference.</p>
      <form onSubmit={createCatalog} className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {([['owner', 'GitHub owner'], ['name', 'Repository name'], ['installationId', 'GitHub installation ID'], ['branch', 'Branch'], ['docsPath', 'Documentation folder'], ['slug', 'Portal route slug'], ['title', 'Display title'], ['publicDescription', 'Directory description'], ['readerRole', 'Required reader role']] as const).map(([key, label]) =>
          <label key={key} className="grid gap-1 text-sm font-medium">{label}<input required={key !== 'publicDescription' && key !== 'readerRole'} inputMode={key === 'installationId' ? 'numeric' : undefined}
            value={draft[key]} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))}
            className="rounded-md border bg-background px-3 py-2 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>)}
        <label className="grid gap-1 text-sm font-medium">Repository type<select value={draft.visibility} onChange={event => setDraft(previous => ({ ...previous, visibility: event.target.value as 'public' | 'private' }))} className="rounded-md border bg-background px-3 py-2 font-normal"><option value="private">Private</option><option value="public">Public</option></select></label>
        {draft.visibility === 'public' ? <label className="grid gap-1 text-sm font-medium">Owner approval reference<input required value={draft.approvalRef} onChange={event => setDraft(previous => ({ ...previous, approvalRef: event.target.value }))} className="rounded-md border bg-background px-3 py-2 font-normal" /></label> : null}
        <div className="sm:col-span-2 lg:col-span-3"><button type="submit" disabled={busy || !token} className="rounded-md border border-primary bg-transparent px-4 py-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">Save repository</button></div>
      </form>
    </section>
    <section className="mt-8" aria-labelledby="catalogs-title">
      <h2 id="catalogs-title" className="text-xl font-semibold">Configured repositories</h2>
      {loading ? <p className="mt-4" role="status">Loading administration…</p> : null}
      {!loading && catalogs.length === 0 ? <p className="mt-4 text-muted-foreground">No repositories are configured.</p> : null}
      <div className="mt-4 grid gap-4">
        {catalogs.map(catalog => {
          const editing = editingId === catalog.id;
          const settingsId = `catalog-settings-${catalog.id}`;
          return <article key={catalog.id} className="rounded-xl border p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="text-lg font-semibold">{catalog.title}</h3><p className="mt-1 text-sm text-muted-foreground">{catalog.github.owner}/{catalog.github.name} · {catalog.github.branch}/{catalog.github.docsPath} · /{catalog.slug}</p></div>
            <div className="flex flex-wrap items-center gap-2">
              <SyncStatusBadge status={catalog.status} />
              <button type="button" disabled={busy} onClick={() => setEditingId(editing ? null : catalog.id)} aria-expanded={editing} aria-controls={settingsId} className="rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">{editing ? 'Cancel edit' : 'Edit'}</button>
              <button type="button" disabled={busy || !token} onClick={() => void removeCatalog(catalog)} className="rounded-md border border-destructive/60 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">Delete</button>
              <button type="button" disabled={busy || !token || !catalog.enabled || catalog.accessState !== 'ready'} onClick={() => void synchronize(catalog)} className="rounded-md border border-primary bg-transparent px-3 py-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">Sync now</button>
            </div>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-muted-foreground">Repository type</dt><dd>{catalog.visibility === 'private' ? 'Private' : 'Public'}</dd></div>
            <div><dt className="text-muted-foreground">Enabled</dt><dd>{catalog.enabled ? 'Yes' : 'No'}</dd></div>
            <div><dt className="text-muted-foreground">Published commit</dt><dd>{catalog.publishedCommit ?? 'No successful sync'}</dd></div>
            <div><dt className="text-muted-foreground">Last successful sync</dt><dd>{catalog.lastSuccessAt ? new Date(catalog.lastSuccessAt).toLocaleString() : 'Never'}</dd></div>
          </dl>
          {catalog.error ? <p className="mt-3 text-sm text-destructive" role="status">Latest issue: {syncIssueMessages[catalog.error] ?? 'The latest synchronization failed. Review the repository settings and retry.'}</p> : null}
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
            <label className="grid gap-1 text-sm">Directory description<input name="publicDescription" defaultValue={catalog.publicDescription} className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="grid gap-1 text-sm">Required reader role<input name="readerRole" defaultValue={catalog.readerRole} required className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="grid gap-1 text-sm">Repository type<select name="visibility" defaultValue={catalog.visibility} className="rounded-md border bg-background px-3 py-2">
              <option value="private">Private</option><option value="public">Public</option>
            </select></label>
            <label className="grid gap-1 text-sm">Owner approval reference<input name="approvalRef" defaultValue={catalog.approvalRef ?? ''} className="rounded-md border bg-background px-3 py-2" /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={catalog.enabled} />Enabled</label>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <button disabled={busy || !token} className="rounded-md border border-secondary bg-transparent px-3 py-2 text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">Save settings</button>
              <button type="button" disabled={busy} onClick={() => setEditingId(null)} className="rounded-md border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">Cancel edit</button>
            </div>
            {!catalog.enabled || catalog.accessState !== 'ready' ? <p className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-3" role="note">Sync requires this repository to be enabled and GitHub App access to be ready.</p> : null}
          </form> : null}
          </div>
        </article>;
        })}
      </div>
    </section>
  </main>;
}
