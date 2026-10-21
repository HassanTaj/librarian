import { expect, it } from 'vitest';
import { access, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assembleEvidence, collectCoverage } from '../../scripts/collect-coverage.mjs';
import { captureSources } from '../../scripts/coverage-provenance.mjs';
import { instrumentSource } from '../../scripts/coverage-loader.mjs';

async function createCoverageFixture(testSource: string) {
  const root = await mkdtemp(join(tmpdir(), 'librarian-coverage-fixture-'));
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'junction');
  await mkdir(join(root, 'lib'));
  await mkdir(join(root, 'tests/unit'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'lib/config.ts'), 'export function value() { return 1; }');
  await writeFile(join(root, 'tests/unit/value.test.ts'), testSource);
  await writeFile(join(root, 'vitest.config.ts'), 'export default { test: { projects: ["unit", "integration", "client"].map(name => ({ test: { name, include: ["tests/unit/*.test.ts"], environment: "node" } })), coverage: { provider: "istanbul", include: ["lib/*.ts"], reporter: ["json"] } } };');
  return root;
}

it('assembles actual test counts, source hashes and capability membership without hiding skipped tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-evidence-'));
  try {
    await mkdir(join(root, 'lib'));
    const file = join(root, 'lib/config.ts');
    const code = 'export function value() { return 1; }';
    await writeFile(file, code);
    const sources = await captureSources(root);
    const coverage = { [file]: instrumentSource(code, file).coverage! };
    const server = { reports: [{ kind: 'server', coverage }], server: { exited: true }, browser: { captured: true } };
    const tests = { numPassedTests: 3, numFailedTests: 1, numPendingTests: 2, numTodoTests: 1 };
    const evidence = await assembleEvidence(root, coverage, server, tests, sources);
    expect(evidence.tests).toEqual({ passed: 3, failed: 1, skipped: 3 });
    expect(evidence.inventory).toEqual([file]);
    expect(evidence.scopes).toEqual({ C7: [file], C6: [file] });
    expect(evidence.reports[0].hashes[file]).toBe(sources[file].hash);
    expect(Object.values(evidence.reports[0].coverage[file].f)).toEqual([0]);
    expect(evidence.reports[1].kind).toBe('node');
    expect(evidence.reports[2]).toEqual(server.reports[0]);
    expect(evidence.browser).toEqual(server.browser);
    const counters = structuredClone(coverage);
    counters[file].s['0'] = 1;
    const withProcess = await assembleEvidence(root, coverage, server, tests, sources, [{ kind: 'server', coverage: counters }]);
    expect(withProcess.reports[3]).toEqual({ kind: 'server', coverage: counters, hashes: { [file]: sources[file].hash } });
    const invalid = structuredClone(counters);
    invalid[file].statementMap['0'].start.line++;
    await expect(assembleEvidence(root, coverage, server, tests, sources, [{ kind: 'server', coverage: invalid }])).rejects.toThrow('differs from original');
    await writeFile(file, `${code}// mutation`);
    await expect(assembleEvidence(root, coverage, server, tests, sources)).rejects.toThrow('changed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('fails when a real passing Node suite has no actual server evidence', async () => {
  const root = await createCoverageFixture('import { it, expect } from "vitest"; import { value } from "../../lib/config"; it("executes a real fixture function", () => { expect(value()).toBe(1); });');
  try {
    await expect(collectCoverage(root)).rejects.toThrow('server-evidence.json');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

it('includes unexecuted instance runtime files in both the baseline and C7 instead of excluding them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-instance-evidence-'));
  try {
    await mkdir(join(root, 'lib/instance'), { recursive: true });
    const file = join(root, 'lib/instance/store.ts');
    await writeFile(file, 'export function store() { return 1; }');
    const sources = await captureSources(root);
    const evidence = await assembleEvidence(root, {}, { reports: [], server: {}, browser: {} }, { numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 }, sources);
    expect(evidence.inventory).toEqual([file]);
    expect(evidence.scopes.C7).toEqual([file]);
    expect(Object.values(evidence.reports[0].coverage[file].f)).toEqual([0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('fails coverage collection when a required test project exits unsuccessfully', async () => {
  const root = await createCoverageFixture('import { it, expect } from "vitest"; it("fails the required suite", () => { expect(false).toBe(true); });');
  try {
    const generatedEnv = join(root, 'coverage/next-spike/build/standalone/.env');
    const generatedBuild = join(root, 'coverage/next-spike/build');
    await mkdir(join(root, 'coverage/next-spike/build/standalone'), { recursive: true });
    await writeFile(generatedEnv, 'SYNTHETIC_COVERAGE_OUTPUT_PLACEHOLDER=remove-me');
    await expect(collectCoverage(root)).rejects.toThrow('Coverage test process failed (1)');
    await expect(access(generatedEnv)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(generatedBuild)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
