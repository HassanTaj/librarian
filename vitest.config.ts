import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { sourceInventory } from './scripts/check-coverage.mjs';
import { instrumentSource } from './scripts/coverage-loader.mjs';

const coverageSources = process.env.LIBRARIAN_COVERAGE_BUILD === '1'
  ? new Set(await sourceInventory(process.cwd())) : new Set<string>();
const browserLaunchOptions = process.env.LIBRARIAN_BROWSER_EXECUTABLE
  ? { executablePath: process.env.LIBRARIAN_BROWSER_EXECUTABLE } : undefined;

export default defineConfig({
  // Next's browser exports use compile-time environment constants, not a browser process.
  define: { 'process.env.NODE_ENV': JSON.stringify('test'), 'process.env.__NEXT_ROUTER_BASEPATH': '""' },
  plugins: [{ name: 'original-source-coverage', enforce: 'pre', transform(code, id) {
    const file = resolve(id.split('?')[0]);
    if (coverageSources.has(file)) {
      const result = instrumentSource(code, file);
      return { code: result.code, map: JSON.stringify(result.map) };
    }
  } }],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)), 'next/server': fileURLToPath(new URL('./node_modules/next/server.js', import.meta.url)) } },
  optimizeDeps: { include: ['next/link'] },
  test: {
    retry: 0,
    allowOnly: false,
    passWithNoTests: false,
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node', server: { deps: { inline: ['next-auth'] } } } },
      { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], exclude: ['tests/integration/container.test.ts'], environment: 'node', testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false, server: { deps: { inline: ['next-auth'] } } } },
      { extends: true, test: { name: 'container', include: ['tests/integration/container.test.ts'], environment: 'node', testTimeout: 180_000, hookTimeout: 180_000 } },
      { extends: true, test: {
        name: 'client', include: ['tests/client/**/*.test.tsx'],
        browser: { enabled: true, headless: true, provider: playwright({ launchOptions: browserLaunchOptions }), instances: [{ browser: 'chromium' }] },
      } },
    ],
    coverage: {
      provider: 'istanbul',
      excludeAfterRemap: true,
      include: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}', 'auth.ts', 'instrumentation.ts', 'mdx-components.tsx', 'scripts/*.mjs', '*config.{ts,mjs}'],
      exclude: ['postcss.config.mjs'],
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
    },
  },
});
