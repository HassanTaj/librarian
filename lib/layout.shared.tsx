import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import Image from 'next/image';

export const baseOptions: BaseLayoutProps = {
  themeSwitch: { enabled: true, mode: 'light-dark' },
  nav: {
    title: (
      <>
        <Image src="/logos/light.svg" alt="" width={32} height={32} className="dark:hidden" />
        <Image src="/logos/dark.svg" alt="" width={32} height={32} className="hidden dark:block" />
        <span className="sr-only">Perspective V Docs</span>
      </>
    ),
  },
};
