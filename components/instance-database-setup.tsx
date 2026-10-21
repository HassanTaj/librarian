'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './instance-settings.module.css';

export function InstanceDatabaseSetup() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <section className={styles.panel} aria-labelledby="database-setup-title">
    <form className={styles.group} onSubmit={async event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      setBusy(true); setError('');
      try {
        const response = await fetch('/api/instance/database', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: values.get('credential'), mongodbUri: values.get('mongodbUri'), mongodbDatabase: values.get('mongodbDatabase') }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message ?? 'The database connection could not be configured.');
        router.refresh();
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'The database connection could not be configured.'); }
      finally { setBusy(false); }
    }}>
      <h2 id="database-setup-title">Connect MongoDB</h2>
      <p>Connect an empty MongoDB database to begin setup. Librarian checks the connection before saving it. Existing databases are never reset.</p>
      <p>The setup credential is held in the protected operator file created during host preparation. Connection credentials stay server-side.</p>
      {error ? <p role="alert" className={styles.feedback}>{error}</p> : null}
      <fieldset disabled={busy} className={styles.group}>
        <label>Setup credential<input name="credential" type="password" autoComplete="off" required className={styles.input} /></label>
        <label>MongoDB connection URI<input name="mongodbUri" type="password" autoComplete="off" spellCheck={false} required placeholder="mongodb://user:password@host:27017/" className={styles.input} /></label>
        <label>Database name<input name="mongodbDatabase" defaultValue="librarian" required pattern="[a-zA-Z][a-zA-Z0-9_\-]{0,62}" className={styles.input} /></label>
      </fieldset>
      <div className={styles.actions}><button className={styles.button} disabled={busy}>{busy ? 'Checking connection…' : 'Connect and continue'}</button></div>
    </form>
  </section>;
}
