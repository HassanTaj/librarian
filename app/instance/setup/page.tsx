import { InstanceDatabaseSetup } from '@/components/instance-database-setup';
import { needsInstanceDatabaseSetup } from '@/lib/instance/bootstrap';
import styles from '@/components/instance-settings.module.css';
import type { Metadata } from 'next';
import { SessionProvider } from 'next-auth/react';
import { InstanceSetup, InstanceLegacyEnrollment, InstanceRecovery } from '@/components/instance-setup';
import { readInstanceSetupStatus, hasLegacyEnrollment, hasInstanceRecovery } from '@/lib/instance/bootstrap';
import { requireLegacyEnrollmentAuthority } from '@/lib/instance/access';
import { headers } from 'next/headers';
import { SignInButton } from '@/components/sign-in-button';
import ExistingCatalogReader, { generateMetadata as existingCatalogMetadata } from '../../[repoSlug]/[[...page]]/page';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const collisionRoute = { params: Promise.resolve({ repoSlug: 'instance', page: ['setup'] }), searchParams: Promise.resolve({}) };

export async function generateMetadata(): Promise<Metadata> {
  const status = await readInstanceSetupStatus();
  if (status.namespaceAvailable === false) return existingCatalogMetadata(collisionRoute);
  return { title: 'Instance setup | Perspective V', description: 'Configure this Librarian instance.' };
}

export default async function SetupPage() {
  if (await needsInstanceDatabaseSetup()) return <main className={styles.page}><h1 className="text-3xl font-semibold">Instance setup</h1><InstanceDatabaseSetup /></main>;
  const status = await readInstanceSetupStatus();
  if (status.namespaceAvailable === false) return ExistingCatalogReader(collisionRoute);
  if (await hasInstanceRecovery().catch(() => false)) return <main className="mx-auto max-w-3xl px-5 py-10">
    <h1 className="text-3xl font-semibold">Verify a recovery identity</h1>
    <SessionProvider basePath="/api/instance/auth" session={null}><InstanceRecovery /></SessionProvider>
  </main>;
  const legacy = await hasLegacyEnrollment().catch(() => false);
  if (legacy && status.state !== 'setup_required') {
    let authorized = false;
    try { await requireLegacyEnrollmentAuthority(new Request('http://localhost/instance/setup', { headers: new Headers(await headers()) }), false); authorized = true; }
    catch { /* Enrollment requires both roles before presenting its controls. */ }
    return <main className="mx-auto max-w-3xl px-5 py-10"><h1 className="text-3xl font-semibold">Legacy instance enrollment</h1>
      {authorized ? <InstanceLegacyEnrollment /> : <><p className="my-5">Protected operator authorization and both librarian-admin and librarian-instance-admin roles are required.</p><SignInButton redirectTo="/instance/setup" className="rounded-md border px-3 py-2" /></>}
    </main>;
  }
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-10 sm:px-8">
      <header className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">Librarian instance · Version 2</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Instance setup</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">Configure the identity provider and GitHub App used by this documentation portal.</p>
      </header>
      {status.state === 'setup_required' && status.prerequisitesAvailable
        ? <SessionProvider basePath="/api/instance/auth" session={null}><InstanceSetup /></SessionProvider>
        : status.state === 'ready'
          ? <section className="rounded-lg border p-5" aria-labelledby="setup-closed-heading">
            <h2 id="setup-closed-heading" className="text-lg font-semibold">Setup is complete</h2>
            <p className="mt-2 text-sm text-muted-foreground">This instance has already been initialized. Fresh setup is closed.</p>
          </section>
          : <section className="rounded-lg border p-5" aria-labelledby="setup-unavailable-heading">
            <h2 id="setup-unavailable-heading" className="text-lg font-semibold">Setup is unavailable</h2>
            <p className="mt-2 text-sm text-muted-foreground">The instance needs a host operator to review its configuration and storage before setup can continue.</p>
          </section>}
    </main>
  );
}
