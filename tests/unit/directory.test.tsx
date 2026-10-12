import { beforeEach, expect, it, vi } from 'vitest';
import Home from '../../app/page';
import { filterDirectoryCards, type DirectoryCard } from '../../components/directory';

const state = vi.hoisted(() => ({ auth: vi.fn(), getMongo: vi.fn(), listDirectoryCards: vi.fn(), db: {} }));
vi.mock('@/lib/mongo', () => ({ getMongo: state.getMongo }));
vi.mock('@/lib/catalog', () => ({ listDirectoryCards: state.listDirectoryCards }));
vi.mock('../../auth', () => ({ auth: state.auth }));
vi.mock('../../components/sign-in-button', () => ({ SignInButton: vi.fn(() => null) }));
vi.mock('../../components/private-content-guard', () => ({ AccountControls: () => null }));

const cards: DirectoryCard[] = [
  { slug: 'atlas', title: 'Atlas', publicDescription: 'Search-only phrase', visibility: 'public', url: '/atlas' },
  { slug: 'orion', title: 'Orion', publicDescription: 'A documentation project', visibility: 'private', url: '/orion' },
];

beforeEach(() => {
  vi.clearAllMocks();
  state.auth.mockResolvedValue(null);
  state.getMongo.mockResolvedValue({ db: state.db });
  state.listDirectoryCards.mockResolvedValue(cards);
});

it('filters project titles case-insensitively without searching descriptions', () => {
  expect(filterDirectoryCards(cards, ' AT ')).toEqual([cards[0]]);
  expect(filterDirectoryCards(cards, 'search-only')).toEqual([]);
  expect(filterDirectoryCards(cards, '  ')).toEqual(cards);
});

it('shows configured public and restricted cards and distinguishes storage failure from empty', async () => {
  const page = await Home();
  expect(state.listDirectoryCards).toHaveBeenCalledWith(state.db);
  expect(page.props.cards).toEqual(cards);
  expect(page.props.showSignIn).toBe(true);
  state.getMongo.mockRejectedValue(new Error('SYNTHETIC_STORAGE_FAILURE'));
  const unavailable = await Home();
  expect(unavailable.props.unavailable).toBe(true);
  expect(unavailable.props.cards).toEqual([]);
});

it('renders the empty state when storage succeeds with no enabled catalog cards', async () => {
  state.listDirectoryCards.mockResolvedValue([]);
  const page = await Home();
  expect(page.props.unavailable).not.toBe(true);
  expect(page.props.cards).toEqual([]);
  expect(page.props.showSignIn).toBe(true);
});
