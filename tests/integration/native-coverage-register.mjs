import { register } from 'node:module';
import { writeFileSync } from 'node:fs';

register('./native-coverage-loader.mjs', import.meta.url, { data: { root: process.cwd() } });
process.on('exit', code => {
  if (code === 0) writeFileSync(process.env.LIBRARIAN_NATIVE_CAPTURE, JSON.stringify(globalThis.__VITEST_COVERAGE__ ?? {}));
});
