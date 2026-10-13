'use client';

import Link from 'next/link';
import Image from 'next/image';
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';
import { AccountControls } from '@/components/private-content-guard';
import { SignInButton } from '@/components/sign-in-button';

export function SiteNavigation({ showSignIn = false, showAccountControls = false }: {
  showSignIn?: boolean; showAccountControls?: boolean;
}) {
  return <nav aria-label="Primary navigation" className="mb-8 flex flex-wrap items-center justify-between gap-4">
    <Link href="/" className="flex items-center gap-2 text-sm font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Image src="/librarian-github-app-icon.png" alt="" width={32} height={32} className="rounded-md" />
      Perspective V / Docs
    </Link>
    <div className="flex flex-wrap items-center gap-4">
      <Link href="/" className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Home</Link>
      <Link href="/repositories" className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Repositories</Link>
      {showSignIn ? <SignInButton redirectTo="/repositories" className="border-0 bg-transparent p-0 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /> : null}
      {showAccountControls ? <AccountControls /> : null}
      <ThemeSwitch />
    </div>
  </nav>;
}
