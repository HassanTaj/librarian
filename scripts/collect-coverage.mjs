import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureSources, verifyInstrumentedCoverage } from './coverage-provenance.mjs';
import { sourceInventory, capabilityScopes, runCoverageCheck } from './check-coverage.mjs';
import { instrumentSource } from './coverage-loader.mjs';

export async function assembleEvidence(root, node, server, tests, sources, processCaptures = []) {
  const coverage = await verifyInstrumentedCoverage(node, sources);
  const hashes = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, source.hash]));
  const inventory = await sourceInventory(root);
  const baseline = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, instrumentSource(source.code, file).coverage]));
  const processes = await Promise.all(processCaptures.map(async report => ({
    kind: report.kind, coverage: await verifyInstrumentedCoverage(report.coverage, sources), hashes,
  })));
  return {
    inventory, scopes: capabilityScopes(root, inventory),
    reports: [{ kind: 'inventory', coverage: baseline, hashes }, { kind: 'node', coverage, hashes }, ...server.reports, ...processes],
    tests: { passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests + tests.numTodoTests },
    server: server.server, browser: server.browser,
  };
}

export async function collectCoverage(root) {
  await mkdir(resolve(root, 'coverage'), { recursive: true });
  for (const file of ['evidence.json', 'server-evidence.json', 'native-evidence.json', 'tests.json']) await rm(resolve(root, 'coverage', file), { force: true });
  const sources = await captureSources(root);
  const processDirectory = await mkdtemp(resolve(root, 'coverage/process-'));
  const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'unit', '--project', 'integration', '--project', 'client', '--coverage', '--coverage.reportsDirectory=coverage/node', '--reporter=json', '--outputFile=coverage/tests.json'], {
    cwd: root, env: { ...process.env, LIBRARIAN_COVERAGE_BUILD: '1', LIBRARIAN_NEXT_DIST_DIR: 'coverage/next-spike/build', LIBRARIAN_COVERAGE_PROCESS_DIR: processDirectory }, stdio: 'inherit', windowsHide: true,
  });
  try {
    const [code, signal] = await once(child, 'exit');
    if (code !== 0) throw new Error(`Coverage test process failed (${code ?? signal ?? 'unknown exit'})`);
    const load = async file => JSON.parse(await readFile(resolve(root, 'coverage', file), 'utf8'));
    const processes = await Promise.all((await readdir(processDirectory)).map(async file => {
      if (!/^(node|server)-[0-9a-f-]+\.json$/.test(file)) throw new Error('Invalid subprocess coverage capture');
      return { kind: file.startsWith('server-') ? 'server' : 'node', coverage: JSON.parse(await readFile(resolve(processDirectory, file), 'utf8')) };
    }));
    const evidence = await assembleEvidence(root, await load('node/coverage-final.json'), await load('server-evidence.json'), await load('tests.json'), sources, processes);
    evidence.reports.push(await load('native-evidence.json'));
    await writeFile(resolve(root, 'coverage/evidence.json'), JSON.stringify(evidence));
    return runCoverageCheck(root);
  } finally {
    // mkdtemp created this exact disposable directory inside this run's coverage root.
    await rm(processDirectory, { recursive: true, force: true });
    await rm(resolve(root, 'coverage/next-spike/build'), { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await collectCoverage(process.cwd()), null, 2)); }
  catch (error) { console.error(`Coverage collection/gate failed: ${error.message}`); process.exitCode = 1; }
}
