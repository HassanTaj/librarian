import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores(['.next/**', '.source/**', '.local/**', 'node_modules/**', 'out/**', 'build/**', 'dist/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'blob-report/**', 'next-env.d.ts']),
]);
