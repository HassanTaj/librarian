import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import coverageLoader, { instrumentSource } from '../../scripts/coverage-loader.mjs';
import { pathToFileURL } from 'node:url';

it('keeps original source ranges and records executed and unexecuted code', () => {
  const source = 'function allowed(role: string) { if (role === "reader") return true; return false; }\nfunction unused() { return 1; }';
  const result = instrumentSource(source, '/synthetic/lib/access.ts');
  // Strip only TypeScript's annotation to execute this synthetic module in a plain VM.
  const context: { __VITEST_COVERAGE__?: Record<string, { f: Record<string, number>; b: Record<string, number[]> }> } = {};
  runInNewContext(`${result.code.replace('role: string', 'role')}; allowed("admin");`, context);
  const data = context.__VITEST_COVERAGE__!['/synthetic/lib/access.ts'];
  expect(Object.values(data.f)).toEqual([1, 0]);
  expect(Object.values(data.b).flat()).toContain(0);
  expect(result.map?.sourcesContent).toEqual([source]);
  expect(result.map.sources).toEqual([pathToFileURL('/synthetic/lib/access.ts').href]);
  expect(result.map?.mappings.length).toBeGreaterThan(0);
});

it('passes instrumented code and its source map through the webpack loader contract', () => {
  let output: unknown[] = [];
  coverageLoader.call({ resourcePath: '/synthetic/lib/value.ts', callback(...args: unknown[]) { output = args; } }, 'export const value = 1;');
  expect(output[0]).toBeNull();
  expect(output[1]).toContain('__VITEST_COVERAGE__');
  expect(output[2]).toMatchObject({ sourcesContent: ['export const value = 1;'] });
});

it('rejects malformed source instead of producing an empty coverage report', () => {
  expect(() => instrumentSource('export function broken(', '/synthetic/lib/broken.ts')).toThrow();
});

it('rejects an ignore-file hint instead of silently excluding first-party code', () => {
  expect(() => instrumentSource('/* istanbul ignore file */\nexport const value = 1;', '/synthetic/lib/ignored.ts')).toThrow('not allowed');
  expect(instrumentSource('const literal = "/* istanbul ignore next */";', '/synthetic/lib/literal.ts').coverage?.s).toEqual({ '0': 0 });
});

it('keeps an empty source represented without inventing executable counters', () => {
  const result = instrumentSource('', '/synthetic/lib/empty.ts');
  expect(result.map.sourcesContent).toEqual(['']);
  expect(result.coverage?.s).toEqual({});
});

