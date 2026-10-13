'use client';

import { usePathname } from 'fumadocs-core/framework';
import type { Node } from 'fumadocs-core/page-tree';
import type { ReactNode } from 'react';
import {
  SidebarFolder,
  SidebarFolderContent,
  SidebarFolderLink,
  SidebarFolderTrigger,
  SidebarItem,
  useFolder,
  useFolderDepth,
} from 'fumadocs-ui/components/sidebar/base';
import type { SidebarPageTreeComponents } from 'fumadocs-ui/components/sidebar/page-tree';

// shortcut: mirrors the installed Docs layout wrappers; refresh these classes when Fumadocs changes.
const itemBase = 'relative flex flex-row items-center gap-2 rounded-lg p-2 text-start text-fd-muted-foreground wrap-anywhere [&_svg]:size-4 [&_svg]:shrink-0';
const linkVariant = 'transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 hover:transition-none data-[active=true]:bg-fd-primary/10 data-[active=true]:text-fd-primary data-[active=true]:hover:transition-colors';
const buttonVariant = 'transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 hover:transition-none';

function itemOffset(depth: number) {
  return `calc(${2 + 3 * depth} * var(--spacing))`;
}

function isCurrentPage(url: string, pathname: string) {
  return url.split(/[?#]/, 1)[0] === pathname;
}

function containsCurrentPage(node: Node, pathname: string): boolean {
  if (node.type === 'page') return !node.external && isCurrentPage(node.url, pathname);
  if (node.type === 'separator') return false;
  if (node.index && !node.index.external && isCurrentPage(node.index.url, pathname)) return true;
  return node.children.some(child => containsCurrentPage(child, pathname));
}

function RuntimeFolderTrigger({ children }: { children: ReactNode }) {
  const folder = useFolder();
  const depth = folder?.depth ?? 1;
  return (
    <SidebarFolderTrigger
      className={`${itemBase} ${folder?.collapsible ? buttonVariant : ''} w-full`}
      style={{ paddingInlineStart: itemOffset(depth - 1) }}
    >
      {children}
    </SidebarFolderTrigger>
  );
}

function RuntimeFolderLink({ href, active, external, children }: { href: string; active?: boolean; external?: boolean; children: ReactNode }) {
  const depth = useFolderDepth();
  return (
    <SidebarFolderLink
      href={href}
      active={active}
      external={external}
      className={`${itemBase} ${linkVariant} ${depth > 1 ? "data-[active=true]:before:content-[''] data-[active=true]:before:bg-fd-primary data-[active=true]:before:absolute data-[active=true]:before:w-px data-[active=true]:before:inset-y-2.5 data-[active=true]:before:inset-s-2.5" : ''} w-full`}
      style={{ paddingInlineStart: itemOffset(depth - 1) }}
    >
      {children}
    </SidebarFolderLink>
  );
}

function RuntimeFolderContent({ children }: { children: ReactNode }) {
  const depth = useFolderDepth();
  return (
    <SidebarFolderContent
      className={`relative ${depth === 1 ? "before:content-[''] before:absolute before:w-px before:inset-y-1 before:bg-fd-border before:inset-s-2.5" : ''}`}
    >
      <div className="flex flex-col gap-0.5 pt-0.5">{children}</div>
    </SidebarFolderContent>
  );
}

export const RuntimeSidebarItem: SidebarPageTreeComponents['Item'] = ({ item }) => {
  const pathname = usePathname();
  const depth = useFolderDepth();
  return (
    <SidebarItem
      href={item.url}
      active={!item.external && isCurrentPage(item.url, pathname)}
      external={item.external}
      icon={item.icon}
      className={`${itemBase} ${linkVariant} ${depth >= 1 ? "data-[active=true]:before:content-[''] data-[active=true]:before:bg-fd-primary data-[active=true]:before:absolute data-[active=true]:before:w-px data-[active=true]:before:inset-y-2.5 data-[active=true]:before:inset-s-2.5" : ''}`}
      style={{ paddingInlineStart: itemOffset(depth) }}
    >
      {item.name}
    </SidebarItem>
  );
};

export const RuntimeSidebarFolder: SidebarPageTreeComponents['Folder'] = ({ item, children }) => {
  const pathname = usePathname();
  return (
    <SidebarFolder collapsible={item.collapsible} defaultOpen={item.defaultOpen} active={containsCurrentPage(item, pathname)}>
      {item.index ? (
        <RuntimeFolderLink href={item.index.url} active={!item.index.external && isCurrentPage(item.index.url, pathname)} external={item.index.external}>
          {item.icon}{item.name}
        </RuntimeFolderLink>
      ) : <RuntimeFolderTrigger>{item.icon}{item.name}</RuntimeFolderTrigger>}
      <RuntimeFolderContent>{children}</RuntimeFolderContent>
    </SidebarFolder>
  );
};
