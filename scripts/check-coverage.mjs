import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCoverageMap } from '@vitest/istanbul-lib-coverage';

const metrics = ['statements', 'branches', 'functions', 'lines'];

// Exact union in 002/plan.md; planned files join coverage as soon as they exist.
export const instanceCoverageFiles = `
lib/instance/bootstrap.ts
lib/instance/store.ts
lib/instance/secrets.ts
lib/instance/access.ts
lib/instance/validation.ts
lib/instance/activation.ts
components/instance-setup.tsx
components/instance-settings.tsx
app/instance/setup/page.tsx
app/instance/settings/page.tsx
app/api/instance/status/route.ts
app/api/instance/setup/authorize/route.ts
app/api/instance/setup/route.ts
app/api/instance/setup/check/route.ts
app/api/instance/setup/finalize/route.ts
app/api/instance/auth/[...nextauth]/route.ts
app/api/instance/settings/route.ts
app/api/instance/settings/check/route.ts
app/api/instance/settings/activate/route.ts
app/api/instance/settings/rollback/route.ts
app/api/instance/audit/route.ts
app/api/instance/migration/authorize/route.ts
app/api/instance/migration/route.ts
scripts/instance-operator.mjs
lib/config.ts
lib/mongo.ts
lib/limits.ts
lib/auth/admin.ts
lib/auth/authorization.ts
lib/auth/adapter.ts
lib/auth/roles.ts
lib/auth/tokens.ts
lib/catalog.ts
lib/sync/worker-startup.ts
lib/sync/worker.ts
lib/sync/jobs.ts
lib/sync/github.ts
lib/content/generations.ts
lib/content/blob-cache.ts
lib/content/source.ts
lib/layout.shared.tsx
lib/operations/health.ts
lib/operations/logging.ts
lib/admin.ts
auth.ts
instrumentation.ts
app/layout.tsx
app/page.tsx
app/repositories/page.tsx
app/[repoSlug]/[[...page]]/page.tsx
app/api/auth/[...nextauth]/route.ts
app/api/webhooks/github/route.ts
app/api/health/route.ts
app/api/search/[repoSlug]/route.ts
app/api/assets/[repoSlug]/[...path]/route.ts
app/api/admin/csrf/route.ts
app/api/admin/repos/route.ts
app/api/admin/repos/[id]/route.ts
app/api/admin/repos/[id]/sync/route.ts
app/api/admin/repos/sync/route.ts
components/site-navigation.tsx
components/directory.tsx
components/admin-console.tsx
scripts/check-coverage.mjs
scripts/collect-coverage.mjs
scripts/validate-artifacts.mjs
`.trim().split('\n');

export function mergeReports(reports) {
  const merged = createCoverageMap({});
  const maps = new Map();
  for (const report of reports) {
    for (const [path, data] of Object.entries(report)) {
      if (data.path !== path) throw new Error('Coverage path/map mismatch');
      for (const [map, counters] of [[data.statementMap, data.s], [data.fnMap, data.f], [data.branchMap, data.b]]) {
        const keys = Object.keys(map);
        if (keys.length !== Object.keys(counters).length || keys.some(key => !Object.hasOwn(counters, key))) {
          throw new Error('Coverage counter/map mismatch');
        }
      }
      for (const [key, branch] of Object.entries(data.branchMap)) {
        if (!Array.isArray(data.b[key]) || data.b[key].length !== branch.locations.length) throw new Error('Coverage branch counter mismatch');
      }
      const signature = JSON.stringify([data.statementMap, data.fnMap, data.branchMap]);
      if (maps.has(path) && maps.get(path) !== signature) throw new Error('Incompatible coverage map');
      maps.set(path, signature);
      for (const count of [...Object.values(data.s), ...Object.values(data.f), ...Object.values(data.b).flat()]) {
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid coverage hit count');
      }
    }
    merged.merge(report);
  }
  return merged;
}

