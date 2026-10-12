import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getMDXComponents, useMDXComponents } from '../../mdx-components';
import browserConfig from '../../playwright.config';
import lintConfig from '../../eslint.config.mjs';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each(['0', '1'])('keeps production maps private and enables original-source instrumentation only for coverage builds (%s)', async value => {
  vi.stubEnv('LIBRARIAN_COVERAGE_BUILD', value);
  vi.resetModules();
  const config = await (await import('../../next.config.mjs')).default;
  const coverage = value === '1';
  expect(config.productionBrowserSourceMaps).toBe(coverage);
  expect(config.experimental?.serverSourceMaps).toBe(coverage);
  expect(config.experimental?.serverMinification).toBe(!coverage);
  expect(config.output).toBe('standalone');
  const result = config.webpack!({ module: { rules: [{}, { use: ['unrelated-loader'] }, { use: [{ loader: 'unrelated-loader' }] }] } });
  const loaders = result.module.rules.flatMap((rule: { use?: unknown[] }) => rule.use ?? []);
  expect(JSON.stringify(loaders).includes('coverage-loader.mjs')).toBe(coverage);
  expect(JSON.stringify(loaders).includes('coverage-macro-loader.mjs')).toBe(false);
  const pre = result.module.rules.filter((rule: { enforce?: string }) => rule.enforce === 'pre');
  if (coverage) expect(pre.at(-1).use[0]).toContain('coverage-loader.mjs');
});

it('keeps all browser engines, strict retries and generated-artifact lint exclusions configured', () => {
  expect(browserConfig.projects?.map(project => project.name)).toEqual(['chromium', 'firefox', 'webkit']);
  expect(browserConfig.retries).toBe(0);
  expect(browserConfig.forbidOnly).toBe(true);
  expect(lintConfig.some(entry => entry.ignores?.includes('.local/**'))).toBe(true);
});

it('pre-optimizes Next Link for stable browser coverage startup', async () => {
  const config = (await import('../../vitest.config')).default;
  expect(config.optimizeDeps?.include).toContain('next/link');
});

it('uses explicit local browser and Next output paths when configured', async () => {
  vi.stubEnv('LIBRARIAN_BROWSER_EXECUTABLE', 'C:/synthetic/browser.exe');
  vi.stubEnv('LIBRARIAN_NEXT_DIST_DIR', 'scratch/next');
  vi.resetModules();
  const playwright = (await import('../../playwright.config')).default;
  expect(playwright.use?.launchOptions).toEqual({ executablePath: 'C:/synthetic/browser.exe' });
  const next = (await import('../../next.config.mjs')).default;
  expect(next.distDir).toBe('scratch/next');
});

it('uses the standard Next output directory when no override is configured', async () => {
  const previous = process.env.LIBRARIAN_NEXT_DIST_DIR;
  delete process.env.LIBRARIAN_NEXT_DIST_DIR;
  vi.resetModules();
  try {
    expect((await import('../../next.config.mjs')).default.distDir).toBe('.next');
  } finally {
    if (previous === undefined) delete process.env.LIBRARIAN_NEXT_DIST_DIR;
    else process.env.LIBRARIAN_NEXT_DIST_DIR = previous;
  }
});

it('preserves default MDX components while allowing explicit overrides', () => {
  expect(Object.keys(getMDXComponents()).length).toBeGreaterThan(0);
  const heading = () => null;
  expect(getMDXComponents({ h1: heading }).h1).toBe(heading);
  expect(useMDXComponents).toBe(getMDXComponents);
});

it.each(['0', '1'])('keeps the original-source Vitest plugin limited to inventoried files (%s)', async value => {
  vi.stubEnv('LIBRARIAN_COVERAGE_BUILD', value);
  vi.stubEnv('LIBRARIAN_BROWSER_EXECUTABLE', value === '1' ? 'C:/synthetic/browser.exe' : '');
  vi.resetModules();
  const config = (await import('../../vitest.config')).default;
  const [plugin] = config.plugins as Array<{ transform: (code: string, id: string) => { code: string; map: string } | undefined }>;
  expect(plugin.transform('const synthetic = 1;', resolve('tests/synthetic.ts'))).toBeUndefined();
  const file = resolve('lib/config.ts');
  const transformed = plugin.transform(await readFile(file, 'utf8'), `${file}?source`);
  if (value === '1') expect(transformed?.code).toContain('__VITEST_COVERAGE__');
  else expect(transformed).toBeUndefined();
});
