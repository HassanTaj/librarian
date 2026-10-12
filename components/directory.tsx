'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';
import { SignInButton } from '@/components/sign-in-button';
import { AccountControls } from '@/components/private-content-guard';
import { SyncStatusBadge, type SyncStatus } from '@/components/sync-status-badge';

export type DirectoryCard = { slug: string; title: string; publicDescription: string; visibility: 'public' | 'private'; url: string; syncStatus?: SyncStatus };

export function filterDirectoryCards(cards: DirectoryCard[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized ? cards.filter(card => card.title.toLocaleLowerCase().includes(normalized)) : cards;
}

export function Directory({ cards, unavailable = false, showSignIn = false, showAccountControls = false }: {
  cards: DirectoryCard[]; unavailable?: boolean; showSignIn?: boolean; showAccountControls?: boolean;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => filterDirectoryCards(cards, query), [cards, query]);
  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8">
      <header className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm font-medium text-muted-foreground">Perspective V / Docs</p>
          <div className="flex flex-wrap items-center gap-4">
            {showSignIn ? <SignInButton redirectTo="/admin" className="border-0 bg-transparent p-0 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /> : null}
            {showAccountControls ? <AccountControls /> : null}
            <Link href="/admin" className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Administration</Link>
            <ThemeSwitch />
          </div>
        </div>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Project documentation</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">Browse the documentation configured for this portal.</p>
      </header>
      {unavailable ? (
        <p role="status" className="rounded-lg border p-5">The documentation directory is temporarily unavailable. Please try again shortly.</p>
      ) : (
        <>
          <div className="mb-7 max-w-md">
            <label htmlFor="project-filter" className="mb-2 block text-sm font-medium">Filter projects by title</label>
            <input id="project-filter" type="search" value={query} onChange={event => setQuery(event.target.value)}
              placeholder="Search project titles" className="w-full rounded-md border bg-background px-3 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
          {visible.length ? (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Projects">
              {visible.map(card => (
                <li key={card.slug}>
                  <a href={card.url} className="block h-full rounded-lg border p-5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-lg font-semibold">{card.title}</span>
                      <span className="flex shrink-0 flex-wrap items-center gap-2">
                        <span className="rounded-full bg-muted px-2.5 py-1 text-xs">{card.visibility === 'public' ? 'Public' : 'Restricted'}</span>
                        {card.syncStatus ? <SyncStatusBadge status={card.syncStatus} /> : null}
                      </span>
                    </span>
                    <span className="mt-2 block text-sm text-muted-foreground">{card.publicDescription}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="rounded-lg border p-5">{cards.length ? 'No projects match that title.' : 'No documentation projects are available yet.'}</p>
          )}
        </>
      )}
    </main>
  );
}
