import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

for (const flag of ['0', '1']) {
  process.env.LIBRARIAN_COVERAGE_BUILD = flag;
  const next = await (await import(`${pathToFileURL(resolve('next.config.mjs')).href}?mode=${flag}`)).default;
  assert.equal(next.productionBrowserSourceMaps, flag === '1');
  const config = next.webpack({ module: { rules: [{}, { use: ['unrelated'] }] } }, { defaultLoaders: { babel: 'synthetic' } });
  assert.equal(JSON.stringify(config.module.rules).includes('coverage-loader.mjs'), flag === '1');
  const vitest = (await import(`${pathToFileURL(resolve('vitest.config.ts')).href}?mode=${flag}`)).default;
  const plugin = vitest.plugins[0];
  assert.equal(plugin.transform('const synthetic = 1;', resolve('tests/synthetic.ts')), undefined);
  const file = resolve('lib/config.ts');
  const transformed = plugin.transform(await readFile(file, 'utf8'), file);
  assert.equal(Boolean(transformed), flag === '1');
}
