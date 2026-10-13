import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Folder, Item, Separator } from 'fumadocs-core/page-tree';
import { RuntimeSidebarFolder, RuntimeSidebarItem } from '../../components/runtime-sidebar';

const state = vi.hoisted(() => ({ pathname: '/docs/guides/setup' }));

vi.mock('fumadocs-core/framework', () => ({ usePathname: () => state.pathname }));
vi.mock('fumadocs-ui/components/sidebar/base', async () => {
  const { createElement } = await import('react');
  return {
    SidebarItem: ({ href, active, icon, children, className, style }: { href: string; active?: boolean; icon?: ReactNode; children: ReactNode; className?: string; style?: object }) =>
      createElement('a', { href, 'data-active': active, className, style }, icon, children),
    SidebarFolder: ({ active, defaultOpen, children }: { active?: boolean; defaultOpen?: boolean; children: ReactNode }) =>
      createElement('section', { 'data-folder-active': active, 'data-default-open': defaultOpen }, children),
    SidebarFolderContent: ({ children, className }: { children: ReactNode; className?: string }) => createElement('div', { className }, children),
    SidebarFolderLink: ({ href, active, external, children, className, style }: { href: string; active?: boolean; external?: boolean; children: ReactNode; className?: string; style?: object }) =>
      createElement('a', { href, 'data-active': active, 'data-external': external, className, style }, children),
    SidebarFolderTrigger: ({ children, className, style }: { children: ReactNode; className?: string; style?: object }) => createElement('button', { className, style }, children),
    useFolder: () => ({ open: true, setOpen: vi.fn(), depth: 1, collapsible: true }),
    useFolderDepth: () => 1,
  };
});

const setup: Item = { type: 'page', name: 'Setup', url: '/docs/guides/setup?g=00000000-0000-4000-8000-000000000001' };
const guides: Folder = { type: 'folder', name: 'Guides', collapsible: true, children: [setup] };
const FolderComponent = RuntimeSidebarFolder as ComponentType<{ item: Folder; children?: ReactNode }>;
const renderFolder = (item: Folder, children: ReactNode = null) => renderToStaticMarkup(createElement(FolderComponent, { item }, children));

it('matches the active pathname without losing its pinned generation link', () => {
  const html = renderFolder(guides, createElement(RuntimeSidebarItem, { item: setup }));

  expect(html).toContain('data-folder-active="true"');
  expect(html).toContain('href="/docs/guides/setup?g=00000000-0000-4000-8000-000000000001" data-active="true"');
});

it('marks a folder index active and ignores separators and external pages', () => {
  const external: Item = { type: 'page', name: 'External', url: 'https://docs.example.invalid/docs/guides', external: true };
  const separator: Separator = { type: 'separator', name: 'More' };
  const folder: Folder = { ...guides, index: { type: 'page', name: 'Guides', url: '/docs/guides?g=gen' }, children: [separator, external] };
  state.pathname = '/docs/guides';

  const html = renderFolder(folder);

  expect(html).toContain('data-folder-active="true"');
  expect(html).toContain('href="/docs/guides?g=gen" data-active="true"');
});

it('does not mark a folder active when it contains no current local page', () => {
  const external: Item = { type: 'page', name: 'External', url: 'https://docs.example.invalid/docs/guides', external: true };
  const other: Item = { type: 'page', name: 'Other', url: '/docs/other?g=gen' };
  const folder: Folder = { ...guides, children: [{ type: 'separator', name: 'More' }, external, other] };
  state.pathname = '/docs/current';

  const html = renderFolder(folder);
  const externalLink = renderToStaticMarkup(createElement(RuntimeSidebarItem, { item: external }));
  const otherLink = renderToStaticMarkup(createElement(RuntimeSidebarItem, { item: other }));

  expect(html).toContain('data-folder-active="false"');
  expect(externalLink).toContain('data-active="false"');
  expect(otherLink).toContain('data-active="false"');
});