export function checkEvidence(input) {
  if (!input || !Array.isArray(input.reports) || !input.reports.length) throw new Error('Missing coverage reports');
  if (!input.tests || !Number.isSafeInteger(input.tests.passed) || input.tests.passed < 1 || input.tests.failed !== 0 || input.tests.skipped !== 0) throw new Error('Required test evidence failed or empty');
  if (!input.server?.exited || !input.server.captures?.length || input.server.mapsVerified !== true) throw new Error('Missing server process captures/maps');
  if (!input.browser?.exited || input.browser.captured !== true || !Number.isSafeInteger(input.browser.originalSourceFiles) || input.browser.originalSourceFiles < 0) throw new Error('Missing browser capture');
  if (input.browser.originalSourceFiles > 0 && !input.reports.some(report => report.kind === 'browser')) throw new Error('Missing browser report');
  if (!input.reports.some(report => report.kind === 'node') || !input.reports.some(report => report.kind === 'server')) throw new Error('Missing Node/server report');
  if (!Array.isArray(input.inventory) || !input.inventory.length || new Set(input.inventory).size !== input.inventory.length) throw new Error('Missing or duplicate source inventory');
  const inventory = new Set(input.inventory);
  const hashes = new Map();
  for (const report of input.reports) {
    if (!report.coverage || !Object.keys(report.coverage).length) throw new Error('Empty coverage report');
    for (const path of Object.keys(report.coverage)) {
      if (!inventory.has(path)) throw new Error('Coverage contains generated/unknown source');
      const hash = report.hashes?.[path];
      if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error('Missing source hash');
      if (hashes.has(path) && hashes.get(path) !== hash) throw new Error('Incompatible source hash');
      hashes.set(path, hash);
    }
  }
  const merged = mergeReports(input.reports.map(report => report.coverage));
  if (merged.files().length !== inventory.size || input.inventory.some(path => !merged.files().includes(path))) throw new Error('Unexecuted/missing inventory source');
  const scopes = input.scopes;
  if (!scopes || !Object.keys(scopes).length) throw new Error('Missing capability scopes');
  const assigned = new Set();
  for (const [scope, files] of Object.entries(scopes)) {
    if (!/^C[1-7]$/.test(scope) || !Array.isArray(files) || !files.length || new Set(files).size !== files.length || files.some(path => !inventory.has(path))) throw new Error('Invalid capability scope membership');
    files.forEach(path => assigned.add(path));
  }
  if (input.inventory.some(path => !assigned.has(path))) throw new Error('Source missing capability membership');
  function totals(files, scope) {
    const selected = createCoverageMap({});
    files.forEach(path => selected.addFileCoverage(merged.fileCoverageFor(path)));
    const summary = selected.getCoverageSummary();
    /** @type {Record<string, {covered: number, total: number, reason?: string}>} */
    const output = {};
    for (const metric of metrics) {
      const { covered, total } = summary[metric];
      if (!total) {
        const reason = input.notApplicable?.[scope]?.[metric];
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('Zero denominator requires explanation');
        output[metric] = { covered, total, reason };
      } else {
        if (covered * 100 < total * 95) throw new Error(`${scope} ${metric} below 95% (${covered}/${total})`);
        output[metric] = { covered, total };
      }
    }
    return output;
  }
  return { global: totals(input.inventory, 'global'), scopes: Object.fromEntries(Object.entries(scopes).map(([scope, files]) => [scope, totals(files, scope)])) };
}

export async function sourceInventory(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory ? `${directory}/` : ''}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Executable source symlink is not allowed');
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:ts|tsx|mjs)$/.test(path) && !/\.d\.ts$/.test(path)) files.push(resolve(root, path));
    }
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const directory of ['app', 'components', 'lib', 'scripts']) {
    if (entries.some(entry => entry.name === directory && entry.isDirectory())) await walk(directory);
  }
  for (const entry of entries) {
    if (entry.isFile() && /^(?:auth\.ts|instrumentation\.ts|mdx-components\.tsx|.*config\.(?:mjs|ts))$/.test(entry.name) && entry.name !== 'postcss.config.mjs') files.push(resolve(root, entry.name));
  }
  // postcss.config.mjs is a purely declarative plugin map; no runtime logic.
  return files.sort();
}

