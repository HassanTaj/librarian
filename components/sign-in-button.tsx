'use client';

import { signIn } from 'next-auth/react';

export function SignInButton({ redirectTo, className }: { redirectTo: string; className: string }) {
  return <button type="button" onClick={() => void signIn('zitadel', { redirectTo })} className={className}>Sign in with Zitadel</button>;
}
