import { Directory, type DirectoryCard } from '@/components/directory';
import { listDirectorySyncStatuses } from '@/lib/admin';
import { listDirectoryCards } from '@/lib/catalog';
import { getMongo } from '@/lib/mongo';
import { auth } from '../auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function Home() {
  let cards: DirectoryCard[] = [];
  let unavailable = false;
  let showSignIn = true;
  let showAccountControls = false;
  try {
    showAccountControls = Boolean((await auth())?.user?.id);
    showSignIn = !showAccountControls;
  } catch { /* Keep sign-in available when session lookup is unavailable. */ }
  try {
    const { db } = await getMongo();
    cards = await listDirectoryCards(db);
    if (cards.length) {
      try {
        const statuses = await listDirectorySyncStatuses(db, cards.map(card => card.slug));
        const bySlug = new Map(statuses.map(({ slug, status }) => [slug, status]));
        cards = cards.map(card => bySlug.has(card.slug) ? { ...card, syncStatus: bySlug.get(card.slug)! } : card);
      } catch { /* Keep the documentation directory available when sync status is unavailable. */ }
    }
  } catch {
    unavailable = true;
  }
  return <Directory cards={cards} unavailable={unavailable} showSignIn={showSignIn} showAccountControls={showAccountControls} />;
}