export function capabilityScopes(root, inventory) {
  /** @type {Record<string, string[]>} */
  const scopes = {};
  const rules = {
    C1: /^(?:app\/(?:page\.tsx|layout\.tsx|loading\.tsx|\[(?:repoSlug|\[\.\.\.slug\])\]\/)|components\/(?:directory|site-navigation|runtime-sidebar|project-selector|project-search|sync-status-badge)\.tsx|lib\/(?:catalog\.ts|layout\.shared\.tsx|source\.ts|content\/source\.ts))/,
    C2: /^(?:auth\.ts|app\/page\.tsx|app\/api\/auth\/|lib\/auth\/|components\/(?:private-content-guard|sign-in-button)\.tsx|lib\/catalog\.ts|app\/\[repoSlug\]\/)/,
    C3: /^(?:lib\/content\/|lib\/source\.ts|app\/api\/(?:search|assets)\/|app\/\[(?:repoSlug|\[\.\.\.slug\])\]\/|components\/(?:runtime-sidebar|project-selector|project-search)\.tsx)/,
    C4: /^(?:lib\/sync\/|lib\/content\/(?:validate|paths|generations|blob-cache)\.ts|lib\/(?:mongo|catalog|limits|public-approvals)\.ts|instrumentation\.ts|app\/api\/webhooks\/)/,
    C5: /^(?:app\/loading\.tsx|app\/repositories\/|app\/page\.tsx|app\/api\/admin\/|components\/(?:catalog-form|sync-status|admin-console|directory|site-navigation|sync-status-badge)\.tsx|lib\/(?:admin|catalog|public-approvals)\.ts|lib\/content\/generations\.ts|lib\/auth\/|lib\/sync\/jobs\.ts)/,
    C6: /^(?:lib\/operations\/|lib\/config\.ts|lib\/sync\/worker-startup\.ts|app\/api\/health\/|instrumentation\.ts|mdx-components\.tsx|scripts\/|[^/]*config\.(?:mjs|ts))/,
  };
  for (const file of inventory) {
    const path = relative(root, file).split(sep).join('/');
    let found = instanceCoverageFiles.includes(path);
    if (found) (scopes.C7 ??= []).push(file);
    for (const [scope, regex] of Object.entries(rules)) {
      if (regex.test(path)) { (scopes[scope] ??= []).push(file); found = true; }
    }
    if (!found) throw new Error(`Unassigned first-party executable source: ${path}`);
  }
  return scopes;
}

export async function runCoverageCheck(root) {
  const input = JSON.parse(await readFile(resolve(root, 'coverage/evidence.json'), 'utf8'));
  const inventory = await sourceInventory(root);
  input.inventory = inventory;
  input.scopes = capabilityScopes(root, inventory);
  for (const report of input.reports ?? []) {
    for (const path of Object.keys(report.coverage ?? {})) {
      const fromRoot = relative(root, path);
      if (isAbsolute(fromRoot) || fromRoot.startsWith(`..${sep}`) || fromRoot === '..') throw new Error('Coverage source outside application');
      const actualHash = createHash('sha256').update(await readFile(path)).digest('hex');
      if (report.hashes?.[path] !== actualHash) throw new Error('Source changed after coverage capture');
    }
  }
  for (const capture of input.server?.captures ?? []) {
    const path = resolve(root, capture);
    const fromCoverage = relative(resolve(root, 'coverage'), path);
    if (isAbsolute(fromCoverage) || fromCoverage.startsWith(`..${sep}`) || fromCoverage === '..') throw new Error('Capture outside coverage directory');
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(raw.result) || !raw.result.length) throw new Error('Missing actual server capture');
  }
  return checkEvidence(input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runCoverageCheck(process.cwd()), null, 2)); }
  catch (error) { console.error(`Coverage gate failed: ${error.message}`); process.exitCode = 1; }
}
