import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WORKLOAD = Object.freeze({
  cpuMilliCores: 500,
  memoryBytes: 512 * 1024 * 1024,
  diskBytes: 4 * 1024 * 1024 * 1024,
  catalogDiskBytes: 200 * 1024 * 1024,
  cacheBytes: 96 * 1024 * 1024,
  catalogs: 3,
  pagesPerCatalog: 500,
  assetsPerCatalog: 100,
  averagePageBytes: 50 * 1024,
  assetBytesPerCatalog: 10 * 1024 * 1024,
  readers: 10,
  requestsPerSecond: 20,
  durationSeconds: 15 * 60,
  expectedRequests: 18_000,
});

const latencyLimits = Object.freeze({ pageP95Ms: 2000, searchP95Ms: 1000, coldPageMs: 5000,
  durableAckMs: 2000, publishMs: 120_000, recoveryMs: 45_000 });
const nonnegative = (value, key) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid workload metric: ${key}`);
  return value;
};

export function checkWorkloadEvidence(input) {
  if (!input || input.schemaVersion !== 1 || !input.imageDigest || !/^sha256:[a-f0-9]{64}$/.test(input.imageDigest)) {
    throw new Error('Missing workload identity evidence');
  }
  for (const [key, expected] of Object.entries(WORKLOAD)) {
    if (input.scenario?.[key] !== expected) throw new Error(`Workload scenario mismatch: ${key}`);
  }
  const metrics = input.metrics;
  if (!metrics || !input.outcomes) throw new Error('Missing workload measurements');
  for (const [key, limit] of Object.entries(latencyLimits)) {
    if (nonnegative(metrics[key], key) > limit) throw new Error(`Workload latency exceeded: ${key}`);
  }
  if (nonnegative(metrics.processRssPeakBytes, 'processRssPeakBytes') > WORKLOAD.memoryBytes ||
      nonnegative(metrics.containerMemoryPeakBytes, 'containerMemoryPeakBytes') > WORKLOAD.memoryBytes) throw new Error('Workload memory budget exceeded');
  if (nonnegative(metrics.cpuPeakMilliCores, 'cpuPeakMilliCores') > WORKLOAD.cpuMilliCores) throw new Error('Workload CPU budget exceeded');
  if (nonnegative(metrics.diskPeakBytes, 'diskPeakBytes') > WORKLOAD.diskBytes ||
      nonnegative(metrics.catalogDiskPeakBytes, 'catalogDiskPeakBytes') > WORKLOAD.catalogDiskBytes ||
      nonnegative(metrics.cachePeakBytes, 'cachePeakBytes') > WORKLOAD.cacheBytes) throw new Error('Workload storage budget exceeded');
  if (nonnegative(metrics.maxRetries, 'maxRetries') > 5) throw new Error('Workload retry bound exceeded');
  if (nonnegative(metrics.completedRequests, 'completedRequests') < WORKLOAD.expectedRequests) throw new Error('Workload request count is incomplete');
  if (['failedRequests', 'correctnessFailures', 'privacyViolations', 'oomEvents'].some(key => nonnegative(input.outcomes[key], key) !== 0) ||
      input.outcomes.syncPublished !== true || input.outcomes.restartRecovered !== true || input.outcomes.privateSentinelAbsent !== true) {
    throw new Error('Workload correctness, privacy, sync, restart, or OOM check failed');
  }
  return { status: 'passed', scenario: input.scenario, metrics, outcomes: input.outcomes };
}

export async function measureWorkload(evidencePath = resolve('coverage/workload-evidence.json')) {
  const input = JSON.parse(await readFile(evidencePath, 'utf8'));
  return checkWorkloadEvidence(input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await measureWorkload(process.argv[2] ? resolve(process.argv[2]) : undefined), null, 2)); }
  catch { console.error('Workload validation failed: exact corpus/load evidence is missing or exceeded a plan limit.'); process.exitCode = 1; }
}
