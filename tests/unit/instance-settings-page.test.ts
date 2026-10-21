import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import * as page from '../../app/instance/settings/page';

const state = vi.hoisted(() => ({
  status: vi.fn(), requireAdmin: vi.fn(), headers: vi.fn(), reader: vi.fn(), metadata: vi.fn(), navigation: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: state.headers }));
vi.mock('../../lib/instance/bootstrap', () => ({ readInstanceSetupStatus: state.status }));
vi.mock('../../lib/instance/access', () => ({ requireInstanceAdmin: state.requireAdmin }));
vi.mock('../../components/instance-settings', () => ({ InstanceSettings: () => createElement('p', null, 'Settings controls') }));
vi.mock('../../components/site-navigation', () => ({ SiteNavigation: (props: Record<string, unknown>) => {
  state.navigation(props); return createElement('nav', null, String(props.displayName ?? 'Navigation'));
} }));
vi.mock('../../app/[repoSlug]/[[...page]]/page', () => ({ default: state.reader, generateMetadata: state.metadata }));
vi.mock('next-auth/react', () => ({ SessionProvider: ({ children }: { children: ReactNode }) => children }));

beforeEach(() => {
  vi.clearAllMocks();
  state.status.mockResolvedValue({ namespaceAvailable: true });
  state.headers.mockResolvedValue(new Headers());
  state.requireAdmin.mockResolvedValue({ control: { active: { preferences: { displayName: 'Synthetic active brand' } } } });
  state.reader.mockResolvedValue(createElement('p', null, 'Existing catalog reader'));
  state.metadata.mockResolvedValue({ title: 'Existing catalog metadata' });
});

it('keeps the Settings page dynamic and exposes only safe active branding for bound admins', async () => {
  expect(page).toMatchObject({ dynamic: 'force-dynamic', revalidate: 0 });
  const html = renderToStaticMarkup(await page.default());
  expect(html).toContain('Synthetic active brand'); expect(html).toContain('Settings controls');
  expect(state.navigation).toHaveBeenCalledWith(expect.objectContaining({
    showSignIn: false, showAccountControls: true, showInstanceSettings: true, displayName: 'Synthetic active brand',
  }));
  expect(await page.generateMetadata()).toEqual({ title: 'Instance Settings | Librarian' });
});

it('renders the original catalog route and metadata when its namespace is occupied', async () => {
  state.status.mockResolvedValue({ namespaceAvailable: false });
  const html = renderToStaticMarkup(await page.default());
  expect(html).toContain('Existing catalog reader'); expect(state.requireAdmin).not.toHaveBeenCalled();
  expect(await page.generateMetadata()).toEqual({ title: 'Existing catalog metadata' });
  const route = state.reader.mock.calls[0][0];
  expect(await route.params).toEqual({ repoSlug: 'instance', page: ['settings'] });
});

it('shows distinct safe sign-in, forbidden, and unavailable states without rendering controls', async () => {
  const cases = [
    ['instance_unauthorized', 'Sign in to continue.', true, false],
    ['instance_forbidden', 'An explicit instance binding and the librarian-instance-admin role are required.', false, true],
    ['instance_unavailable', 'Instance settings are temporarily unavailable.', false, true],
  ] as const;
  for (const [message, expected, showSignIn, showAccountControls] of cases) {
    state.requireAdmin.mockRejectedValueOnce(new Error(message));
    const html = renderToStaticMarkup(await page.default());
    expect(html).toContain(expected); expect(html).not.toContain('Settings controls');
    expect(state.navigation).toHaveBeenLastCalledWith(expect.objectContaining({ showSignIn, showAccountControls, showInstanceSettings: false }));
  }
  state.requireAdmin.mockRejectedValueOnce('unexpected failure');
  expect(renderToStaticMarkup(await page.default())).toContain('Instance settings are temporarily unavailable.');
});
