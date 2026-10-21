import { register } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

register('./native-coverage-loader.mjs', import.meta.url, { data: { root: process.cwd() } });
const capture = process.env.LIBRARIAN_NATIVE_CAPTURE ?? join(process.env.LIBRARIAN_COVERAGE_PROCESS_DIR, `node-${randomUUID()}.json`);
process.on('exit', () => {
  writeFileSync(capture, JSON.stringify(globalThis.__VITEST_COVERAGE__ ?? {}));
});
