import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Directory, type DirectoryCard } from '../../components/directory';

const state = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock('next-auth/react', () => ({ signIn: state.signIn }));

let container: HTMLDivElement;
let root: Root;
const cards: DirectoryCard[] = [
  { slug: 'atlas', title: 'Atlas', publicDescription: 'Public docs', visibility: 'public', url: '/atlas' },
  { slug: 'orion', title: 'Orion', publicDescription: 'Restricted docs', visibility: 'private', url: '/orion' },
];

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function filter(value: string) {
  const input = container.querySelector<HTMLInputElement>('#project-filter')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('filters configured titles, hides sign-in by default, and labels public and restricted projects', async () => {
  await act(async () => root.render(<Directory cards={cards} />));
  expect(container.textContent).not.toContain('Sign in with Zitadel');
  expect(container.textContent).toContain('Public');
  expect(container.textContent).toContain('Restricted');
  expect(container.querySelector('ul')?.className).toContain('sm:grid-cols-2');
  await filter(' ORI ');
  expect(container.querySelectorAll('ul a')).toHaveLength(1);
  expect(container.querySelector('ul')?.textContent).toContain('Orion');
  await filter('restricted docs');
  expect(container.textContent).toContain('No projects match that title.');
});

it('shows the sign-in button only for signed-out visitors and directly starts the Zitadel provider flow', async () => {
  await act(async () => root.render(<Directory cards={cards} showSignIn />));
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === 'Sign in with Zitadel');
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(state.signIn).toHaveBeenCalledWith('zitadel', { redirectTo: '/admin' });

  await act(async () => root.render(<Directory cards={cards} showSignIn={false} />));
  expect(container.textContent).not.toContain('Sign in with Zitadel');
});

it('shows the existing sign-out control for authenticated directory visitors', async () => {
  await act(async () => root.render(<Directory cards={cards} showAccountControls />));
  expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Sign out')).toBe(true);
  expect(container.textContent).not.toContain('Sign in with Zitadel');
});

it('distinguishes an empty directory from an unavailable directory', async () => {
  await act(async () => root.render(<Directory cards={[]} showSignIn />));
  expect(container.textContent).toContain('No documentation projects are available yet.');
  await act(async () => root.render(<Directory cards={cards} showSignIn unavailable />));
  expect(container.querySelector('[role="status"]')?.textContent).toContain('temporarily unavailable');
  expect(container.querySelector('#project-filter')).toBeNull();
});

it('shows accessible status labels with running green and synced primary styling', async () => {
  const statuses = ['pending', 'running', 'succeeded', 'failed'] as const;
  const colors = ['text-amber-800', 'text-green-800', 'text-primary', 'text-red-800'];
  const statusCards = statuses.map((syncStatus, index) => ({ ...cards[index % cards.length], slug: `status-${syncStatus}`, syncStatus }));
  await act(async () => root.render(<Directory cards={statusCards} />));
  for (const [index, status] of statuses.entries()) {
    const badge = container.querySelector(`[aria-label="Sync status: ${status}"]`);
    expect(badge?.className).toContain(colors[index]);
    expect(badge?.textContent).toBe(status);
  }
});
