import { expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { CoverageMapData } from '@vitest/istanbul-lib-coverage';
import { instrumentSource } from '../../scripts/coverage-loader.mjs';
import { capabilityScopes, sourceInventory } from '../../scripts/check-coverage.mjs';
import { assertNoLeaks, scanArtifactTree, validateArtifacts, validateFeatureDocuments, validateInstanceTraceability, validateTraceability } from '../../scripts/validate-artifacts.mjs';

const ids = [['FR', 38, 3], ['QG', 7, 3], ['ST', 14, 2], ['SC', 14, 3]] as const;
function docs() {
  const requirementRows = ids.flatMap(([prefix, count, width]) => Array.from({ length: count }, (_, index) =>
    `| ${prefix}-${String(index + 1).padStart(width, '0')} | T001 |`));
  const stageRows = Array.from({ length: 6 }, (_, index) => `| ${index + 1} | Stage ${index + 1} | Gate |`);
  const scopeRows = Array.from({ length: 6 }, (_, index) => `| C${index + 1} | Scope ${index + 1} | Gate |`);
  const plan = ['| Stage | Work | Gate |', ...stageRows, '| Scope | Files | Gate |', ...scopeRows].join('\n');
  const tasks = Array.from({ length: 92 }, (_, index) => `- [${index % 2 ? 'x' : 'X'}] T${String(index + 1).padStart(3, '0')} synthetic`).join('\n');
  return { spec: ids.flatMap(([prefix, count, width]) => Array.from({ length: count }, (_, index) =>
    `${prefix}-${String(index + 1).padStart(width, '0')}`)).join(' '), plan, tasks: `${tasks}\n\n${requirementRows.join('\n')}` };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'librarian-artifacts-'));
  for (const dir of ['app', 'lib/auth', 'lib/content', 'lib/sync', 'lib/operations', 'scripts', 'public', 'coverage', 'specs/001-librarian-v1-portal/contracts', 'docs/requirements', '.specify/memory', 'tests/fixtures']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  const source = 'export function check(value: boolean) { if (value) return 1; return 0; }';
  const files = ['app/page.tsx', 'lib/auth/authorization.ts', 'lib/content/search.ts', 'lib/sync/worker.ts', 'app/api/admin/repos.ts', 'lib/operations/health.ts'];
  for (const file of files) { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), source); }
  const allSources = await sourceInventory(root);
  const scopes = capabilityScopes(root, allSources);
  const hashes: Record<string, string> = {};
  const coverage: CoverageMapData = {};
  for (const path of allSources) {
    const code = await readFile(path, 'utf8');
    hashes[path] = createHash('sha256').update(code).digest('hex');
    const data = instrumentSource(code, path).coverage;
    for (const key of Object.keys(data.s)) data.s[key] = 1;
    for (const key of Object.keys(data.f)) data.f[key] = 1;
    for (const [key, branch] of Object.entries(data.branchMap)) data.b[key] = branch.locations.map(() => 1);
    coverage[path] = data;
  }
  const documents = docs();
  const documentFiles = {
    'specs/001-librarian-v1-portal/spec.md': documents.spec,
    'specs/001-librarian-v1-portal/plan.md': documents.plan,
    'specs/001-librarian-v1-portal/tasks.md': documents.tasks,
    'specs/001-librarian-v1-portal/data-model.md': '[local file](./terms.md#safe) [local directory](./navigation/) [external](https://example.invalid) [mail](mailto:docs@example.invalid) [root-relative](#section) [empty]() [query-only](?version=1) [network](//example.invalid)\n',
    'specs/001-librarian-v1-portal/contracts/http.md': '',
    'specs/001-librarian-v1-portal/quickstart.md': '',
    'docs/requirements/v1-requirements.md': '', '.specify/memory/constitution.md': '',
  };
  for (const [file, text] of Object.entries(documentFiles)) await writeFile(join(root, file), text);
  await writeFile(join(root, 'specs/001-librarian-v1-portal/terms.md'), 'Synthetic linked target.');
  await mkdir(join(root, 'specs/001-librarian-v1-portal/navigation'));
  await writeFile(join(root, '.env.example'), 'AUTH_SECRET_FILE=.local/secrets/auth-secret\n');
  await writeFile(join(root, 'tests/fixtures/catalogs.ts'), "export const privateBody = 'SYNTHETIC_PRIVATE_BODY';\nexport const token = 'SYNTHETIC_TOKEN_NEVER_PUBLIC';");
  const capture = join(root, 'coverage/raw.json');
  await writeFile(capture, JSON.stringify({ result: [{ url: 'file:///synthetic.js', functions: [] }] }));
  const evidence = { inventory: allSources, scopes, reports: [
    { kind: 'node', hashes, coverage }, { kind: 'server', hashes, coverage },
  ], tests: { passed: 1, failed: 0, skipped: 0 }, server: { exited: true, captures: ['coverage/raw.json'], mapsVerified: true },
    browser: { exited: true, captured: true, originalSourceFiles: 0 } };
  await writeFile(join(root, 'coverage/evidence.json'), JSON.stringify(evidence));
  await writeFile(join(root, 'public/index.html'), '<p>safe public shell</p>');
  return root;
}

