import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureSources, verifyInstrumentedCoverage } from './coverage-provenance.mjs';
import { sourceInventory, capabilityScopes, runCoverageCheck } from './check-coverage.mjs';
import { instrumentSource } from './coverage-loader.mjs';

export async function assembleEvidence(root, node, server, tests, sources) {
  const coverage = await verifyInstrumentedCoverage(node, sources);
  const hashes = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, source.hash]));
  const inventory = await sourceInventory(root);
  const baseline = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, instrumentSource(source.code, file).coverage]));
  return {
    inventory, scopes: capabilityScopes(root, inventory),
    reports: [{ kind: 'inventory', coverage: baseline, hashes }, { kind: 'node', coverage, hashes }, ...server.reports],
    tests: { passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests + tests.numTodoTests },
    server: server.server, browser: server.browser,
  };
}

export async function collectCoverage(root) {
  await mkdir(resolve(root, 'coverage'), { recursive: true });
  for (const file of ['evidence.json', 'server-evidence.json', 'native-evidence.json', 'tests.json']) await rm(resolve(root, 'coverage', file), { force: true });
  const sources = await captureSources(root);
  const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'unit', '--project', 'integration', '--project', 'client', '--coverage', '--coverage.reportsDirectory=coverage/node', '--reporter=json', '--outputFile=coverage/tests.json'], {
    cwd: root, env: { ...process.env, LIBRARIAN_COVERAGE_BUILD: '1', LIBRARIAN_NEXT_DIST_DIR: 'coverage/next-spike/build' }, stdio: 'inherit', windowsHide: true,
  });
  try {
    const [code, signal] = await once(child, 'exit');
    if (code !== 0) throw new Error(`Coverage test process failed (${code ?? signal ?? 'unknown exit'})`);
    const load = async file => JSON.parse(await readFile(resolve(root, 'coverage', file), 'utf8'));
    const evidence = await assembleEvidence(root, await load('node/coverage-final.json'), await load('server-evidence.json'), await load('tests.json'), sources);
    evidence.reports.push(await load('native-evidence.json'));
    await writeFile(resolve(root, 'coverage/evidence.json'), JSON.stringify(evidence));
    return runCoverageCheck(root);
  } finally {
    await rm(resolve(root, 'coverage/next-spike/build'), { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await collectCoverage(process.cwd()), null, 2)); }
  catch (error) { console.error(`Coverage collection/gate failed: ${error.message}`); process.exitCode = 1; }
}
