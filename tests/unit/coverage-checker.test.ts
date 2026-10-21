import { describe, expect, it } from 'vitest';
import { checkEvidence, mergeReports, sourceInventory, capabilityScopes, runCoverageCheck, instanceCoverageFiles } from '../../scripts/check-coverage.mjs';
import type { CoverageMapData } from '@vitest/istanbul-lib-coverage';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const file = '/synthetic/lib/example.ts';
function report(hit = 1): CoverageMapData {
  return { [file]: {
    path: file,
    statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } },
    fnMap: { '0': { name: 'example', decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 8 } }, loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } }, line: 1 } },
    branchMap: { '0': { type: 'if', line: 1, loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } }, locations: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 10 } }] } },
    s: { '0': hit }, f: { '0': hit }, b: { '0': [hit] },
  } };
}
function evidence() {
  return { inventory: [file], scopes: { C6: [file] } as Record<string, string[]>, reports: [{ kind: 'node', hashes: { [file]: 'a'.repeat(64) } as Record<string, string>, coverage: report() }, { kind: 'server', hashes: { [file]: 'a'.repeat(64) } as Record<string, string>, coverage: report() }], tests: { passed: 1, failed: 0, skipped: 0 }, server: { exited: true, captures: ['capture.json'], mapsVerified: true }, browser: { exited: true, captured: true, originalSourceFiles: 0 } };
}

