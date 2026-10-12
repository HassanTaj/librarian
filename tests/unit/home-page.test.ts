import { isValidElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import Home from '../../app/page';

const state = vi.hoisted(() => ({ auth: vi.fn(), getMongo: vi.fn(), listDirectoryCards: vi.fn(), listDirectorySyncStatuses: vi.fn() }));
vi.mock('@/lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('@/lib/catalog', () => ({ listDirectoryCards: state.listDirectoryCards }));
vi.mock('@/lib/admin', () => ({ listDirectorySyncStatuses: state.listDirectorySyncStatuses }));
vi.mock('../../auth', () => ({ auth: state.auth }));
vi.mock('../../components/sign-in-button', () => ({ SignInButton: vi.fn(() => null) }));
vi.mock('../../components/private-content-guard', () => ({ AccountControls: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  state.auth.mockResolvedValue(null);
  state.getMongo.mockResolvedValue({ db: { marker: 'synthetic' } });
  state.listDirectoryCards.mockResolvedValue([{ slug: 'synthetic-project', title: 'Synthetic project' }]);
  state.listDirectorySyncStatuses.mockResolvedValue([{ slug: 'synthetic-project', status: 'running' }]);
});

it('loads configured directory cards and renders a healthy directory state', async () => {
  const result = await Home();
  expect(isValidElement(result)).toBe(true);
  expect(result.props).toMatchObject({ cards: [{ slug: 'synthetic-project', syncStatus: 'running' }], unavailable: false, showSignIn: true, showAccountControls: false });
  expect(state.listDirectoryCards).toHaveBeenCalledWith({ marker: 'synthetic' });
  expect(state.listDirectorySyncStatuses).toHaveBeenCalledWith({ marker: 'synthetic' }, ['synthetic-project']);
});

it('keeps the directory available when supplementary sync status cannot be loaded', async () => {
  state.listDirectorySyncStatuses.mockRejectedValueOnce(new Error('synthetic status error'));
  expect((await Home()).props).toMatchObject({ cards: [{ slug: 'synthetic-project' }], unavailable: false });
});

it('skips status lookup for an empty directory and leaves unmatched cards unchanged', async () => {
  state.listDirectoryCards.mockResolvedValueOnce([]);
  expect((await Home()).props.cards).toEqual([]);
  expect(state.listDirectorySyncStatuses).not.toHaveBeenCalled();

  state.listDirectoryCards.mockResolvedValueOnce([{ slug: 'unmatched-project', title: 'Unmatched project' }]);
  state.listDirectorySyncStatuses.mockResolvedValueOnce([]);
  expect((await Home()).props.cards).toEqual([{ slug: 'unmatched-project', title: 'Unmatched project' }]);
});

it('hides sign-in for an authenticated user and keeps it available if session lookup fails', async () => {
  state.auth.mockResolvedValueOnce({ user: { id: 'synthetic-user' } });
  expect((await Home()).props).toMatchObject({ showSignIn: false, showAccountControls: true });
  state.auth.mockRejectedValueOnce(new Error('synthetic auth failure'));
  expect((await Home()).props).toMatchObject({ showSignIn: true, showAccountControls: false });
});

it('renders an unavailable state when storage or the safe directory query fails', async () => {
  state.getMongo.mockRejectedValueOnce(new Error('synthetic storage error'));
  expect((await Home()).props).toMatchObject({ cards: [], unavailable: true });
  state.listDirectoryCards.mockRejectedValueOnce(new Error('synthetic query error'));
  expect((await Home()).props).toMatchObject({ cards: [], unavailable: true });
});
