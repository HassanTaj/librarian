import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Folder, Item, Separator } from 'fumadocs-core/page-tree';
import { RuntimeSidebarFolder, RuntimeSidebarItem } from '../../components/runtime-sidebar';

const state = vi.hoisted(() => ({ pathname: '/docs/guides/setup', folderContext: true, collapsible: true, depth: 1 }));

vi.mock('fumadocs-core/framework', () => ({ usePathname: () => state.pathname }));
vi.mock('fumadocs-ui/components/sidebar/base', async () => {
  const { createElement } = await import('react');
  return {
    SidebarItem: ({ href, active, icon, children, className, style }: { href: string; active?: boolean; icon?: ReactNode; children: ReactNode; className?: string; style?: object }) =>
      createElement('a', { href, 'data-active': active, className, style }, icon, children),
    SidebarFolder: ({ active, defaultOpen, collapsible, children }: { active?: boolean; defaultOpen?: boolean; collapsible?: boolean; children: ReactNode }) =>
      createElement('section', { 'data-folder-active': active, 'data-default-open': defaultOpen, 'data-collapsible': collapsible }, children),
    SidebarFolderContent: ({ children, className }: { children: ReactNode; className?: string }) => createElement('div', { className }, children),
    SidebarFolderLink: ({ href, active, external, children, className, style }: { href: string; active?: boolean; external?: boolean; children: ReactNode; className?: string; style?: object }) =>
      createElement('a', { href, 'data-active': active, 'data-external': external, className, style }, children),
    SidebarFolderTrigger: ({ children, className, style }: { children: ReactNode; className?: string; style?: object }) => createElement('button', { className, style }, children),
    useFolder: () => state.folderContext ? ({ open: true, setOpen: vi.fn(), depth: state.depth, collapsible: state.collapsible }) : undefined,
    useFolderDepth: () => state.depth,
  };
});

const setup: Item = { type: 'page', name: 'Setup', url: '/docs/guides/setup?g=00000000-0000-4000-8000-000000000001' };
const guides: Folder = { type: 'folder', name: 'Guides', collapsible: true, children: [setup] };
const FolderComponent = RuntimeSidebarFolder as ComponentType<{ item: Folder; children?: ReactNode }>;
const renderFolder = (item: Folder, children: ReactNode = null) => renderToStaticMarkup(createElement(FolderComponent, { item }, children));

beforeEach(() => {
  state.pathname = '/docs/guides/setup';
  state.folderContext = true;
  state.collapsible = true;
  state.depth = 1;
});

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

it('keeps a non-collapsible folder trigger available without folder context', () => {
  state.folderContext = false;
  const folder = { ...guides, collapsible: false };

  const html = renderFolder(folder);

  expect(html).toContain('<button');
  expect(html).toContain('data-collapsible="false"');
});

it('keeps nested indexed folders generation-pinned and ignores external indexes for active state', () => {
  state.depth = 2;
  state.pathname = '/docs/current';
  const externalIndex: Item = { type: 'page', name: 'External guide', url: 'https://docs.example.invalid/guides', external: true };
  const folder: Folder = { ...guides, index: externalIndex };

  const html = renderFolder(folder);

  expect(html).toContain('data-folder-active="false"');
  expect(html).toContain('href="https://docs.example.invalid/guides" data-active="false" data-external="true"');
});

it('preserves active state for top-level items without nested folder depth', () => {
  state.depth = 0;

  const html = renderToStaticMarkup(createElement(RuntimeSidebarItem, { item: setup }));

  expect(html).toContain('href="/docs/guides/setup?g=00000000-0000-4000-8000-000000000001" data-active="true"');
});