describe('coverage integrity and exact thresholds', () => {
  it('requires browser capture and a report whenever original client code was captured', () => {
    for (const browser of [undefined, { exited: false, captured: true, originalSourceFiles: 0 }, { exited: true, captured: false, originalSourceFiles: 0 }, { exited: true, captured: true, originalSourceFiles: -1 }]) {
      expect(() => checkEvidence({ ...evidence(), browser })).toThrow('browser');
    }
    const input = evidence(); input.browser.originalSourceFiles = 1;
    expect(() => checkEvidence(input)).toThrow('browser report');
    input.reports.push({ ...input.reports[0], kind: 'browser' });
    expect(checkEvidence(input).global.statements.covered).toBe(1);
  });
  it('merges shared files once and preserves raw counts', () => {
    const merged = mergeReports([report(1), report(2)]);
    expect(merged.files()).toEqual([file]);
    expect(merged.fileCoverageFor(file).data.s['0']).toBe(3);
    expect(merged.getCoverageSummary().statements.total).toBe(1);
    expect(checkEvidence(evidence()).global.statements).toMatchObject({ covered: 1, total: 1 });
  });
  it('keeps shared files in all affected capability scopes', () => {
    const input = evidence(); input.scopes = { C1: [file], C6: [file] };
    expect(Object.keys(checkEvidence(input).scopes)).toEqual(['C1', 'C6']);
  });
  it('rejects absent reports, process captures or source maps', () => {
    for (const patch of [{ reports: [] }, { server: null }, { server: { exited: false, captures: ['x'], mapsVerified: true } }, { server: { exited: true, captures: [], mapsVerified: true } }, { server: { exited: true, captures: ['x'], mapsVerified: false } }]) {
      expect(() => checkEvidence({ ...evidence(), ...patch })).toThrow();
    }
  });
  it('rejects empty, failed and skipped required tests', () => {
    for (const tests of [{ passed: 0, failed: 0, skipped: 0 }, { passed: 1, failed: 1, skipped: 0 }, { passed: 1, failed: 0, skipped: 1 }]) expect(() => checkEvidence({ ...evidence(), tests })).toThrow();
  });
  it('rejects unexecuted or missing source/scope membership', () => {
    const input = evidence(); input.reports[0].coverage = report(0); input.reports[1].coverage = report(0);
    expect(() => checkEvidence(input)).toThrow('95%');
    expect(() => checkEvidence({ ...evidence(), inventory: [file, '/synthetic/lib/untouched.ts'] })).toThrow();
    const unassigned = evidence(); const extra = '/synthetic/lib/unassigned.ts'; unassigned.inventory.push(extra);
    for (const item of unassigned.reports) { const data = { ...structuredClone(item.coverage[file]), path: extra }; item.coverage[extra] = data; item.hashes[extra] = 'c'.repeat(64); }
    expect(() => checkEvidence(unassigned)).toThrow('Source missing capability membership');
    expect(() => checkEvidence({ ...evidence(), scopes: {} })).toThrow();
    expect(() => checkEvidence({ ...evidence(), scopes: { C6: ['/unknown.ts'] } })).toThrow();
  });
  it('rejects changed source hashes and incompatible coverage maps', () => {
    const hashes = evidence(); hashes.reports[1].hashes[file] = 'b'.repeat(64);
    expect(() => checkEvidence(hashes)).toThrow('hash');
    const maps = evidence(); maps.reports[1].coverage[file].statementMap['0'].end.column = 11;
    expect(() => checkEvidence(maps)).toThrow('map');
  });
  it('rejects counters missing from their declared source maps', () => {
    const input = evidence();
    delete input.reports[0].coverage[file].s['0'];
    expect(() => mergeReports([input.reports[0].coverage])).toThrow('counter');
  });
  it('rejects path mismatches, missing function/branch counters and invalid hit counts', () => {
    const wrongPath = report(); wrongPath[file] = { ...wrongPath[file], path: '/other.ts' };
    expect(() => mergeReports([wrongPath])).toThrow('path');
    const missingFunction = report(); delete missingFunction[file].f['0'];
    expect(() => mergeReports([missingFunction])).toThrow('counter');
    const shortBranch = report(); shortBranch[file].b['0'] = [];
    expect(() => mergeReports([shortBranch])).toThrow('counter');
    const extraCounter = report(); extraCounter[file].s['extra'] = 1;
    expect(() => mergeReports([extraCounter])).toThrow('counter');
    for (const value of [-1, 0.5, NaN, Infinity]) {
      const input = report(); input[file].s['0'] = value;
      expect(() => mergeReports([input])).toThrow('count');
    }
  });
  it('rejects missing report kinds, unknown identities and absent source hashes', () => {
    const input = evidence();
    expect(() => checkEvidence({ ...input, reports: [input.reports[0]] })).toThrow('Node/server');
    expect(() => checkEvidence({ ...input, reports: [input.reports[1]] })).toThrow('Node/server');
    expect(() => checkEvidence({ ...input, reports: [{ ...input.reports[0], coverage: {} }, input.reports[1]] })).toThrow('Empty');
    expect(() => checkEvidence({ ...input, inventory: [file, file] })).toThrow('inventory');
    expect(() => checkEvidence({ ...input, inventory: [] })).toThrow('inventory');
    expect(() => checkEvidence({ ...input, inventory: ['/unknown.ts'] })).toThrow('unknown');
    expect(() => checkEvidence({ ...input, reports: [{ ...input.reports[0], hashes: {} }, input.reports[1]] })).toThrow('hash');
    expect(() => checkEvidence({ ...input, scopes: { C8: [file] } })).toThrow('scope');
    expect(() => checkEvidence({ ...input, scopes: { C6: [file, file] } })).toThrow('scope');
    expect(() => checkEvidence({ ...input, scopes: { C6: [] } })).toThrow('scope');
  });
  it('requires explicit explanations for genuinely empty metric denominators', () => {
    const input = evidence();
    for (const item of input.reports) item.coverage[file] = { ...item.coverage[file], fnMap: {}, f: {} };
    expect(() => checkEvidence(input)).toThrow('explanation');
    const checked = checkEvidence({ ...input, notApplicable: { global: { functions: 'No functions in the declarative fixture' }, C6: { functions: 'No functions in the declarative fixture' } } });
    expect(checked.global.functions).toMatchObject({ total: 0, covered: 0 });
  });
  it('fails raw counts below 95 even when display rounding would pass', () => {
    const input = evidence();
    for (const item of input.reports) {
      const data: CoverageMapData[string] = { ...item.coverage[file], statementMap: {}, s: {} };
      item.coverage[file] = data;
      for (let i = 0; i < 10001; i++) {
        data.statementMap[String(i)] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 10 } };
        data.s[String(i)] = i < 9500 ? 1 : 0;
      }
    }
    expect(() => checkEvidence(input)).toThrow('95%');
  });
});

