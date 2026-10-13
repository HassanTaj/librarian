import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Image from 'next/image';
import { RootProvider } from 'fumadocs-ui/provider/next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Perspective V | Docs',
  description: 'Project documentation',
  icons: {
    icon: [
      { url: '/favicon.light.ico', media: '(prefers-color-scheme: light)' },
      { url: '/favicon.dark.ico', media: '(prefers-color-scheme: dark)' },
    ],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }}>
          <div className="flex min-h-screen flex-col">
            <div className="flex-1">{children}</div>
            <footer className="mt-auto border-t px-5 py-6 text-sm text-muted-foreground sm:px-8">
              <div className="mx-auto flex max-w-6xl items-center justify-center gap-2">
                <span>Made with love by</span>
                <Image src="/logos/light.svg" alt="" width={24} height={24} className="dark:hidden" />
                <Image src="/logos/dark.svg" alt="" width={24} height={24} className="hidden dark:block" />
                <span className="font-medium text-foreground">Perspective V</span>
              </div>
            </footer>
          </div>
        </RootProvider>
      </body>
    </html>
  );
}
