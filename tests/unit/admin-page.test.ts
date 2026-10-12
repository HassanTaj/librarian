import { isValidElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import AdminPage from '../../app/admin/page';
import { AdminConsole } from '../../components/admin-console';
import { AccountControls } from '../../components/private-content-guard';
import { SignInButton } from '../../components/sign-in-button';

const state = vi.hoisted(() => ({ headers: vi.fn(), requireAdmin: vi.fn() }));
vi.mock('next/headers', () => ({ headers: state.headers }));
vi.mock('@/lib/auth/admin', () => ({ requireAdmin: state.requireAdmin }));
vi.mock('../../components/sign-in-button', () => ({ SignInButton: vi.fn(() => null) }));

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
}

function containsType(node: ReactNode, type: unknown): boolean {
  if (Array.isArray(node)) return node.some(item => containsType(item, type));
  return isValidElement<{ children?: ReactNode }>(node) && (node.type === type || containsType(node.props.children, type));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.headers.mockResolvedValue(new Headers({ cookie: 'session=synthetic' }));
  state.requireAdmin.mockResolvedValue({});
});

it('passes the incoming session cookie to the admin gate and renders the console only after authorization', async () => {
  const result = await AdminPage();
  expect(state.requireAdmin).toHaveBeenCalledOnce();
  const request = state.requireAdmin.mock.calls[0][0] as Request;
  expect(request.headers.get('cookie')).toBe('session=synthetic');
  expect(isValidElement(result) && result.type).toBe(AdminConsole);
});

it('offers direct Zitadel sign-in only to anonymous sessions', async () => {
  state.headers.mockResolvedValue(new Headers());
  state.requireAdmin.mockRejectedValueOnce(new Error('admin_unauthorized'));
  const anonymous = await AdminPage();
  expect(text(anonymous)).toContain('Sign in required');
  expect(text(anonymous)).toContain('Back to home');
  expect(text(anonymous)).toContain('Sign in with an account assigned the librarian-admin role.');
  expect(containsType(anonymous, SignInButton)).toBe(true);

  state.requireAdmin.mockRejectedValueOnce(new Error('admin_forbidden'));
  const denied = await AdminPage();
  expect(text(denied)).toContain('Administrator access denied');
  expect(text(denied)).toContain('does not have the required administrator role');
  expect(text(denied)).toContain('If it was just assigned, the change may take up to 15 minutes to appear.');
  expect(text(denied)).toContain('Back to home');
  expect(containsType(denied, AccountControls)).toBe(true);
  expect(containsType(denied, SignInButton)).toBe(false);
});

it('renders a generic unavailable state for unexpected authorization failures', async () => {
  state.requireAdmin.mockRejectedValue('unexpected');
  const result = await AdminPage();
  expect(text(result)).toContain('Administration unavailable');
  expect(text(result)).toContain('could not be verified right now');
  expect(text(result)).toContain('Back to home');
  expect(containsType(result, AccountControls)).toBe(true);
});