describe('instance C7 coverage', () => {
  it('matches the plan union exactly without replacing existing scopes', async () => {
    const { readFile } = await import('node:fs/promises');
    const plan = await readFile(resolve('specs/002-instance-configuration/plan.md'), 'utf8');
    const groups = [...plan.matchAll(/\*\*(?:New implementation file set|Existing boundary\/caller implementation file set):\*\*\s+```text\s+([\s\S]*?)```/g)];
    const declared = groups.flatMap(group => group[1].trim().split(/\r?\n/));
    expect(instanceCoverageFiles).toEqual(declared);
    expect(instanceCoverageFiles).toContain('app/instance/setup/page.tsx');
    expect(instanceCoverageFiles).toContain('app/instance/settings/page.tsx');
    expect(instanceCoverageFiles).not.toContain('app/repositories/setup/page.tsx');
    expect(instanceCoverageFiles).not.toContain('app/repositories/settings/page.tsx');
    expect(new Set(instanceCoverageFiles).size).toBe(declared.length);
    const inventory = declared.map(path => resolve(path));
    const scopes = capabilityScopes(process.cwd(), inventory);
    expect(scopes.C7).toEqual(inventory);
    expect(scopes.C2).toContain(resolve('lib/auth/authorization.ts'));
    expect(scopes.C4).toContain(resolve('lib/sync/worker.ts'));
    expect(() => capabilityScopes(process.cwd(), [...inventory, resolve('lib/instance/unplanned.ts')])).toThrow('Unassigned');
  });

  it.each(['s', 'f', 'b'] as const)('rejects a low C7 %s metric even with passing global coverage', counter => {
    const input = evidence();
    const padding = '/synthetic/lib/padding.ts';
    input.inventory.push(padding);
    input.scopes = { C6: [padding], C7: [file] };
    for (const item of input.reports) {
      const healthy = { ...structuredClone(item.coverage[file]), path: padding };
      // Twenty covered items keep the global metric above 95% while C7 has zero hits.
      for (let i = 1; i < 20; i++) {
        healthy.statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 10 } };
        healthy.s[i] = 1;
        const loc = healthy.statementMap[i];
        healthy.fnMap[i] = { ...healthy.fnMap[0], decl: loc, loc, line: i + 1 }; healthy.f[i] = 1;
        healthy.branchMap[i] = { ...healthy.branchMap[0], line: i + 1, loc, locations: [loc] }; healthy.b[i] = [1];
      }
      item.coverage[padding] = healthy;
      item.hashes[padding] = 'b'.repeat(64);
      if (counter === 'b') item.coverage[file].b[0] = [0];
      else item.coverage[file][counter][0] = 0;
    }
    expect(() => checkEvidence(input)).toThrow(/C7 .*below 95%/);
  });

  it('accepts C7 and retains missing, zero-hit and stale-source protections', () => {
    const input = evidence(); input.scopes.C7 = [file];
    expect(checkEvidence(input).scopes.C7.lines).toEqual({ covered: 1, total: 1 });
    input.inventory.push('/synthetic/lib/instance/untouched.ts');
    expect(() => checkEvidence(input)).toThrow('missing inventory');
    input.inventory.pop();
    input.reports[1].hashes[file] = 'b'.repeat(64);
    expect(() => checkEvidence(input)).toThrow('hash');
  });

  it('enforces C7 lines independently when statements pass', () => {
    const input = evidence(); input.scopes = { C7: [file] };
    for (const item of input.reports) {
      const data = item.coverage[file];
      for (let i = 1; i < 20; i++) {
        data.statementMap[i] = { start: { line: 1, column: i * 10 }, end: { line: 1, column: i * 10 + 5 } }; data.s[i] = 1;
      }
      data.statementMap[20] = { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } }; data.s[20] = 0;
    }
    // A covered file supplies enough distinct lines for the global gate to pass.
    const padding = '/synthetic/lib/padding.ts'; input.inventory.push(padding); input.scopes.C6 = [padding];
    for (const item of input.reports) {
      const data = { ...structuredClone(item.coverage[file]), path: padding };
      for (let i = 0; i <= 20; i++) {
        data.statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 10 } }; data.s[i] = 1;
      }
      item.coverage[padding] = data; item.hashes[padding] = 'b'.repeat(64);
    }
    expect(() => checkEvidence(input)).toThrow('C7 lines below 95%');
  });
});

