import { isValidElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import RepositoriesPage from '../../app/repositories/page';
import RepositoriesLoading from '../../app/repositories/loading';
import { AdminConsole, AdminSkeleton, AdminSkeletonCards } from '../../components/admin-console';
import { SiteNavigation } from '../../components/site-navigation';

const state = vi.hoisted(() => ({ headers: vi.fn(), requireAdmin: vi.fn() }));
vi.mock('next/headers', () => ({ headers: state.headers }));
vi.mock('@/lib/auth/admin', () => ({ requireAdmin: state.requireAdmin }));
vi.mock('../../components/sign-in-button', () => ({ SignInButton: vi.fn(() => null) }));

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
}

function navigationOptions(node: ReactNode): { showSignIn?: boolean; showAccountControls?: boolean } | undefined {
  if (Array.isArray(node)) return node.map(navigationOptions).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; showSignIn?: boolean; showAccountControls?: boolean }>(node)) return undefined;
  if (node.type === SiteNavigation) return node.props;
  return navigationOptions(node.props.children);
}

function includesComponent(node: ReactNode, component: unknown): boolean {
  if (Array.isArray(node)) return node.some(item => includesComponent(item, component));
  if (!isValidElement<{ children?: ReactNode }>(node)) return false;
  return node.type === component || includesComponent(node.props.children, component);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.headers.mockResolvedValue(new Headers({ cookie: 'session=synthetic' }));
  state.requireAdmin.mockResolvedValue({});
});

it('shows the configured repositories skeleton in the route loading boundary', () => {
  const loading = RepositoriesLoading();
  expect(includesComponent(loading, AdminSkeleton)).toBe(true);
  expect(text(loading)).not.toContain('Configured Repositories');
  expect(text(loading)).not.toContain('Configure repository sources and review synchronization status.');
  expect(text(AdminSkeletonCards()).trim()).toBe('');
  expect(text(AdminSkeleton()).trim()).toBe('');
});

it('passes the incoming session cookie to the admin gate and renders the console only after authorization', async () => {
  const result = await RepositoriesPage();
  expect(state.requireAdmin).toHaveBeenCalledOnce();
  const request = state.requireAdmin.mock.calls[0][0] as Request;
  expect(request.url).toBe('http://localhost/repositories');
  expect(request.headers.get('cookie')).toBe('session=synthetic');
  expect(isValidElement(result) && result.type).toBe(AdminConsole);
});

it('offers direct Zitadel sign-in only to anonymous sessions', async () => {
  state.headers.mockResolvedValue(new Headers());
  state.requireAdmin.mockRejectedValueOnce(new Error('admin_unauthorized'));
  const anonymous = await RepositoriesPage();
  expect(text(anonymous)).toContain('Sign in required');
  expect(navigationOptions(anonymous)).toMatchObject({ showSignIn: true, showAccountControls: false });
  expect(text(anonymous)).toContain('Sign in with an account assigned the librarian-admin role.');

  state.requireAdmin.mockRejectedValueOnce(new Error('admin_forbidden'));
  const denied = await RepositoriesPage();
  expect(text(denied)).toContain('Administrator access denied');
  expect(text(denied)).toContain('does not have the required administrator role');
  expect(text(denied)).toContain('If it was just assigned, the change may take up to 15 minutes to appear.');
  expect(navigationOptions(denied)).toMatchObject({ showSignIn: false, showAccountControls: true });
});

it('renders a generic unavailable state for unexpected authorization failures', async () => {
  state.requireAdmin.mockRejectedValue('unexpected');
  const result = await RepositoriesPage();
  expect(text(result)).toContain('Administration unavailable');
  expect(text(result)).toContain('could not be verified right now');
  expect(navigationOptions(result)).toMatchObject({ showSignIn: false, showAccountControls: true });
});
