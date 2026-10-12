import { expect, it } from 'vitest';
import { access } from '../../lib/access';

it.each(['', 'admin'])('denies the synthetic non-reader role %s', role => {
  expect(access(role)).toBe(false);
});
it('allows the synthetic reader role', () => {
  expect(access('reader')).toBe(true);
});
