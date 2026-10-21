import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureSources, verifyInstrumentedCoverage } from '../../scripts/coverage-provenance.mjs';

it('covers executable configuration excluded by Vitest using a real instrumented Node process', async () => {
  const root = process.cwd();
  await mkdir(resolve(root, 'coverage'), { recursive: true });
  const sources = await captureSources(root);
  const file = resolve(root, 'coverage/native-counters.json');
  const child = spawn(process.execPath, [`--import=${pathToFileURL(resolve(root, 'tests/integration/native-coverage-register.mjs')).href}`, resolve(root, 'tests/integration/config-process.mjs')], {
    cwd: root, env: { ...process.env, LIBRARIAN_NATIVE_CAPTURE: file, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore', windowsHide: true,
  });
  expect((await once(child, 'exit'))[0]).toBe(0);
  const coverage = await verifyInstrumentedCoverage(JSON.parse(await readFile(file, 'utf8')), sources);
  expect(Object.values(coverage[resolve(root, 'vitest.config.ts')].f).some(hit => hit > 0)).toBe(true);
  const hashes = Object.fromEntries(Object.entries(sources).map(([path, source]) => [path, source.hash]));
  await writeFile(resolve(root, 'coverage/native-evidence.json'), JSON.stringify({ kind: 'node', coverage, hashes }));
}, 30_000);

it('captures verified original-source counters from an intentionally rejected operator process', async () => {
  const root = process.cwd();
  await mkdir(resolve(root, 'coverage'), { recursive: true });
  const directory = await mkdtemp(resolve(root, 'coverage/operator-process-'));
  try {
    const sources = await captureSources(root);
    const file = resolve(process.env.LIBRARIAN_COVERAGE_PROCESS_DIR ?? directory, `node-${randomUUID()}.json`);
    const child = spawn(process.execPath, [`--import=${pathToFileURL(resolve('tests/integration/native-coverage-register.mjs')).href}`,
      resolve('scripts/instance-operator.mjs')], {
      cwd: root, env: { ...process.env, LIBRARIAN_NATIVE_CAPTURE: file }, stdio: 'ignore', windowsHide: true,
    });
    expect((await once(child, 'exit'))[0]).toBe(1);
    const coverage = await verifyInstrumentedCoverage(JSON.parse(await readFile(file, 'utf8')), sources);
    expect(Object.values(coverage[resolve('scripts/instance-operator.mjs')].s).some(hit => hit > 0)).toBe(true);
  } finally {
    // This exact directory was created by mkdtemp under the generated coverage root.
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
