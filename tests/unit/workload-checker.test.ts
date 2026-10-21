import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkWorkloadEvidence, measureWorkload, WORKLOAD } from '../../scripts/measure-workload.mjs';

type Evidence = { schemaVersion: number; imageDigest: string; scenario: Record<string, number>;
  metrics: Record<string, number>; outcomes: Record<string, number | boolean> };

function evidence(): Evidence {
  return { schemaVersion: 1, imageDigest: `sha256:${'a'.repeat(64)}`, scenario: { ...WORKLOAD },
    metrics: { pageP95Ms: 1500, searchP95Ms: 800, coldPageMs: 4000, durableAckMs: 1000, publishMs: 90_000, recoveryMs: 30_000,
      processRssPeakBytes: 300_000_000, containerMemoryPeakBytes: 400_000_000, cpuPeakMilliCores: 400,
      diskPeakBytes: 3_000_000_000, catalogDiskPeakBytes: 150_000_000, cachePeakBytes: 80_000_000,
      maxRetries: 2, completedRequests: 18_000 },
    outcomes: { failedRequests: 0, correctnessFailures: 0, privacyViolations: 0, oomEvents: 0,
      syncPublished: true, restartRecovered: true, privateSentinelAbsent: true } };
}

it('validates synthetic CLI input and exits unsuccessfully for a missing measurement file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-workload-cli-'));
  try {
    const file = join(root, 'synthetic.json'); await writeFile(file, JSON.stringify(evidence()));
    const capture = process.env.LIBRARIAN_COVERAGE_PROCESS_DIR ? [`--import=${pathToFileURL(resolve('tests/integration/native-coverage-register.mjs')).href}`] : [];
    const run = (file: string) => spawnSync(process.execPath, [...capture, resolve('scripts/measure-workload.mjs'), file], { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const valid = run(file); expect(valid.status, valid.stderr).toBe(0); expect(JSON.parse(valid.stdout).status).toBe('passed');
    const missing = run(join(root, 'absent.json')); expect(missing.status).toBe(1); expect(missing.stderr).toContain('Workload validation failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('accepts the exact corpus/load and measurements within every plan bound', () => {
  expect(WORKLOAD.expectedRequests).toBe(18_000);
  expect(checkWorkloadEvidence(evidence())).toMatchObject({ status: 'passed', scenario: { catalogs: 3, readers: 10, requestsPerSecond: 20, durationSeconds: 900 } });
});

it('rejects missing identity, altered load, and every exceeded performance/resource bound', () => {
  expect(() => checkWorkloadEvidence({})).toThrow('identity');
  const wrongLoad = evidence(); wrongLoad.scenario.pagesPerCatalog++;
  expect(() => checkWorkloadEvidence(wrongLoad)).toThrow('scenario mismatch');
  for (const [key, value] of Object.entries({ pageP95Ms: 2001, searchP95Ms: 1001, coldPageMs: 5001, durableAckMs: 2001, publishMs: 120_001, recoveryMs: 45_001 })) {
    const input = evidence(); input.metrics[key] = value;
    expect(() => checkWorkloadEvidence(input)).toThrow('latency exceeded');
  }
  for (const [key, value] of Object.entries({ processRssPeakBytes: WORKLOAD.memoryBytes + 1, containerMemoryPeakBytes: WORKLOAD.memoryBytes + 1 })) {
    const input = evidence(); input.metrics[key] = value;
    expect(() => checkWorkloadEvidence(input)).toThrow('memory budget');
  }
  const cpu = evidence(); cpu.metrics.cpuPeakMilliCores = 501;
  expect(() => checkWorkloadEvidence(cpu)).toThrow('CPU budget');
  for (const [key, value] of Object.entries({ diskPeakBytes: WORKLOAD.diskBytes + 1, catalogDiskPeakBytes: WORKLOAD.catalogDiskBytes + 1, cachePeakBytes: WORKLOAD.cacheBytes + 1 })) {
    const input = evidence(); input.metrics[key] = value;
    expect(() => checkWorkloadEvidence(input)).toThrow('storage budget');
  }
  const retries = evidence(); retries.metrics.maxRetries = 6;
  expect(() => checkWorkloadEvidence(retries)).toThrow('retry bound');
  const requests = evidence(); requests.metrics.completedRequests = 17_999;
  expect(() => checkWorkloadEvidence(requests)).toThrow('request count');
});

it('rejects malformed or unsafe outcomes and nonfinite values', () => {
  for (const key of ['failedRequests', 'correctnessFailures', 'privacyViolations', 'oomEvents']) {
    const input = evidence(); input.outcomes[key] = 1;
    expect(() => checkWorkloadEvidence(input)).toThrow('correctness, privacy, sync, restart, or OOM');
  }
  for (const key of ['syncPublished', 'restartRecovered', 'privateSentinelAbsent']) {
    const input = evidence(); input.outcomes[key] = false;
    expect(() => checkWorkloadEvidence(input)).toThrow('correctness, privacy, sync, restart, or OOM');
  }
  const invalid = evidence(); invalid.metrics.pageP95Ms = Number.NaN;
  expect(() => checkWorkloadEvidence(invalid)).toThrow('Invalid workload metric');
  expect(() => checkWorkloadEvidence({ ...evidence(), imageDigest: 'latest' })).toThrow('identity');
});

it('rejects absent measurement groups and invalid negative or nonnumeric metrics', () => {
  expect(() => checkWorkloadEvidence({ ...evidence(), metrics: undefined } as unknown as Evidence)).toThrow('Missing workload measurements');
  expect(() => checkWorkloadEvidence({ ...evidence(), outcomes: undefined } as unknown as Evidence)).toThrow('Missing workload measurements');
  const negative = evidence(); negative.metrics.pageP95Ms = -1;
  expect(() => checkWorkloadEvidence(negative)).toThrow('Invalid workload metric');
  const nonnumeric = evidence(); (nonnumeric.metrics as Record<string, unknown>).pageP95Ms = '1500';
  expect(() => checkWorkloadEvidence(nonnumeric)).toThrow('Invalid workload metric');
});

it('reads a saved local measurement and reports missing evidence as a failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-workload-'));
  try {
    await expect(measureWorkload()).rejects.toThrow();
    const path = join(root, 'evidence.json');
    await writeFile(path, JSON.stringify(evidence()));
    expect((await measureWorkload(path)).status).toBe('passed');
    await expect(measureWorkload(join(root, 'missing.json'))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