it('inventories executable sources, excludes declarations, assigns overlapping scopes and rejects symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-inventory-'));
  try {
    for (const dir of ['app', 'components', 'lib', 'scripts']) await mkdir(join(root, dir));
    await mkdir(join(root, 'lib/content'));
    const included = ['app/layout.tsx', 'app/loading.tsx', 'app/page.tsx', 'components/directory.tsx', 'components/runtime-sidebar.tsx', 'components/site-navigation.tsx', 'components/sign-in-button.tsx', 'components/sync-status-badge.tsx', 'lib/catalog.ts', 'lib/content/source.ts', 'lib/content/generations.ts', 'scripts/check.mjs', 'auth.ts', 'instrumentation.ts', 'mdx-components.tsx', 'next.config.mjs'];
    for (const file of [...included, 'lib/types.d.ts', 'postcss.config.mjs', 'README.md']) await writeFile(join(root, file), 'export {};');
    const inventory = await sourceInventory(root);
    expect(inventory).toEqual(included.map(file => resolve(root, file)).sort());
    const scopes = capabilityScopes(root, inventory);
    expect(scopes.C1).toContain(resolve(root, 'lib/catalog.ts'));
    expect(scopes.C1).toContain(resolve(root, 'app/loading.tsx'));
    expect(scopes.C1).toContain(resolve(root, 'components/sync-status-badge.tsx'));
    expect(scopes.C1).toContain(resolve(root, 'components/site-navigation.tsx'));
    expect(scopes.C1).toContain(resolve(root, 'components/runtime-sidebar.tsx'));
    expect(scopes.C3).toContain(resolve(root, 'components/runtime-sidebar.tsx'));
    expect(scopes.C2).toContain(resolve(root, 'app/page.tsx'));
    expect(scopes.C5).toContain(resolve(root, 'app/page.tsx'));
    expect(scopes.C5).toContain(resolve(root, 'app/loading.tsx'));
    expect(scopes.C5).toContain(resolve(root, 'components/directory.tsx'));
    expect(scopes.C5).toContain(resolve(root, 'components/site-navigation.tsx'));
    expect(scopes.C5).toContain(resolve(root, 'components/sync-status-badge.tsx'));
    expect(scopes.C5).toContain(resolve(root, 'lib/content/generations.ts'));
    expect(scopes.C2).toContain(resolve(root, 'components/sign-in-button.tsx'));
    expect(scopes.C2).toContain(resolve(root, 'lib/catalog.ts'));
    expect(scopes.C6).toContain(resolve(root, 'next.config.mjs'));
    expect(() => capabilityScopes(root, [join(root, 'lib/unassigned.ts')])).toThrow('Unassigned');
    await symlink(join(root, 'lib'), join(root, 'lib/linked'), 'junction');
    await expect(sourceInventory(root)).rejects.toThrow('symlink');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('checks on-disk inventory, capture containment, source hashes and raw capture presence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-evidence-'));
  try {
    await mkdir(join(root, 'lib')); await mkdir(join(root, 'coverage'));
    const actual = join(root, 'lib/config.ts');
    const code = 'export function example() { return 1; }';
    await writeFile(actual, code);
    const input = evidence();
    const hash = createHash('sha256').update(code).digest('hex');
    for (const item of input.reports) {
      item.coverage = { [actual]: { ...item.coverage[file], path: actual } };
      item.hashes = { [actual]: hash };
    }
    input.server.captures = ['coverage/raw.json'];
    const capture = join(root, 'coverage/raw.json');
    await writeFile(capture, JSON.stringify({ result: [{ url: 'file:///synthetic.js', functions: [] }] }));
    async function save() { await writeFile(join(root, 'coverage/evidence.json'), JSON.stringify(input)); }
    await save();
    expect((await runCoverageCheck(root)).global.statements).toMatchObject({ total: 1, covered: 1 });
    await writeFile(capture, JSON.stringify({ result: [] }));
    await expect(runCoverageCheck(root)).rejects.toThrow('capture');
    input.server.captures = ['../outside.json']; await save();
    await expect(runCoverageCheck(root)).rejects.toThrow('outside coverage');
    input.server.captures = ['coverage/raw.json']; await save();
    await writeFile(actual, 'changed');
    await expect(runCoverageCheck(root)).rejects.toThrow('changed');
    input.reports[0].coverage = { [resolve(root, '../outside.ts')]: { ...report()[file], path: resolve(root, '../outside.ts') } }; await save();
    await expect(runCoverageCheck(root)).rejects.toThrow('outside application');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('handles absent report arrays and malformed optional report/capture collections without trusting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-empty-coverage-'));
  try {
    await mkdir(join(root, 'coverage'));
    await writeFile(join(root, 'coverage/evidence.json'), JSON.stringify({}));
    await expect(runCoverageCheck(root)).rejects.toThrow('Missing coverage reports');
    await writeFile(join(root, 'coverage/evidence.json'), JSON.stringify({ reports: [{ coverage: null }] }));
    await expect(runCoverageCheck(root)).rejects.toThrow('test evidence');
  } finally { await rm(root, { recursive: true, force: true }); }
});
