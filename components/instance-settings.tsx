'use client';

import { useEffect, useRef, useState } from 'react';
import type { instanceSnapshot } from '@/lib/instance/store';
import { signIn } from 'next-auth/react';

type Snapshot = ReturnType<typeof instanceSnapshot> & {
  csrfToken?: string; bindingKind?: string; previousVersion?: number | null;
  impact?: { categories: string[]; confirmationNonce: string } | null; rollbackNonce?: string | null; ownerProofId?: string | null;
  runtimeCallbackUrl?: string; candidateCallbackUrl?: string; webhookUrl?: string;
};
type Audit = { events: { id: string; at: string; operation: string; actor: string; resultCode: string }[]; nextCursor: string | null };
const fields = 'rounded-md border bg-background px-3 py-2';
const button = 'rounded-md border px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const secretLabels = { zitadelClientSecret: 'Zitadel client secret', githubPrivateKey: 'GitHub App private key', githubWebhookSecret: 'Webhook signing secret' };

export function InstanceSettings() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);

  async function refresh() {
    const response = await fetch('/api/instance/settings', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? 'Settings could not be loaded.');
    setSnapshot(data); setDirty(false); form.current?.reset();
  }
  useEffect(() => { let active = true;
    fetch('/api/instance/settings', { cache: 'no-store' }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Settings could not be loaded.');
      if (active) setSnapshot(data);
    }).catch(() => { if (active) setError('Settings could not be loaded. Refresh to try again.'); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const navigate = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('a[href]') && !window.confirm('Discard unsaved settings?')) event.preventDefault();
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true); };
  }, [dirty]);

  async function run(operation: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : 'The request failed.'); }
    finally { setBusy(false); feedback.current?.focus(); }
  }
  async function mutation(path: string, body: unknown, method = 'POST') {
    const response = await fetch(`/api/instance/settings${path}`, { method, headers: {
      'Content-Type': 'application/json', 'X-CSRF-Token': snapshot?.csrfToken ?? '', 'If-Match': `"${snapshot?.editRevision}"`,
    }, body: JSON.stringify(body), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 409 ? 'The configuration changed or needs verification. Refresh and review before trying again.' : data.error?.message ?? 'The request failed.');
    return { response, data };
  }
  const bundle = snapshot?.candidate ?? snapshot?.active;
  if (!snapshot || !bundle) return <p role={error ? 'alert' : 'status'} className="mt-5">{error || 'Loading instance settings…'}</p>;
  const input = (name: string, label: string, value: string, type = 'text') => <label className="grid gap-1 text-sm">{label}<input name={name} type={type} defaultValue={value} required className={fields} /></label>;

  return <div className="mt-6 space-y-6" aria-busy={busy}>
    <p>Active revision {snapshot.activeVersion}. {snapshot.candidate ? `Saved draft ${snapshot.candidateVersion} has not been activated.` : 'No saved draft.'}</p>
    <p ref={feedback} tabIndex={-1} role={error ? 'alert' : 'status'}>{error || message}</p>
    <form ref={form} key={`${snapshot.editRevision}`} onChange={() => setDirty(true)} onSubmit={event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const get = (name: string) => String(values.get(name) ?? '');
      const secretReplacements: Record<string, { action: 'replace'; value: string }> = {};
      for (const key of Object.keys(secretLabels)) if (values.has(`replace-${key}`)) {
        if (!get(key)) { setError('Enter a nonempty value for each selected replacement.'); return; }
        secretReplacements[key] = { action: 'replace', value: get(key) };
      }
      void run(async () => {
        const { data } = await mutation('', { candidateVersion: snapshot.candidateVersion ?? 0,
          changes: { displayName: get('displayName'), description: get('description'), defaultDocsFolder: get('docsFolder'), publicOrigin: get('publicOrigin'),
            zitadel: { issuer: get('issuer'), clientId: get('clientId'), projectId: get('projectId'), apiAudience: get('audience') }, github: { appId: get('appId') } }, secretReplacements }, 'PATCH');
        setSnapshot(current => ({ ...current, ...data })); setDirty(false); form.current?.reset(); setMessage('Draft saved. Active settings have not changed.');
      });
    }} className="space-y-6">
      <fieldset disabled={busy} className="grid gap-4 rounded-lg border p-5"><legend className="px-2 font-semibold">General</legend>
        {input('displayName', 'Display name', bundle.preferences.displayName)}
        <label className="grid gap-1 text-sm">Description<textarea name="description" defaultValue={bundle.preferences.description} maxLength={500} className={fields} /></label>
        {input('publicOrigin', 'Public origin', bundle.publicOrigin, 'url')}
      </fieldset>
      <fieldset disabled={busy} className="grid gap-4 rounded-lg border p-5"><legend className="px-2 font-semibold">Authentication</legend>
        {input('issuer', 'Zitadel issuer', bundle.zitadel.issuer, 'url')}{input('clientId', 'Client ID', bundle.zitadel.clientId)}
        {input('projectId', 'Project ID', bundle.zitadel.projectId)}{input('audience', 'API audience', bundle.zitadel.audience)}
        <p className="break-all text-sm">Runtime callback: {snapshot.runtimeCallbackUrl}<br />Candidate callback: {snapshot.candidateCallbackUrl}</p>
      </fieldset>
      <fieldset disabled={busy} className="grid gap-4 rounded-lg border p-5"><legend className="px-2 font-semibold">GitHub Integration</legend>
        {input('appId', 'GitHub App ID', bundle.github.appId)}<p className="break-all text-sm">Webhook: {snapshot.webhookUrl}</p>
      </fieldset>
      <fieldset disabled={busy} className="grid gap-4 rounded-lg border p-5"><legend className="px-2 font-semibold">Documentation</legend>
        {input('docsFolder', 'Default documentation folder', bundle.preferences.docsFolder)}<p className="text-sm">Applies to new catalogs. Existing catalogs retain their own folder, roles and visibility.</p>
      </fieldset>
      <fieldset disabled={busy} className="grid gap-4 rounded-lg border p-5"><legend className="px-2 font-semibold">Security</legend>
        <p className="text-sm">Your instance binding: {snapshot.bindingKind}. Credentials are replaced explicitly and are never revealed. Blank fields retain stored credentials.</p>
        {Object.entries(secretLabels).map(([key, label]) => <div key={key} className="grid gap-2">
          <label><input type="checkbox" name={`replace-${key}`} /> Replace {label} ({bundle.secrets[key as keyof typeof secretLabels].configured ? 'configured' : 'missing'})</label>
          <label className="grid gap-1 text-sm">New {label}<input type="password" name={key} autoComplete="new-password" className={fields} /></label>
        </div>)}
      </fieldset>
      <div className="flex flex-wrap gap-3"><button disabled={busy || !dirty} className={button}>Save draft</button>
        <button type="button" disabled={busy || !dirty} className={button} onClick={() => { form.current?.reset(); setDirty(false); setError(''); setMessage('Unsaved changes discarded.'); }}>Cancel</button>
        <button type="button" disabled={busy} className={button} onClick={() => { if (!dirty || window.confirm('Discard unsaved settings?')) void run(refresh); }}>Refresh</button></div>
    </form>
    <section className="space-y-3 rounded-lg border p-5"><h2 className="font-semibold">Checks and activation</h2>
      <p className="text-sm">Save before testing. Each edit invalidates checks and owner proof. Provider and origin changes require current owner verification.</p>
      <div className="flex flex-wrap gap-2">{(['database', 'zitadel_discovery', 'zitadel_owner_login', 'github_structure', 'github_authentication', 'github_permissions', 'github_installation', 'github_webhook'] as const).map(type => <button key={type} className={button} disabled={busy || dirty || !snapshot.candidate} onClick={() => void run(async () => {
        const { data } = await mutation('/check', { candidateVersion: snapshot.candidateVersion, type }); await refresh(); setMessage(`${type}: ${data.status} (${data.code}).`);
      })}>{type.replaceAll('_', ' ')}</button>)}</div>
      <ul className="text-sm">{bundle.checks.map(check => <li key={check.type}>{check.type}: {check.status} ({check.code})</li>)}</ul>
      <p className="text-sm">Impact: {snapshot.impact?.categories.join(', ') || 'None'}. Root keys, database, storage, proxy and outbound policy require a protected host operator and restart.</p>
      {snapshot.bindingKind === 'owner' && snapshot.candidate ? <button className={button} disabled={busy || dirty} onClick={() => void run(async () => {
        await signIn('zitadel', { redirectTo: '/instance/settings' }, { prompt: 'login' });
      })}>Verify candidate owner</button> : null}
      {snapshot.ownerProofId ? <p className="text-sm">Verified target proof ID for a protected ownership transfer: <code>{snapshot.ownerProofId}</code>. The host operator must use the current control revision.</p> : null}
      <div className="flex flex-wrap gap-3"><button className={button} disabled={busy || dirty || !snapshot.candidate || !snapshot.impact} onClick={() => {
        if (window.confirm('Activate this exact saved draft? Identity changes invalidate existing sessions. Webhook changes require sender configuration and manual resync.')) void run(async () => {
          const { response, data } = await mutation('/activate', { candidateVersion: snapshot.candidateVersion, confirmationNonce: snapshot.impact!.confirmationNonce, confirm: true });
          setMessage(response.status === 202 ? 'Activation is pending. Check instance health, then refresh. Maintenance requires a host operator if reconciliation fails.' : 'The configuration is active. Sign in again if your identity boundary changed.');
          if (response.status === 200) setSnapshot(current => ({ ...current, ...data }));
        });
      }}>Activate saved draft</button>
      {snapshot.previousVersion ? <button className={button} disabled={busy || dirty || snapshot.bindingKind !== 'owner'} onClick={() => {
        if (window.confirm('Prepare a rollback draft? It must pass checks and activation before taking effect.')) void run(async () => {
          await mutation('/rollback', { previousVersion: snapshot.previousVersion, confirmationNonce: snapshot.rollbackNonce, confirm: true }); await refresh(); setMessage('Rollback draft saved. Verify the owner and providers before activation.');
        });
      }}>Prepare rollback</button> : null}</div>
    </section>
    <section className="space-y-3 rounded-lg border p-5"><h2 className="font-semibold">System and audit</h2>
      <p className="text-sm">Librarian v2 · {snapshot.state} · edit revision {snapshot.editRevision}. Host secrets and filesystem locations are not browser-managed.</p>
      <button className={button} disabled={busy} onClick={() => void run(async () => {
        const response = await fetch(`/api/instance/audit?limit=20${audit?.nextCursor ? `&cursor=${encodeURIComponent(audit.nextCursor)}` : ''}`, { cache: 'no-store' });
        const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? 'Audit unavailable.'); setAudit(data);
      })}>{audit?.nextCursor ? 'Next audit page' : 'Load audit'}</button>
      <ul className="space-y-2 text-sm">{audit?.events.map(event => <li key={event.id}>{event.at} · {event.operation} · {event.resultCode}</li>)}</ul>
    </section>
  </div>;
}
