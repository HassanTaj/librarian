import { expect, it } from 'vitest';
import { createBoundedLru } from '../../lib/content/lru';

it('keeps bounded entries, expires idle values and updates LRU order', () => {
  let now = 0;
  const cache = createBoundedLru<string>(2, 10, 100, () => now);
  expect(cache.set('a', 'a', 6)).toBe(true);
  expect(cache.set('b', 'b', 4)).toBe(true);
  const a = cache.acquire('a')!;
  expect(a.value).toBe('a');
  a.release();
  expect(cache.set('c', 'c', 4)).toBe(true);
  expect(cache.stats()).toEqual({ entries: 2, bytes: 10 });
  expect(cache.acquire('b')).toBeUndefined();
  now = 101;
  expect(cache.acquire('a')).toBeUndefined();
  expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
});

it('preserves active pins under pressure and accounts for a serialized search index', () => {
  const cache = createBoundedLru<object>(2, 10, 1000, () => 0);
  cache.set('a', {}, 4);
  cache.set('b', {}, 4);
  const active = cache.acquire('a')!;
  expect(cache.set('c', {}, 5)).toBe(true);
  const pinned = cache.acquire('a')!;
  expect(pinned.value).toBe(active.value);
  pinned.release();
  expect(cache.acquire('b')).toBeUndefined();
  active.release();
  expect(cache.updateSize('c', 9)).toBe(true);
  expect(cache.acquire('a')).toBeUndefined();
  expect(cache.updateSize('c', 11)).toBe(false);
  expect(cache.stats()).toEqual({ entries: 1, bytes: 9 });
});

it('rejects impossible sizes without evicting live entries', () => {
  const cache = createBoundedLru<object>(1, 8, 1000, () => 0);
  const value = {};
  cache.set('live', value, 8);
  expect(cache.set('oversized', {}, 9)).toBe(false);
  expect(cache.acquire('live')?.value).toBe(value);
});

it('does not evict a pinned entry to fit a new cache value', () => {
  const cache = createBoundedLru<object>(1, 4, 1000, () => 0);
  cache.set('live', {}, 4);
  const active = cache.acquire('live')!;
  expect(cache.set('next', {}, 1)).toBe(false);
  expect(cache.stats()).toEqual({ entries: 1, bytes: 4 });
  active.release();
});
