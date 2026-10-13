import { headers } from 'next/headers';
import { AdminConsole } from '@/components/admin-console';
import { SiteNavigation } from '@/components/site-navigation';
import { requireAdmin } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function RepositoriesPage() {
  const incoming = await headers();
  const requestHeaders = new Headers();
  const cookie = incoming.get('cookie');
  if (cookie) requestHeaders.set('cookie', cookie);
  let code: string | null = null;
  try { await requireAdmin(new Request('http://localhost/repositories', { headers: requestHeaders })); }
  catch (error) { code = error instanceof Error ? error.message : 'admin_unavailable'; }
  if (code === null) return <AdminConsole />;
  const signIn = code === 'admin_unauthorized';
  const title = signIn ? 'Sign in required' : code === 'admin_forbidden' ? 'Administrator access denied' : 'Administration unavailable';
  return <main className="mx-auto max-w-3xl px-5 py-16"><SiteNavigation showSignIn={signIn} showAccountControls={!signIn} /><h1 className="text-2xl font-semibold">{title}</h1>
    <p className="mt-3 text-muted-foreground">{signIn ? 'Sign in with an account assigned the librarian-admin role.'
      : code === 'admin_forbidden' ? 'This account does not have the required administrator role. If it was just assigned, the change may take up to 15 minutes to appear.'
        : 'Administration could not be verified right now.'}</p>
  </main>;
}
