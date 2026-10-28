'use client';

import { useEffect, useRef, useState } from 'react';
import type { instanceSnapshot } from '@/lib/instance/store';
import { signIn } from 'next-auth/react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from 'fumadocs-ui/components/ui/tabs';
import styles from './instance-settings.module.css';

type Snapshot = ReturnType<typeof instanceSnapshot> & {
  csrfToken?: string; bindingKind?: string; previousVersion?: number | null;
  impact?: { categories: string[]; confirmationNonce: string } | null; rollbackNonce?: string | null; ownerProofId?: string | null;
  runtimeCallbackUrl?: string; candidateCallbackUrl?: string; webhookUrl?: string;
};
type Audit = { events: { id: string; at: string; operation: string; actor: string; resultCode: string }[]; nextCursor: string | null };
const fields = styles.input;
const button = styles.button;
const secretLabels = { zitadelClientSecret: 'Zitadel client secret', githubPrivateKey: 'GitHub App private key', githubWebhookSecret: 'Webhook signing secret' };

export function InstanceSettings() {
  const [section, setSection] = useState('runtime');
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
  useEffect(() => { if (error || message) feedback.current?.focus(); }, [error, message]);
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
    finally { setBusy(false); }
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

  return <Tabs value={section} onValueChange={setSection} className={styles.settings} aria-busy={busy}>
    <div className={styles.overview}><div><h2>Configuration</h2><p>Manage this instance’s providers, credentials and documentation defaults.</p></div>
      <span className={styles.badge}>{snapshot.candidate ? 'Draft saved' : 'Up to date'} · v{snapshot.activeVersion}</span></div>
    <TabsList className={styles.tabList} aria-label="Settings sections">
      {Object.entries({ auth: 'Auth', zitadel: 'Zitadel', mongodb: 'MongoDB', githubApp: 'GitHub App', githubWebhook: 'GitHub webhook', runtime: 'Runtime and documentation', host: 'Host prerequisites', validation: 'Validation', audit: 'Audit' }).map(([value, label]) => <TabsTrigger key={value} value={value} className={styles.tab}>{label}</TabsTrigger>)}
    </TabsList>
    <p className={styles.feedback} ref={feedback} tabIndex={-1} role={error ? 'alert' : 'status'}>{error || message}</p>
    <form onInvalid={event => {
      const target = event.target as HTMLInputElement;
      const panel = target.closest<HTMLElement>('[data-section]');
      if (panel?.dataset.section) setSection(panel.dataset.section);
      setError('Check the highlighted field before saving.');
      requestAnimationFrame(() => target.focus());
    }} ref={form} key={`${snapshot.editRevision}`} onChange={() => setDirty(true)} onSubmit={event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const get = (name: string) => String(values.get(name) ?? '');
      const secretReplacements: Record<string, { action: 'replace'; value: string }> = {};
      for (const key of Object.keys(secretLabels)) if (values.has(`replace-${key}`)) {
        if (!get(key)) { setError('Enter a nonempty value for each selected replacement.'); return; }
        secretReplacements[key] = { action: 'replace', value: get(key) };
      }
      if (values.has('replace-database') && !get('mongodbUri')) { setError('Enter a connection URI when replacing the database connection.'); return; }
      const database = snapshot.bindingKind === 'owner' ? { ...(values.has('replace-database') ? { mongodbUri: get('mongodbUri') } : {}),
        ...(get('mongodbDatabase') !== bundle.runtime?.mongodbDatabase ? { mongodbDatabase: get('mongodbDatabase') } : {}) } : {};
      void run(async () => {
        const { data } = await mutation('', { candidateVersion: snapshot.candidateVersion ?? 0,
          changes: { ...(Object.keys(database).length ? { database } : {}), displayName: get('displayName'), description: get('description'), defaultDocsFolder: get('docsFolder'), publicOrigin: get('publicOrigin'),
            zitadel: { issuer: get('issuer'), clientId: get('clientId'), projectId: get('projectId'), apiAudience: get('audience') }, github: { appId: get('appId'), webhookUrl: get('webhookUrl') } }, secretReplacements }, 'PATCH');
        setSnapshot(current => ({ ...current, ...data })); setDirty(false); form.current?.reset(); setMessage('Draft saved. Active settings have not changed.');
      });
    }} className="space-y-6">
      <TabsContent data-section="auth" value="auth" forceMount hidden={section !== 'auth'} className={styles.panel}>
      <fieldset className={styles.group}><legend className={styles.legend}>Auth</legend>
        <p>Auth.js session secret: {bundle.runtime?.authSecretConfigured ? 'configured' : 'missing'}. OAuth token encryption key: {bundle.runtime?.oauthTokenEncryptionKeyConfigured ? 'configured' : 'missing'}. Credentials are never returned or editable here.</p>
      </fieldset>
      </TabsContent>
      <TabsContent data-section="zitadel" value="zitadel" forceMount hidden={section !== 'zitadel'} className={styles.panel}>
      <fieldset disabled={busy} className={styles.group}><legend className={styles.legend}>Zitadel</legend>
        {input('issuer', 'Zitadel issuer', bundle.zitadel.issuer, 'url')}{input('clientId', 'Client ID', bundle.zitadel.clientId)}
        {input('projectId', 'Project ID', bundle.zitadel.projectId)}{input('audience', 'API audience', bundle.zitadel.audience)}
        <p>Client secret: {bundle.secrets.zitadelClientSecret.configured ? 'configured' : 'missing'}. Leave the replacement blank to keep the saved credential.</p>
        <label><input type="checkbox" name="replace-zitadelClientSecret" /> Replace Zitadel client secret</label>
        <label className="grid gap-1 text-sm">New Zitadel client secret<input name="zitadelClientSecret" type="password" autoComplete="new-password" className={fields} /></label>
        <p className="break-all text-sm">Runtime callback: {snapshot.runtimeCallbackUrl}<br />Candidate callback: {snapshot.candidateCallbackUrl}</p>
      </fieldset>
      </TabsContent>
      <TabsContent data-section="mongodb" value="mongodb" forceMount hidden={section !== 'mongodb'} className={styles.panel}>
        <fieldset disabled={busy || snapshot.bindingKind !== 'owner'} className={styles.group}>
          <legend className={styles.legend}>MongoDB connection</legend>
          <p>Update the connection to this instance’s existing database. Librarian verifies the target before activation and updates its protected startup locator with the encrypted settings.</p>
          {input('mongodbDatabase', 'Database name', bundle.runtime?.mongodbDatabase ?? '')}
          <label><input type="checkbox" name="replace-database" /> Replace the stored connection URI</label>
          <label>MongoDB connection URI<input name="mongodbUri" type="password" autoComplete="off" spellCheck={false} placeholder="Leave blank to retain the stored connection" className={fields} /></label>
          <p>Connection URI: {bundle.runtime?.mongodbUriConfigured ? 'configured' : 'not imported'}. Credentials are never revealed. Only the instance owner can change the database connection.</p>
          <p>Save a draft, then run the Database connection check under Validation. This does not copy data into another database.</p>
        </fieldset>
      </TabsContent>
      <TabsContent data-section="githubApp" value="githubApp" forceMount hidden={section !== 'githubApp'} className={styles.panel}>
      <fieldset disabled={busy} className={styles.group}><legend className={styles.legend}>GitHub App</legend>
        {input('appId', 'GitHub App ID', bundle.github.appId)}
        <p>Private key: {bundle.secrets.githubPrivateKey.configured ? 'configured' : 'missing'}. Leave the replacement blank to keep the saved credential.</p>
        <label><input type="checkbox" name="replace-githubPrivateKey" /> Replace GitHub App private key</label>
        <label className="grid gap-1 text-sm">New GitHub App private key<textarea name="githubPrivateKey" autoComplete="off" rows={5} className={fields} /></label>
      </fieldset>
      </TabsContent>
      <TabsContent data-section="githubWebhook" value="githubWebhook" forceMount hidden={section !== 'githubWebhook'} className={styles.panel}>
      <fieldset disabled={busy} className={styles.group}><legend className={styles.legend}>GitHub webhook</legend>
        {input('webhookUrl', 'Webhook URL', bundle.github.webhookUrl ?? snapshot.webhookUrl ?? new URL('/api/webhooks/github', bundle.publicOrigin).href, 'url')}
        <p className={styles.hint}>The public address GitHub sends events to. Point it at this instance’s receiver, then update the GitHub App configuration to match.</p>
        <p>Signing secret: {bundle.secrets.githubWebhookSecret.configured ? 'configured' : 'missing'}. Leave the replacement blank to keep the saved credential.</p>
        <label><input type="checkbox" name="replace-githubWebhookSecret" /> Replace GitHub webhook signing secret</label>
        <label className="grid gap-1 text-sm">New GitHub webhook signing secret<input name="githubWebhookSecret" type="password" autoComplete="new-password" className={fields} /></label>
      </fieldset>
      </TabsContent>
      <TabsContent data-section="runtime" value="runtime" forceMount hidden={section !== 'runtime'} className={styles.panel}>
      <fieldset disabled={busy} className={styles.group}><legend className={styles.legend}>Runtime and documentation</legend>
        {input('displayName', 'Display name', bundle.preferences.displayName)}
        <label className="grid gap-1 text-sm">Description<textarea name="description" defaultValue={bundle.preferences.description} maxLength={500} className={fields} /></label>
        {input('publicOrigin', 'Public origin', bundle.publicOrigin, 'url')}
        {input('docsFolder', 'Default documentation folder', bundle.preferences.docsFolder)}
        <p>Trust forwarded host: {bundle.runtime?.trustHost ? 'enabled' : 'disabled'}. Background worker: {bundle.runtime?.workerEnabled ? 'enabled' : 'disabled'}.</p>
        <p>Documentation defaults apply to new catalogs. Existing catalogs keep their own folder, roles and visibility.</p>
      </fieldset>
      </TabsContent>
      <TabsContent data-section="host" value="host" forceMount hidden={section !== 'host'} className={styles.panel}>
      <fieldset className={styles.group}><legend className={styles.legend}>Host prerequisites</legend>
        <p>Instance binding: {snapshot.bindingKind}. The MongoDB startup locator, encryption keyring, operator authority, content root, outbound policy and publication approvals remain host-managed.</p>
        <p>Host file locations and root credentials are not returned to the browser. Changes require the host operator and a restart where indicated.</p>
      </fieldset>
      </TabsContent>
      <div className={styles.actions} hidden={['validation', 'audit'].includes(section)}><button disabled={busy || !dirty} className={button}>Save draft</button>
        <button type="button" disabled={busy || !dirty} className={button} onClick={() => { form.current?.reset(); setDirty(false); setError(''); setMessage('Unsaved changes discarded.'); }}>Cancel</button>
        <button type="button" disabled={busy} className={button} onClick={() => { if (!dirty || window.confirm('Discard unsaved settings?')) void run(refresh); }}>Refresh</button></div>
    </form>
    <TabsContent data-section="validation" value="validation" forceMount hidden={section !== 'validation'} className={styles.panel}><section className={styles.group}><h2>Validation and activation</h2>
      <p className={styles.hint}>{dirty ? 'Save your changes before running checks.' : snapshot.candidate ? 'Check the saved draft, then activate it when you are ready.' : 'Your active configuration is shown below. Save a draft to enable validation and activation.'}</p>
      <p className="text-sm">Save before testing. Each edit invalidates checks and owner proof. Provider and origin changes require current owner verification.</p>
      <div className={styles.checkList}>{Object.entries({ database: 'Database connection', zitadel_discovery: 'Zitadel discovery', zitadel_owner_login: 'Owner sign-in', github_structure: 'Private key format', github_authentication: 'GitHub authentication', github_permissions: 'GitHub permissions', github_installation: 'GitHub installation', github_webhook: 'Webhook delivery' }).map(([type, label]) => {
        const check = bundle.checks.find(item => item.type === type);
        return <div className={styles.checkRow} key={type}><div><span>{label}</span><small>{check?.code.replaceAll('_', ' ') ?? 'Not checked'}</small></div>
          <span className={styles.badge} data-status={check?.status}>{check?.status === 'passed' ? 'Passed' : check?.status === 'warning' ? 'Warning' : check?.status === 'failed' ? 'Failed' : 'Not run'}</span>
          <button type="button" aria-label={'Run ' + label.toLowerCase() + ' check'} className={button} disabled={busy || dirty || !snapshot.candidate} onClick={() => void run(async () => {
            const { data } = await mutation('/check', { candidateVersion: snapshot.candidateVersion, type }); await refresh(); setMessage(label + ': ' + data.status + ' (' + data.code + ').');
          })}>Run check</button></div>;
      })}</div>
      <p className="text-sm">Impact: {snapshot.impact?.categories.join(', ') || 'None'}. Network routing, root keys and storage changes may require a host operator. Database connection changes must pass validation before activation.</p>
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
    </section></TabsContent>
    <TabsContent data-section="audit" value="audit" forceMount hidden={section !== 'audit'} className={styles.panel}><section className={styles.group}><h2>System and audit</h2>
      <p className="text-sm">Librarian v2 · {snapshot.state} · edit revision {snapshot.editRevision}. Host secrets and filesystem locations are not browser-managed.</p>
      <button className={button} disabled={busy} onClick={() => void run(async () => {
        const response = await fetch(`/api/instance/audit?limit=20${audit?.nextCursor ? `&cursor=${encodeURIComponent(audit.nextCursor)}` : ''}`, { cache: 'no-store' });
        const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? 'Audit unavailable.'); setAudit(data);
      })}>{audit?.nextCursor ? 'Next audit page' : 'Load audit'}</button>
      <ul className="space-y-2 text-sm">{audit?.events.map(event => <li key={event.id}>{event.at} · {event.operation} · {event.resultCode}</li>)}</ul>
    </section></TabsContent>
  </Tabs>;
}
