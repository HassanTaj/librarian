import { headers } from 'next/headers';
import { AdminConsole } from '@/components/admin-console';
import { AccountControls } from '@/components/private-content-guard';
import { SignInButton } from '@/components/sign-in-button';
import { requireAdmin } from '@/lib/auth/admin';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function AdminPage() {
  const incoming = await headers();
  const requestHeaders = new Headers();
  const cookie = incoming.get('cookie');
  if (cookie) requestHeaders.set('cookie', cookie);
  let code: string | null = null;
  try { await requireAdmin(new Request('http://localhost/admin', { headers: requestHeaders })); }
  catch (error) { code = error instanceof Error ? error.message : 'admin_unavailable'; }
  if (code === null) return <AdminConsole />;
  const signIn = code === 'admin_unauthorized';
  const title = signIn ? 'Sign in required' : code === 'admin_forbidden' ? 'Administrator access denied' : 'Administration unavailable';
  return <main className="mx-auto max-w-3xl px-5 py-16"><div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-2xl font-semibold">{title}</h1>
    <div className="flex flex-wrap items-center gap-3"><Link href="/" className="inline-flex min-h-10 items-center rounded-md border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Back to home</Link>
      {code !== 'admin_unauthorized' ? <AccountControls /> : null}</div></div>
    <p className="mt-3 text-muted-foreground">{signIn ? 'Sign in with an account assigned the librarian-admin role.'
      : code === 'admin_forbidden' ? 'This account does not have the required administrator role. If it was just assigned, the change may take up to 15 minutes to appear.'
        : 'Administration could not be verified right now.'}</p>
    {signIn ? <SignInButton redirectTo="/admin" className="mt-5 rounded-md border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /> : null}
  </main>;
}
