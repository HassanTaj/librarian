import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import Image from 'next/image';

export const baseOptions: BaseLayoutProps = {
  themeSwitch: { enabled: true, mode: 'light-dark' },
  nav: {
    title: (
      <>
        <Image src="/librarian-github-app-icon.png" alt="" width={32} height={32} className="rounded-md" />
        <span className="max-md:sr-only">Perspective V / Docs</span>
      </>
    ),
  },
};

export function instanceLayoutOptions(displayName?: string): BaseLayoutProps {
  if (!displayName) return baseOptions;
  return { ...baseOptions, nav: { ...baseOptions.nav, title: <>
    <Image src="/librarian-github-app-icon.png" alt="" width={32} height={32} className="rounded-md" />
    <span className="max-md:sr-only">{displayName}</span>
  </> } };
}
