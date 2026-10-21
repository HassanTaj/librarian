import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import * as page from '../../app/instance/setup/page';

const state = vi.hoisted(() => ({ status: vi.fn(), reader: vi.fn(), metadata: vi.fn() }));
vi.mock('../../lib/instance/bootstrap', () => ({ readInstanceSetupStatus: state.status, hasLegacyEnrollment: async () => false, hasInstanceRecovery: async () => false }));
vi.mock('../../components/instance-setup', () => ({ InstanceSetup: () => createElement('p', null, 'Synthetic protected wizard') }));
vi.mock('next-auth/react', () => ({ SessionProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../app/[repoSlug]/[[...page]]/page', () => ({ default: state.reader, generateMetadata: state.metadata }));

beforeEach(() => {
  vi.clearAllMocks();
  state.status.mockResolvedValue({ state: 'setup_required', prerequisitesAvailable: true, namespaceAvailable: true });
  state.reader.mockResolvedValue(createElement('p', null, 'Existing protected catalog route'));
  state.metadata.mockResolvedValue({ title: 'Existing catalog metadata' });
});

it('requires request-time rendering so a build cannot freeze the setup authorization gate', () => {
  expect(page).toMatchObject({ dynamic: 'force-dynamic', revalidate: 0 });
});

it('rechecks setup state and closes fresh enrollment after initialization or loss of prerequisites', async () => {
  expect(renderToStaticMarkup(await page.default())).toContain('Synthetic protected wizard');
  state.status.mockResolvedValue({ state: 'ready', prerequisitesAvailable: true, namespaceAvailable: true });
  const ready = renderToStaticMarkup(await page.default());
  expect(ready).toContain('Setup is complete'); expect(ready).not.toContain('Synthetic protected wizard');
  state.status.mockResolvedValue({ state: 'maintenance', prerequisitesAvailable: false, namespaceAvailable: true });
  const unavailable = renderToStaticMarkup(await page.default());
  expect(unavailable).toContain('Setup is unavailable'); expect(unavailable).not.toContain('Synthetic protected wizard');
  expect(state.status).toHaveBeenCalledTimes(3);
});

it('does not offer enrollment when fresh host prerequisites are missing', async () => {
  state.status.mockResolvedValue({ state: 'setup_required', prerequisitesAvailable: false, namespaceAvailable: true });
  const html = renderToStaticMarkup(await page.default());
  expect(html).toContain('Setup is unavailable'); expect(html).not.toContain('Synthetic protected wizard');
});

it('delegates a preexisting instance catalog and its metadata to the existing protected reader', async () => {
  state.status.mockResolvedValue({ state: 'maintenance', prerequisitesAvailable: true, namespaceAvailable: false });
  expect(renderToStaticMarkup(await page.default())).toContain('Existing protected catalog route');
  const route = state.reader.mock.calls[0][0];
  expect(await route.params).toEqual({ repoSlug: 'instance', page: ['setup'] });
  expect(await page.generateMetadata()).toEqual({ title: 'Existing catalog metadata' });
  expect(state.metadata).toHaveBeenCalledWith(route);
});

it('keeps an unavailable namespace check in maintenance without guessing that a catalog collision exists', async () => {
  state.status.mockResolvedValue({ state: 'maintenance', prerequisitesAvailable: false, namespaceAvailable: null });
  expect(renderToStaticMarkup(await page.default())).toContain('Setup is unavailable');
  expect(state.reader).not.toHaveBeenCalled();
  expect(await page.generateMetadata()).toEqual({ title: 'Instance setup | Perspective V', description: 'Configure this Librarian instance.' });
  expect(state.metadata).not.toHaveBeenCalled();
});

it('uses generic setup metadata without exposing host identity or authority', async () => {
  expect(await page.generateMetadata()).toEqual({ title: 'Instance setup | Perspective V', description: 'Configure this Librarian instance.' });
  expect(state.metadata).not.toHaveBeenCalled();
});
