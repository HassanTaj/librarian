'use client';

import { useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';

const steps = ['Welcome', 'Database', 'Zitadel', 'GitHub App', 'Preferences', 'Owner verification', 'Review'];
const requiredChecks = ['database', 'zitadel_discovery', 'github_structure', 'github_authentication', 'github_permissions', 'github_installation', 'github_webhook'] as const;
type CheckType = typeof requiredChecks[number];
type Check = { type: string; candidateVersion: number; status: 'not_run' | 'passed' | 'failed' | 'warning'; code: string; at?: string };
type Candidate = {
  version: number;
  preferences: { displayName: string; description: string; docsFolder: string };
  publicOrigin: string;
  zitadel: { issuer: string; clientId: string; projectId: string; audience: string };
  github: { appId: string; webhookUrl?: string };
  checks: Check[];
  ownerVerified: boolean;
  impact: { confirmationNonce: string } | null;
  secrets: Record<string, { configured: boolean; updatedAt: string | null }>;
};
type Snapshot = { state: string; expiresAt: string; editRevision: number; candidateVersion: number; candidate: Candidate;
  runtimeCallbackUrl: string; candidateCallbackUrl: string; webhookUrl: string };

async function body(response: Response) {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

function cookie(name: string) {
  return document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

function errorMessage(value: Record<string, unknown> | null) {
  const error = value?.error;
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : 'The request could not be completed. Check the connection and try again.';
}

function checksReady(candidate: Candidate) {
  return requiredChecks.every(type => {
    const result = candidate.checks.find(item => item.type === type && item.candidateVersion === candidate.version);
    return result?.status === 'passed' || (type === 'github_installation' && result?.status === 'warning' && result.code === 'installation_missing') ||
      (type === 'github_webhook' && result?.status === 'warning' && result.code === 'delivery_unverified');
  });
}

export function InstanceLegacyEnrollment() {
  const router = useRouter();
  const [credential, setCredential] = useState('');
  const [review, setReview] = useState<{ confirmationNonce: string; editRevision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const csrf = useRef('');
  async function submit() {
    setBusy(true); setError('');
    try {
      const csrfResponse = await fetch('/api/admin/csrf', { cache: 'no-store' });
      const current = await csrfResponse.json();
      if (!csrfResponse.ok) throw new Error('Current administrator authorization is required.');
      csrf.current = current.csrfToken;
      const response = await fetch(`/api/instance/migration${review ? '' : '/authorize'}`, { method: 'POST', cache: 'no-store', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': csrf.current, ...(review ? { 'If-Match': `"${review.editRevision}"` } : {}),
      }, body: JSON.stringify(review ? { confirmImport: true, confirmationNonce: review.confirmationNonce } : { credential }) });
      setCredential('');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Enrollment could not be completed.');
      if (review) router.refresh();
      else setReview(data);
    } catch (error) { setError(error instanceof Error ? error.message : 'Enrollment failed.'); }
    finally { setBusy(false); }
  }
  return <section className="mt-6 space-y-4 rounded-lg border p-5" aria-busy={busy}>
    <p>Import the current legacy provider settings into encrypted instance storage. Existing catalogs, accounts, jobs, receipts and snapshots remain in place. Activation follows provider checks and explicit confirmation.</p>
    <p>Before enrollment, the host operator must stop all unmodified v1 processes and prepare the enrollment authority. Keep the previous configuration and a consistent database/content backup.</p>
    {error ? <p role="alert">{error}</p> : null}
    <form onSubmit={event => { event.preventDefault(); void submit(); }} className="grid gap-4">
      {!review ? <label className="grid gap-1">Protected enrollment credential<input required type="password" autoComplete="off" value={credential} onChange={event => setCredential(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label> : <p>Authorization verified. Confirm importing the exact reviewed legacy configuration. A changed configuration will be rejected.</p>}
      <button disabled={busy} className="rounded-md border px-3 py-2 disabled:opacity-50">{review ? 'Confirm legacy import' : 'Authorize enrollment'}</button>
    </form>
  </section>;
}

export function InstanceRecovery() {
  const [credential, setCredential] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [proof, setProof] = useState<{ recoveryProofId: string | null; recoveryControlRevision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refreshProof() {
    const response = await fetch('/api/instance/setup', { cache: 'no-store' });
    const data = await response.json();
    if (response.ok && data.recovery === true) { setAuthorized(true); setProof(data); }
  }
  useEffect(() => {
    let active = true;
    fetch('/api/instance/setup', { cache: 'no-store' }).then(async response => {
      const data = await response.json();
      if (active && response.ok && data.recovery === true) { setAuthorized(true); setProof(data); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return <section className="mt-6 space-y-4 rounded-lg border p-5" aria-busy={busy}>
    <p>The host operator authorized a limited recovery flow. This verifies the replacement identity and its instance-admin role. Ownership changes only after the operator confirms the verified proof; fresh setup remains consumed.</p>
    {error ? <p role="alert">{error}</p> : null}
    {!authorized ? <form className="grid gap-4" onSubmit={event => {
      event.preventDefault(); setBusy(true); setError('');
      void (async () => {
        try {
          await fetch('/api/instance/status', { cache: 'no-store' });
          const response = await fetch('/api/instance/setup/authorize', { method: 'POST', headers: {
            'Content-Type': 'application/json', 'X-CSRF-Token': cookie('__Host-librarian_pre_csrf'),
          }, body: JSON.stringify({ credential }), cache: 'no-store' });
          setCredential('');
          const data = await response.json();
          if (!response.ok || data.purpose !== 'recovery') throw new Error(data.error?.message ?? 'Recovery authorization failed.');
          await refreshProof();
        } catch (error) { setError(error instanceof Error ? error.message : 'Recovery authorization failed.'); }
        finally { setBusy(false); }
      })();
    }}><label className="grid gap-1">Protected recovery credential<input type="password" required autoComplete="off" value={credential} onChange={event => setCredential(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
      <button disabled={busy} className="rounded-md border px-3 py-2">Authorize target verification</button>
    </form> : <div className="space-y-4">
      {proof?.recoveryProofId ? <p role="status">Target identity verified. Give the host operator proof ID <code>{proof.recoveryProofId}</code> and control revision {proof.recoveryControlRevision}. Stop all processes before the host operation; a changed revision requires a fresh inspection.</p>
        : <button disabled={busy} className="rounded-md border px-3 py-2" onClick={() => { setBusy(true); void signIn('zitadel', { redirectTo: '/instance/setup' }, { prompt: 'login' }).catch(() => { setBusy(false); setError('Target login could not start.'); }); }}>Sign in as the recovery target</button>}
      <p className="text-sm">The proof expires after ten minutes. Recovery remains in maintenance until the host operation succeeds.</p>
    </div>}
  </section>;
}

export function InstanceSetup() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [step, setStep] = useState(0);
  const [credential, setCredential] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [audience, setAudience] = useState('');
  const [appId, setAppId] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [displayName, setDisplayName] = useState('Librarian');
  const [description, setDescription] = useState('');
  const [docsFolder, setDocsFolder] = useState('docs');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const csrf = () => cookie('__Host-librarian_setup_csrf') || csrfToken;

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  async function loadSnapshot() {
    const response = await fetch('/api/instance/setup', { cache: 'no-store' });
    const result = await body(response);
    if (!response.ok || !result) throw new Error(errorMessage(result));
    const data = result as unknown as Snapshot;
    setSnapshot(data);
    setIssuer(data.candidate.zitadel.issuer);
    setClientId(data.candidate.zitadel.clientId);
    setProjectId(data.candidate.zitadel.projectId);
    setAudience(data.candidate.zitadel.audience);
    setAppId(data.candidate.github.appId);
    setWebhookUrl(data.candidate.github.webhookUrl ?? data.webhookUrl);
    setDisplayName(data.candidate.preferences.displayName);
    setDescription(data.candidate.preferences.description);
    setDocsFolder(data.candidate.preferences.docsFolder);
    return data;
  }

  useEffect(() => {
    let alive = true;
    fetch('/api/instance/setup', { cache: 'no-store' }).then(async response => {
      const result = await body(response);
      if (!alive) return;
      if (!response.ok || !result) {
        if (response.status !== 401) setError(errorMessage(result));
        return;
      }
      const data = result as unknown as Snapshot;
      setSnapshot(data);
      setIssuer(data.candidate.zitadel.issuer);
      setClientId(data.candidate.zitadel.clientId);
      setProjectId(data.candidate.zitadel.projectId);
      setAudience(data.candidate.zitadel.audience);
      setAppId(data.candidate.github.appId);
    setWebhookUrl(data.candidate.github.webhookUrl ?? data.webhookUrl);
      setDisplayName(data.candidate.preferences.displayName);
      setDescription(data.candidate.preferences.description);
      setDocsFolder(data.candidate.preferences.docsFolder);
      const requestedStep = new URLSearchParams(window.location.search).get('step');
      setStep(requestedStep === 'owner' ? 5 : data.candidate.ownerVerified ? 6 : 0);
      setCsrfToken(cookie('__Host-librarian_setup_csrf'));
    }).catch(() => { if (alive) setError('Setup status could not be loaded. Try again shortly.'); });
    return () => { alive = false; };
  }, []);

  async function authorize() {
    setBusy(true); setError(''); setNotice('');
    try {
      let preSessionCsrf = cookie('__Host-librarian_pre_csrf');
      if (!preSessionCsrf) {
        const statusResponse = await fetch('/api/instance/status', { cache: 'no-store' });
        const status = await body(statusResponse);
        if (!statusResponse.ok || status?.state !== 'setup_required') throw new Error('Setup status could not be loaded. Reload and try again.');
        preSessionCsrf = cookie('__Host-librarian_pre_csrf');
      }
      if (!preSessionCsrf) throw new Error('The request could not be verified. Reload and try again.');
      const response = await fetch('/api/instance/setup/authorize', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': preSessionCsrf },
        body: JSON.stringify({ credential }),
      });
      const result = await body(response);
      if (!response.ok || !result || typeof result.csrfToken !== 'string') throw new Error(errorMessage(result));
      setCredential(''); setCsrfToken(result.csrfToken); setError('');
      await loadSnapshot();
      setNotice('Setup authorized. Your progress is saved on this instance.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Setup authorization failed.'); }
    finally { setCredential(''); setBusy(false); }
  }

  async function save(changes: Record<string, unknown>, secrets: Record<string, { action: 'replace'; value: string }> = {}, force = false) {
    if (!snapshot) return false;
    if (Object.keys(changes).length === 0 && Object.keys(secrets).length === 0) {
      if (!force) return true;
      changes = { description: snapshot.candidate.preferences.description };
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/instance/setup', {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf(), 'if-match': `"${snapshot.editRevision}"` },
        body: JSON.stringify({ candidateVersion: snapshot.candidateVersion, changes, ...(Object.keys(secrets).length ? { secretReplacements: secrets } : {}) }),
      });
      const result = await body(response);
      if (!response.ok || !result) throw new Error(errorMessage(result));
      const data = result as unknown as Snapshot;
      setSnapshot(data); setNotice('Changes saved securely on this instance.');
      setClientSecret(''); setPrivateKey(''); setWebhookSecret('');
      return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The setup draft could not be saved.'); return false; }
    finally { setBusy(false); }
  }

  async function runCheck(type: CheckType, currentSnapshot: Snapshot | null = snapshot) {
    if (!currentSnapshot) return null;
    const response = await fetch('/api/instance/setup/check', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf(), 'if-match': `"${currentSnapshot.editRevision}"` },
      body: JSON.stringify({ candidateVersion: currentSnapshot.candidateVersion, type }),
    });
    const result = await body(response);
    if (!response.ok || !result) throw new Error(errorMessage(result));
    const check = result as unknown as Check;
    setSnapshot(current => current ? { ...current, candidate: { ...current.candidate,
      checks: [...current.candidate.checks.filter(item => item.type !== check.type), check] } } : current);
    return check;
  }

  async function review() {
    if (!snapshot?.candidate.ownerVerified) { setError('Verify the instance owner before reviewing setup.'); return; }
    const saved = await save({});
    if (!saved) return;
    setStep(6);
    if (checksReady(snapshot.candidate)) return;
    let currentSnapshot = snapshot;
    setChecking(true); setError(''); setNotice('Checking the current provider configuration.');
    try {
      for (const type of requiredChecks) {
        await runCheck(type, currentSnapshot);
        currentSnapshot = await loadSnapshot();
      }
      setNotice('Review the check results and confirm setup when every required check has passed.');
    } catch (reason) { setNotice(''); setError(reason instanceof Error ? reason.message : 'A provider check could not be completed.'); }
    finally { setChecking(false); }
  }

  async function finish() {
    if (!snapshot?.candidate.impact || !checksReady(snapshot.candidate) || !snapshot.candidate.ownerVerified) return;
    setFinalizing(true); setError(''); setNotice('Saving the owner and active configuration.');
    try {
      const response = await fetch('/api/instance/setup/finalize', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf(), 'if-match': `"${snapshot.editRevision}"` },
        body: JSON.stringify({ candidateVersion: snapshot.candidateVersion, confirmationNonce: snapshot.candidate.impact.confirmationNonce, confirm: true }),
      });
      const result = await body(response);
      if (!response.ok) throw new Error(errorMessage(result));
      if (response.status === 202) {
        for (let attempt = 0; attempt < 20; attempt++) {
          const statusResponse = await fetch('/api/instance/status', { cache: 'no-store' });
          const status = await body(statusResponse);
          if (status?.state === 'ready') break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      router.replace('/instance/setup');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Setup could not be completed.'); }
    finally { setFinalizing(false); }
  }

  function changesForStep() {
    if (!snapshot) return {};
    const candidate = snapshot.candidate;
    if (step === 2) {
      const zitadel: Record<string, string> = {};
      if (issuer !== candidate.zitadel.issuer) zitadel.issuer = issuer;
      if (clientId !== candidate.zitadel.clientId) zitadel.clientId = clientId;
      if (projectId !== candidate.zitadel.projectId) zitadel.projectId = projectId;
      if (audience !== candidate.zitadel.audience) zitadel.apiAudience = audience;
      return Object.keys(zitadel).length ? { zitadel } : {};
    }
    if (step === 3) {
      const github = { ...(appId !== candidate.github.appId ? { appId } : {}),
        ...(webhookUrl !== (candidate.github.webhookUrl ?? snapshot.webhookUrl) ? { webhookUrl } : {}) };
      return Object.keys(github).length ? { github } : {};
    }
    if (step === 4) return {
      ...(displayName !== candidate.preferences.displayName ? { displayName } : {}),
      ...(description !== candidate.preferences.description ? { description } : {}),
      ...(docsFolder !== candidate.preferences.docsFolder ? { defaultDocsFolder: docsFolder } : {}),
    };
    return {};
  }

  async function continueStep() {
    if (step === 5) { await review(); return; }
    const secrets: Record<string, { action: 'replace'; value: string }> = {};
    if (step === 2 && clientSecret) secrets.zitadelClientSecret = { action: 'replace', value: clientSecret };
    if (step === 3 && privateKey) secrets.githubPrivateKey = { action: 'replace', value: privateKey };
    if (step === 3 && webhookSecret) secrets.githubWebhookSecret = { action: 'replace', value: webhookSecret };
    if (!await save(changesForStep(), secrets)) return;
    setStep(value => Math.min(6, value + 1));
  }

  async function retryDatabase() {
    if (!snapshot) return;
    try {
      let currentSnapshot = snapshot;
      if (currentSnapshot.candidateVersion === 0) {
        if (!await save({}, {}, true)) return;
        setBusy(true);
        currentSnapshot = await loadSnapshot();
      }
      setBusy(true); setError(''); setNotice('Checking the instance database connection.');
      const result = await runCheck('database', currentSnapshot);
      setNotice(result?.status === 'passed' ? 'Database connection passed.' : 'Database connection needs attention.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Database connection check failed.'); }
    finally { setBusy(false); }
  }

  async function verifyOwner() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await signIn('zitadel', { redirect: false, redirectTo: '/instance/setup?step=owner' });
      if (!result?.ok || !result.url || !snapshot || new URL(result.url).origin !== new URL(snapshot.candidate.zitadel.issuer).origin) {
        throw new Error('Owner verification could not be started. Check the provider configuration and try again.');
      }
      window.location.assign(result.url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Owner verification could not be started.'); }
    finally { setBusy(false); }
  }

  const statusText = snapshot?.candidate.checks.map(item => `${item.type.replaceAll('_', ' ')}: ${item.status} (${item.code})`).join('. ') ?? '';

  return <section aria-label="Instance setup wizard" className="rounded-lg border p-5 sm:p-7">
    <nav aria-label="Setup steps" className="mb-7 overflow-x-auto">
      <ol className="flex min-w-max gap-2">
        {steps.map((label, index) => <li key={label}>
          <button type="button" aria-current={step === index ? 'step' : undefined} onClick={() => { setStep(index); setError(''); }}
            className="rounded-full border px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}</button>
        </li>)}
      </ol>
    </nav>
    {error ? <p ref={errorRef} role="alert" tabIndex={-1} className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{error}</p> : null}
    {notice ? <p role="status" aria-live="polite" className="mb-4 rounded-md border p-3 text-sm">{notice}</p> : null}
    {!snapshot ? <>
      <h2 className="text-xl font-semibold">Welcome</h2>
      <p className="mt-2 text-sm text-muted-foreground">Enter the one-time bootstrap credential from the protected host setup file to begin. The credential is never saved in this browser.</p>
      <form onSubmit={event => { event.preventDefault(); void authorize(); }}>
        <label htmlFor="bootstrap-credential" className="mt-5 block text-sm font-medium">Bootstrap credential</label>
        <input id="bootstrap-credential" type="password" autoComplete="off" value={credential} disabled={busy} onChange={event => setCredential(event.target.value)}
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <button type="submit" disabled={busy || !credential} className="mt-4 rounded-md border px-4 py-2 font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {busy ? 'Authorizing…' : 'Authorize setup'}
        </button>
      </form>
      <p className="mt-4 text-xs text-muted-foreground">Fresh enrollment is available only before the host setup credential expires and before this instance is initialized.</p>
    </> : <>
      <div aria-live="polite" className="min-h-56">
        {step === 0 ? <div><h2 className="text-xl font-semibold">Welcome</h2><p className="mt-2 text-sm text-muted-foreground">Your setup draft is stored on this instance and can be resumed after a restart. Provider credentials are encrypted before they are saved.</p></div> : null}
        {step === 1 ? <div><h2 className="text-xl font-semibold">Database</h2><p className="mt-2 text-sm text-muted-foreground">The database endpoint and root credentials come from protected host configuration.</p><button type="button" onClick={() => void retryDatabase()} disabled={busy} className="mt-4 rounded-md border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Retry connection</button></div> : null}
        {step === 2 ? <fieldset className="grid gap-4"><legend className="text-xl font-semibold">Zitadel</legend>
          <label className="grid gap-1 text-sm">Zitadel issuer<input aria-label="Zitadel issuer" type="url" value={issuer} onChange={event => setIssuer(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <label className="grid gap-1 text-sm">Client ID<input aria-label="Client ID" value={clientId} onChange={event => setClientId(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <label className="grid gap-1 text-sm">Project ID<input aria-label="Project ID" value={projectId} onChange={event => setProjectId(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <label className="grid gap-1 text-sm">API audience<input aria-label="API audience" value={audience} onChange={event => setAudience(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <label className="grid gap-1 text-sm">Client secret<input aria-label="Client secret" type="password" autoComplete="new-password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <p className="text-xs text-muted-foreground">The secret is write-only. Leave it blank to keep the configured value.</p>
        </fieldset> : null}
        {step === 3 ? <fieldset className="grid gap-4"><legend className="text-xl font-semibold">GitHub App</legend>
          <label className="grid gap-1 text-sm">GitHub App ID<input aria-label="GitHub App ID" inputMode="numeric" value={appId} onChange={event => setAppId(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <label className="grid gap-1 text-sm">Webhook URL<input aria-label="Webhook URL" type="url" value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <label className="grid gap-1 text-sm">GitHub private key<textarea aria-label="GitHub private key" autoComplete="off" rows={7} value={privateKey} onChange={event => setPrivateKey(event.target.value)} className="rounded-md border bg-background px-3 py-2 font-mono text-xs" /></label>
          <label className="grid gap-1 text-sm">Webhook secret<input aria-label="Webhook secret" type="password" autoComplete="new-password" value={webhookSecret} onChange={event => setWebhookSecret(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <p className="text-xs text-muted-foreground">Keys are write-only and encrypted on the server. Leave a field blank to retain its configured value.</p>
        </fieldset> : null}
        {step === 4 ? <fieldset className="grid gap-4"><legend className="text-xl font-semibold">Preferences</legend>
          <label className="grid gap-1 text-sm">Display name<input aria-label="Display name" value={displayName} onChange={event => setDisplayName(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <label className="grid gap-1 text-sm">Description<textarea aria-label="Description" rows={3} value={description} onChange={event => setDescription(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <label className="grid gap-1 text-sm">Default docs folder<input aria-label="Default docs folder" value={docsFolder} onChange={event => setDocsFolder(event.target.value)} className="rounded-md border bg-background px-3 py-2" /></label>
          <p className="text-xs text-muted-foreground">Runtime callback: {snapshot.runtimeCallbackUrl}<br />Candidate callback: {snapshot.candidateCallbackUrl}<br />GitHub webhook: {snapshot.webhookUrl}</p>
        </fieldset> : null}
        {step === 5 ? <div><h2 className="text-xl font-semibold">Owner verification</h2>
          <p className="mt-2 text-sm text-muted-foreground">Sign in with the identity that will own this instance and verify its current instance-admin role.</p>
          {snapshot.candidate.ownerVerified ? <p role="status" className="mt-4 rounded-md border p-3">Owner verified for the current setup candidate.</p>
            : <button type="button" onClick={() => void verifyOwner()} disabled={busy}
              className="mt-4 inline-flex rounded-md border px-4 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
              Verify owner / Sign in with Zitadel
            </button>}
        </div> : null}
        {step === 6 ? <div><h2 className="text-xl font-semibold">Review</h2>
          <p className="mt-2 text-sm text-muted-foreground">Confirm the current provider checks and owner binding before the first configuration becomes active.</p>
          <dl className="mt-4 grid gap-2 text-sm"><div><dt className="font-medium">Instance</dt><dd>{displayName}</dd></div><div><dt className="font-medium">Owner</dt><dd>{snapshot.candidate.ownerVerified ? 'Verified' : 'Not verified'}</dd></div></dl>
          <p aria-live="polite" className="mt-4 text-sm text-muted-foreground">{checking ? 'Provider checks are running.' : statusText || 'Provider checks have not run yet.'}</p>
          {snapshot.candidate.checks.some(item => item.status === 'warning') ? <p className="mt-3 rounded-md border border-amber-400 p-3 text-sm">Warnings: installation may still need to be connected, and webhook delivery is unverified until a signed ping arrives.</p> : null}
          <button type="button" onClick={() => void review()} disabled={checking || busy} className="mt-4 rounded-md border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Review</button>
          <button type="button" onClick={() => void finish()} disabled={!snapshot.candidate.impact || !checksReady(snapshot.candidate) || !snapshot.candidate.ownerVerified || checking || finalizing}
            className="ml-2 mt-4 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {finalizing ? 'Completing setup…' : 'Complete setup'}
          </button>
        </div> : null}
      </div>
      {step < 6 ? <div className="mt-6 flex flex-wrap justify-between gap-3 border-t pt-5">
        <button type="button" onClick={() => setStep(value => Math.max(0, value - 1))} disabled={step === 0 || busy}
          className="rounded-md border px-4 py-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Back</button>
        <button type="button" onClick={() => void continueStep()} disabled={busy || (step === 5 && !snapshot.candidate.ownerVerified)}
          className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{busy ? 'Saving…' : step === 5 ? 'Review' : 'Continue'}</button>
      </div> : null}
    </>}
  </section>;
}
