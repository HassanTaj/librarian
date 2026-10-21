import { headers } from 'next/headers';
import { InstanceSettings } from '@/components/instance-settings';
import { SiteNavigation } from '@/components/site-navigation';
import { requireInstanceAdmin } from '@/lib/instance/access';
import { readInstanceSetupStatus } from '@/lib/instance/bootstrap';
import ExistingCatalogReader, { generateMetadata as existingCatalogMetadata } from '../../[repoSlug]/[[...page]]/page';
import { SessionProvider } from 'next-auth/react';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
const collisionRoute = { params: Promise.resolve({ repoSlug: 'instance', page: ['settings'] }), searchParams: Promise.resolve({}) };
export async function generateMetadata() {
  const status = await readInstanceSetupStatus();
  if (status.namespaceAvailable === false) return existingCatalogMetadata(collisionRoute);
  return { title: 'Instance Settings | Librarian' };
}
export default async function SettingsPage() {
  const status = await readInstanceSetupStatus();
  if (status.namespaceAvailable === false) return ExistingCatalogReader(collisionRoute);
  let code: string | null = null;
  let displayName: string | undefined;
  try {
    const { control } = await requireInstanceAdmin(new Request('http://localhost/instance/settings', { headers: new Headers(await headers()) }));
    displayName = control.active?.preferences.displayName;
  }
  catch (error) { code = error instanceof Error ? error.message : 'instance_unavailable'; }
  return <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
    <SiteNavigation showSignIn={code === 'instance_unauthorized'} showAccountControls={code !== 'instance_unauthorized'} showInstanceSettings={code === null} displayName={displayName} />
    <h1 className="text-3xl font-semibold">Instance Settings</h1>
    {code === null ? <SessionProvider basePath="/api/instance/auth" session={null}><InstanceSettings /></SessionProvider> : <p role="alert" className="mt-5">{code === 'instance_unauthorized' ? 'Sign in to continue.'
      : code === 'instance_forbidden' ? 'An explicit instance binding and the librarian-instance-admin role are required.' : 'Instance settings are temporarily unavailable.'}</p>}
  </main>;
}
