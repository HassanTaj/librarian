import { headers } from 'next/headers';
import { Directory, type DirectoryCard } from '@/components/directory';
import { listDirectorySyncStatuses } from '@/lib/admin';
import { requireAdmin } from '@/lib/auth/admin';
import { listDirectoryCards } from '@/lib/catalog';
import { readInstanceSetupStatus, readInstancePreferences } from '@/lib/instance/bootstrap';
import { requireInstanceAdmin } from '@/lib/instance/access';
import { getMongo } from '@/lib/mongo';
import { auth } from '../auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function Home() {
  if (process.env.INSTANCE_STATE_FILE || process.env.INSTANCE_ID) {
    const status = await readInstanceSetupStatus();
    if (status.state === 'setup_required' && status.namespaceAvailable) redirect('/instance/setup');
  }
  let cards: DirectoryCard[] = [];
  let unavailable = false;
  let showSignIn = true;
  let showAccountControls = false;
  let canSync = false;
  let showInstanceSettings = false;
  const preferences = await readInstancePreferences().catch(() => null);
  try {
    showAccountControls = Boolean((await auth())?.user?.id);
    showSignIn = !showAccountControls;
    if (showAccountControls) {
      try { await requireInstanceAdmin(new Request('http://localhost/', { headers: new Headers(await headers()) })); showInstanceSettings = true; }
      catch { /* The link requires the same authority as the destination. */ }
      try {
        const incoming = await headers();
        const requestHeaders = new Headers();
        const cookie = incoming.get('cookie');
        if (cookie) requestHeaders.set('cookie', cookie);
        await requireAdmin(new Request('http://localhost/', { headers: requestHeaders }));
        canSync = true;
      } catch { /* Only verified administrators get directory sync controls. */ }
    }
  } catch { /* Keep sign-in available when session lookup is unavailable. */ }
  try {
    const { db } = await getMongo();
    cards = await listDirectoryCards(db);
    if (cards.length) {
      try {
        const statuses = await listDirectorySyncStatuses(db, cards.map(card => card.slug));
        const bySlug = new Map(statuses.map(({ slug, status, error, isSyncing }) => [slug, { status, error, isSyncing }]));
        cards = cards.map(card => {
          const sync = bySlug.get(card.slug);
          return sync ? { ...card, syncStatus: sync.status, syncError: sync.error, syncActive: sync.isSyncing } : card;
        });
      } catch { /* Keep the documentation directory available when sync status is unavailable. */ }
    }
  } catch {
    unavailable = true;
  }
  return <Directory cards={cards} unavailable={unavailable} showSignIn={showSignIn} showAccountControls={showAccountControls} canSync={canSync}
    showInstanceSettings={showInstanceSettings} displayName={preferences?.displayName} description={preferences?.description} />;
}