it('checks the full FR/QG/ST/SC trace and exact task inventory', () => {
  const input = docs();
  expect(validateTraceability(input.spec, input.plan, input.tasks)).toEqual({ requirements: 73, tasks: 92 });
  expect(() => validateTraceability(input.spec.replace('FR-038', ''), input.plan, input.tasks)).toThrow('Specification requirement inventory');
  expect(() => validateTraceability(input.spec, input.plan.replace('| C6 |', '| X6 |'), input.tasks)).toThrow('coverage scopes');
  expect(() => validateTraceability(input.spec, input.plan, input.tasks.replace('| SC-014 |', '| SC-999 |'))).toThrow('traceability');
  expect(() => validateTraceability(input.spec, input.plan, input.tasks.replace('T092', 'T091'))).toThrow('Task inventory');
  expect(() => validateTraceability('', input.plan, input.tasks)).toThrow('Specification requirement inventory');
});

it('rejects secret/private sentinels without echoing their values', () => {
  expect(() => assertNoLeaks('safe text', ['SYNTHETIC_PRIVATE_BODY'])).not.toThrow();
  for (const text of ['SYNTHETIC_PRIVATE_BODY', '-----BEGIN RSA PRIVATE KEY-----', 'mongodb://user:password@db.test',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'eyJabcdefghijklmnop.abcdefghijklmnop.abcdefghijklmnop']) {
    expect(() => assertNoLeaks(text, ['SYNTHETIC_PRIVATE_BODY'])).toThrow('Sensitive content');
  }
});

