import { createElement, isValidElement } from 'react';
import { expect, it } from 'vitest';
import { resolveCardIcon } from '../../lib/content/card-icons';

it('resolves allowlisted string icons and rejects unknown names', () => {
  const icon = resolveCardIcon('book-open');

  expect(isValidElement(icon)).toBe(true);
  expect(icon).toMatchObject({ props: { 'aria-hidden': true } });
  expect(resolveCardIcon('not-allowlisted')).toBeUndefined();
});

it('passes through non-string icon values unchanged', () => {
  const icon = createElement('span', { 'aria-label': 'Fixture icon' });

  expect(resolveCardIcon(icon)).toBe(icon);
  expect(resolveCardIcon(0)).toBe(0);
});
