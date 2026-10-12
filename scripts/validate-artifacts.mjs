import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceInventory, capabilityScopes, runCoverageCheck } from './check-coverage.mjs';

const ids = [
  ['FR', 38, 3], ['QG', 7, 3], ['ST', 14, 2], ['SC', 14, 3],
];
const codePattern = /\b(?:FR-\d{3}|QG-\d{3}|ST-\d{2}|SC-\d{3})\b/g;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bmongodb(?:\+srv)?:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
];

const hasLocalPath = (root, file) => {
  const path = relative(root, file);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

function requirements(source) {
  const found = new Set(source.match(codePattern) ?? []);
  const expected = ids.flatMap(([prefix, count, width]) => Array.from({ length: count }, (_, index) =>
    `${prefix}-${String(index + 1).padStart(width, '0')}`));
  if (expected.some(id => !found.has(id))) throw new Error('Specification requirement inventory is incomplete');
  return expected;
}

export function validateTraceability(spec, plan, tasks) {
  const tracked = requirements(spec);
  const taskRows = new Set(tasks.split(/\r?\n/).filter(line => /^\|\s*(?:FR|QG|ST|SC)-\d+\s*\|/.test(line))
    .map(line => line.match(/\|\s*((?:FR|QG|ST|SC)-\d+)\s*\|/)?.[1]));
  if (tracked.some(id => !taskRows.has(id))) throw new Error('Requirement-to-task traceability is incomplete');
  const stages = new Set(plan.split(/\r?\n/).filter(line => /^\|\s*[1-6]\s*\|/.test(line)).map(line => line.match(/^\|\s*([1-6])\s*\|/)?.[1]));
  const scopes = new Set(plan.split(/\r?\n/).filter(line => /^\|\s*C[1-6]\b/.test(line)).map(line => line.match(/^\|\s*(C[1-6])\b/)?.[1]));
  if ([1, 2, 3, 4, 5, 6].some(stage => !stages.has(String(stage))) ||
      ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].some(scope => !scopes.has(scope))) {
    throw new Error('Implementation stages or coverage scopes are incomplete');
  }
  const taskIds = [...tasks.matchAll(/^- \[[ xX]\] (T\d{3})\b/gm)].map(match => match[1]);
  const expectedTasks = Array.from({ length: 92 }, (_, index) => `T${String(index + 1).padStart(3, '0')}`);
  if (new Set(taskIds).size !== 92 || expectedTasks.some(id => !taskIds.includes(id))) throw new Error('Task inventory is incomplete or duplicated');
  return { requirements: tracked.length, tasks: taskIds.length };
}

export function assertNoLeaks(text, sentinels) {
  if (sentinels.some(value => value && text.includes(value)) || secretPatterns.some(pattern => pattern.test(text))) {
    throw new Error('Sensitive content detected in an inspected artifact');
  }
}

async function walk(root, directory, sentinels) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Artifact symlinks are not allowed');
    if (entry.isDirectory()) count += await walk(root, path, sentinels);
    else if (entry.isFile()) {
      if (!hasLocalPath(root, path)) throw new Error('Artifact path escaped the repository');
      const bytes = await readFile(path);
      if (bytes.includes(0)) continue;
      assertNoLeaks(bytes.toString('utf8'), sentinels);
      count++;
    }
  }
  return count;
}

export async function scanArtifactTree(root, directory, sentinels) {
  return walk(resolve(root), resolve(directory), sentinels);
}

async function localLinks(root, file, source) {
  const links = [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1].trim().replace(/^<|>$/g, ''));
  for (const link of links) {
    if (!link || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link)) continue;
    const target = decodeURIComponent(link.split(/[?#]/, 1)[0]);
    if (!target) continue;
    const path = resolve(dirname(file), target);
    if (!hasLocalPath(root, path)) throw new Error('Documentation link escaped the repository');
    try { await readdir(path); }
    catch (error) {
      if (error?.code === 'ENOTDIR') continue;
      try { await readFile(path); }
      catch { throw new Error('Documentation link target is missing'); }
    }
  }
}

export async function validateArtifacts(root) {
  const specPath = resolve(root, 'specs/001-librarian-v1-portal/spec.md');
  const planPath = resolve(root, 'specs/001-librarian-v1-portal/plan.md');
  const tasksPath = resolve(root, 'specs/001-librarian-v1-portal/tasks.md');
  const docPaths = [specPath, planPath, tasksPath, resolve(root, 'specs/001-librarian-v1-portal/data-model.md'),
    resolve(root, 'specs/001-librarian-v1-portal/contracts/http.md'), resolve(root, 'specs/001-librarian-v1-portal/quickstart.md'),
    resolve(root, 'docs/requirements/v1-requirements.md'), resolve(root, '.specify/memory/constitution.md')];
  const docs = await Promise.all(docPaths.map(path => readFile(path, 'utf8')));
  const traceability = validateTraceability(docs[0], docs[1], docs[2]);
  for (let index = 0; index < docPaths.length; index++) await localLinks(root, docPaths[index], docs[index]);

  const inventory = await sourceInventory(root);
  const scopes = capabilityScopes(root, inventory);
  if (['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].some(scope => !scopes[scope]?.length)) throw new Error('Capability source inventory is incomplete');
  const coverage = await runCoverageCheck(root);

  const fixtureCatalogs = await readFile(resolve(root, 'tests/fixtures/catalogs.ts'), 'utf8');
  const sentinels = [...new Set(fixtureCatalogs.match(/SYNTHETIC_(?:PRIVATE|TOKEN)_[A-Z0-9_]+/g) ?? [])];
  if (!sentinels.length) throw new Error('Privacy sentinel evidence is missing');
  const inspect = ['.env.example', ...docPaths.map(path => relative(root, path).split(sep).join('/'))];
  for (const path of inspect) assertNoLeaks(await readFile(resolve(root, path), 'utf8'), sentinels);

  let scannedFiles = 0;
  for (const directory of ['public', '.next/static', '.next/server/app', 'out', 'coverage', 'test-results', 'playwright-report']) {
    const path = resolve(root, directory);
    try { scannedFiles += await scanArtifactTree(root, path, sentinels); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { ...traceability, sources: inventory.length, scopes: Object.keys(scopes).length,
    scannedFiles, coverage: { global: coverage.global, scopes: Object.keys(coverage.scopes).length } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await validateArtifacts(process.cwd()), null, 2)); }
  catch { console.error('Artifact validation failed: missing evidence, invalid traceability, or sensitive content detected.'); process.exitCode = 1; }
}