it('checks artifact trees, binary files and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-scan-'));
  try {
    const output = join(root, 'public');
    await mkdir(output);
    await writeFile(join(output, 'ok.js'), 'const publicOnly = true;');
    await writeFile(join(output, 'asset.bin'), Buffer.from([0, 1, 2]));
    await mkdir(join(output, 'nested'));
    await writeFile(join(output, 'nested', 'asset.txt'), 'safe nested artifact');
    expect(await scanArtifactTree(root, output, ['SYNTHETIC_PRIVATE_BODY'])).toBe(2);
    await writeFile(join(output, 'leak.json'), '{"body":"SYNTHETIC_PRIVATE_BODY"}');
    await expect(scanArtifactTree(root, output, ['SYNTHETIC_PRIVATE_BODY'])).rejects.toThrow('Sensitive content');
    await rm(join(output, 'leak.json'));
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(output, 'escape'), 'junction');
    await expect(scanArtifactTree(root, output, [])).rejects.toThrow('symlink');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects missing privacy evidence and an empty capability inventory', async () => {
  const root = await fixture();
  try {
    const catalogs = join(root, 'tests/fixtures/catalogs.ts');
    await writeFile(catalogs, 'export const onlyPublic = true;');
    await expect(validateArtifacts(root)).rejects.toThrow('Privacy sentinel evidence is missing');

    await writeFile(catalogs, "export const privateBody = 'SYNTHETIC_PRIVATE_BODY';");
    await rm(join(root, 'app/page.tsx'));
    await expect(validateArtifacts(root)).rejects.toThrow('Capability source inventory is incomplete');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('validates documents, source scopes, coverage evidence, and built public artifacts together', async () => {
  const root = await fixture();
  try {
    const result = await validateArtifacts(root);
    expect(result).toMatchObject({ requirements: 73, tasks: 92, scopes: 7, scannedFiles: 3 });
    await writeFile(join(root, 'specs/001-librarian-v1-portal/data-model.md'), '[escape](../../../../outside)');
    await expect(validateArtifacts(root)).rejects.toThrow('escaped');
    await writeFile(join(root, 'specs/001-librarian-v1-portal/data-model.md'), '[missing](./missing.md)');
    await expect(validateArtifacts(root)).rejects.toThrow('missing');
    await writeFile(join(root, 'specs/001-librarian-v1-portal/data-model.md'), '[local file](./terms.md#safe) [local directory](./navigation/) [external](https://example.invalid)');
    await writeFile(join(root, 'public/health.json'), '{"status":"ok","title":"SYNTHETIC_TOKEN_NEVER_PUBLIC"}');
    await expect(validateArtifacts(root)).rejects.toThrow('Sensitive content');
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function instanceDocs() {
  const base = 'specs/002-instance-configuration';
  const [spec, plan, tasks, contract] = await Promise.all(['spec.md', 'plan.md', 'tasks.md', 'contracts/instance-api.md'].map(file => readFile(join(base, file), 'utf8')));
  return { spec, plan, tasks, contract };
}

it('derives the selected instance requirement/task/source/API inventory and rejects broken mappings', async () => {
  const { spec, plan, tasks, contract } = await instanceDocs();
  expect(validateInstanceTraceability(spec, plan, tasks, contract)).toMatchObject({ requirements: 58, tasks: 105, sources: 69, apiRows: 16 });
  for (const [changed, expected] of [
    [tasks.replace('T094 Prepare', 'T093 Prepare'), 'Task inventory'],
    [tasks.replace('| V2-FR-036 |', '| V2-FR-999 |'), 'traceability'],
    [tasks.replace(/^- \[[ xX]\] T003 /m, '- [?] T003 '), 'Task inventory'],
    [tasks.replace('T001-T006', 'T001-T999'), 'dependency'],
  ]) expect(() => validateInstanceTraceability(spec, plan, changed, contract)).toThrow(expected);
  expect(() => validateInstanceTraceability(spec.replace('**V2-FR-036**', '**V2-FR-035**'), plan, tasks, contract)).toThrow('requirement inventory');
  expect(() => validateInstanceTraceability(spec, plan.replace('lib/instance/store.ts\n', 'lib/instance/missing.ts\n'), tasks, contract)).toThrow('source inventory');
  expect(() => validateInstanceTraceability(spec, plan, tasks, contract.replace('/api/instance/status', '/api/instance/unplanned'))).toThrow('contract');
  for (const changed of [spec.replace(/\*\*V2-FR-\d{3}\*\*/g, '**omitted**'), spec.replace('**V2-FR-001**', '**V2-FR-999**')]) {
    expect(() => validateInstanceTraceability(changed, plan, tasks, contract)).toThrow('requirement inventory');
  }
  for (const changed of [tasks.replace(/^## Phase .*$/gm, ''), tasks.replace('## Phase 2:', '## Phase 1:'), tasks.replaceAll('User Story 5', 'User Story 6')]) {
    expect(() => validateInstanceTraceability(spec, plan, changed, contract)).toThrow('phase/story');
  }
  expect(() => validateInstanceTraceability(spec, plan, tasks, '')).toThrow('contract inventory');
  const firstRow = contract.match(/^\|\s*(?:GET|POST|PATCH|GET\/POST)\s+`[^`]+`[^\n]*/m)![0];
  expect(() => validateInstanceTraceability(spec, plan, tasks, `${contract}\n${firstRow}`)).toThrow('Duplicate');
  expect(() => validateInstanceTraceability(spec, plan, tasks, contract.split('\n').filter(line => !line.includes('/api/instance/settings/check')).join('\n'))).toThrow('handler is missing');
});

it('runs the actual documents CLI successfully and reports missing documents with a failing exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-artifact-cli-'));
  try {
    const capture = process.env.LIBRARIAN_COVERAGE_PROCESS_DIR ? [`--import=${pathToFileURL(resolve('tests/integration/native-coverage-register.mjs')).href}`] : [];
    const script = resolve('scripts/validate-artifacts.mjs');
    const invoke = (cwd: string) => spawnSync(process.execPath, [...(cwd === process.cwd() ? capture : []), script, '--documents-only'], { cwd,
      env: process.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const valid = invoke(process.cwd()); expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toEqual(await validateFeatureDocuments(process.cwd()));
    const missing = invoke(root); expect(missing.status).toBe(1); expect(missing.stderr).toContain('Artifact validation failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects an escaped artifact directory and malformed selected-feature metadata', async () => {
  const root = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'librarian-artifact-outside-'));
  try {
    await writeFile(join(outside, 'synthetic.txt'), 'safe synthetic artifact');
    await expect(scanArtifactTree(root, outside, [])).rejects.toThrow('escaped');
    await writeFile(join(root, '.specify/feature.json'), '{');
    await expect(validateFeatureDocuments(root)).rejects.toThrow('Invalid selected feature');
  } finally { await rm(outside, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

it('validates selected 002 documents without calling them implemented and retains independent 001 validation', async () => {
  const root = await fixture();
  try {
    await cp('specs/002-instance-configuration', join(root, 'specs/002-instance-configuration'), { recursive: true });
    await cp('docs', join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'AGENTS.md'), 'Synthetic governance link target.');
    await writeFile(join(root, '.specify/feature.json'), JSON.stringify({ feature_directory: 'specs/002-instance-configuration' }));
    const result = await validateFeatureDocuments(root);
    expect(result).toMatchObject({ feature: 'specs/002-instance-configuration', requirements: 58, tasks: 105, sources: 69, apiRows: 16, implementationVerified: false, original: { requirements: 73, tasks: 92 } });
    await expect(validateArtifacts(root)).rejects.toThrow('implementation source');
    const spec = join(root, 'specs/001-librarian-v1-portal/spec.md');
    const original = await readFile(spec, 'utf8');
    await writeFile(spec, '');
    await expect(validateFeatureDocuments(root)).rejects.toThrow('Specification requirement inventory');
    await writeFile(spec, original);
    const model = join(root, 'specs/002-instance-configuration/data-model.md');
    await writeFile(model, '[missing](./missing.md)');
    await expect(validateFeatureDocuments(root)).rejects.toThrow('missing');
    await writeFile(join(root, '.specify/feature.json'), JSON.stringify({ feature_directory: '../outside' }));
    await expect(validateFeatureDocuments(root)).rejects.toThrow('selected feature');
  } finally { await rm(root, { recursive: true, force: true }); }
});
