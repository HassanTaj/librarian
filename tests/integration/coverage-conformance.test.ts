import { expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { createCoverageMap } from '@vitest/istanbul-lib-coverage';
import type { CoverageMapData } from '@vitest/istanbul-lib-coverage';
import { captureSources } from '../../scripts/coverage-provenance.mjs';
import { capabilityScopes, mergeReports, sourceInventory } from '../../scripts/check-coverage.mjs';
import { startNextHarness } from './http-harness';

it('keeps new instance runtime sources visible to the real inventory and C7 boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-instance-coverage-'));
  try {
    await mkdir(join(root, 'lib/instance'), { recursive: true });
    const source = join(root, 'lib/instance/access.ts');
    await writeFile(source, 'export function authorize() { throw new Error("denied"); }');
    expect(await sourceInventory(root)).toEqual([source]);
    expect(capabilityScopes(root, await sourceInventory(root)).C7).toEqual([source]);
    const captured = await captureSources(root);
    expect(captured[source].hash).toMatch(/^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves uncovered sources and compatible Node/server/browser counters in real Next execution', async () => {
  const workspace = process.cwd();
  await mkdir(resolve(workspace, '.local'), { recursive: true });
  const root = await mkdtemp(resolve(workspace, '.local/coverage-conformance-'));
  try {
    await cp(resolve(workspace, 'tests/fixtures/coverage-app'), root, { recursive: true });
    await symlink(resolve(workspace, 'node_modules'), join(root, 'node_modules'), 'junction');
    for (const file of ['package.json', 'next.config.mjs', 'vitest.config.ts', 'tsconfig.json']) {
      await cp(resolve(workspace, file), join(root, file));
    }
    await mkdir(join(root, 'scripts'));
    for (const file of ['check-coverage.mjs', 'coverage-provenance.mjs', 'coverage-loader.mjs']) await cp(resolve(workspace, 'scripts', file), join(root, 'scripts', file));
    await writeFile(join(root, 'vitest.config.ts'), `
import { defineConfig } from 'vitest/config';
import { instrumentSource } from './scripts/coverage-loader.mjs';
export default defineConfig({
  plugins: [{ name: 'original-source-coverage', enforce: 'pre', transform(code, id) {
    if (id.includes('/lib/') && /\\.ts$/.test(id)) {
      const result = instrumentSource(code, id.replaceAll('/', process.platform === 'win32' ? '\\\\' : '/'));
      return { code: result.code, map: JSON.stringify(result.map) };
    }
  } }],
  test: { include: ['tests/unit/**/*.test.ts'], coverage: {
    provider: 'istanbul', include: ['lib/*.ts'], reporter: ['json'],
    thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
  } },
});
`);
    await mkdir(join(root, 'tests/integration'), { recursive: true });
    await cp(resolve(workspace, 'tests/integration/next-process.mjs'), join(root, 'tests/integration/next-process.mjs'));
    const captured = await captureSources(root);
    async function run(args: string[], env: Partial<NodeJS.ProcessEnv> = {}) {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const code = (await once(child, 'exit'))[0];
      if (code && args.includes('build')) throw new Error(`Synthetic fixture build failed: ${output}`);
      return code;
    }
    expect(await run([join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], { LIBRARIAN_COVERAGE_BUILD: '1' })).toBe(0);
    const directory = join(root, 'coverage/server');
    await mkdir(directory, { recursive: true });
    const serverFile = join(directory, 'instrumented.json');
    const server = await startNextHarness({ appRoot: root, port: 3189, env: { LIBRARIAN_INSTRUMENTED_CAPTURE: serverFile } });
    let browserCaptures;
    try {
      for (const role of ['', 'admin']) {
        const response = await fetch(`${server.origin}/api/private?role=${role}`);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ status: 'denied' });
      }
      expect((await fetch(`${server.origin}/api/private?role=reader`)).status).toBe(200);
      const browser = await chromium.launch({ headless: true,
        ...(process.env.LIBRARIAN_BROWSER_EXECUTABLE ? { executablePath: process.env.LIBRARIAN_BROWSER_EXECUTABLE } : {}) });
      try {
        const page = await browser.newPage();
        await page.goto(server.origin);
        await expect(page.title()).resolves.toBe('Synthetic coverage proof');
        await page.getByRole('button', { name: 'Toggle notice' }).click();
        await expect(page.getByText('Notice hidden').isVisible()).resolves.toBe(true);
        browserCaptures = await page.evaluate(() => (globalThis as typeof globalThis & { __VITEST_COVERAGE__: CoverageMapData }).__VITEST_COVERAGE__);
      } finally { await browser.close(); }
    } finally { await server.close(); }
    expect(server.process.exitCode).toBe(143);

    const serverMap = createCoverageMap(JSON.parse(await readFile(serverFile, 'utf8')));
    const browserMap = createCoverageMap(browserCaptures!);
    for (const file of ['app/page.tsx', 'app/api/private/route.ts', 'lib/access.ts']) {
      expect(Object.values(serverMap.fileCoverageFor(resolve(root, file)).data.s).some(hit => hit > 0), `Missing server hits: ${file}`).toBe(true);
    }
    const pageCoverage = serverMap.fileCoverageFor(resolve(root, 'app/page.tsx')).data;
    const metadata = Object.entries(pageCoverage.fnMap).find(([, fn]) => fn.name === 'generateMetadata');
    expect(metadata, 'The async metadata function must keep its original identity').toBeDefined();
    expect(pageCoverage.f[metadata![0]]).toBeGreaterThan(0);
    expect(Object.values(browserMap.fileCoverageFor(resolve(root, 'components/access-notice.tsx')).data.f).some(hit => hit > 0)).toBe(true);

    // These fixture files intentionally remain below 95%; verify the normal threshold rejects them.
    expect(await run([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage', '--coverage.reportsDirectory=coverage/node', '--reporter=json', '--outputFile=coverage/node-tests.json'])).toBe(1);
    const tests = JSON.parse(await readFile(join(root, 'coverage/node-tests.json'), 'utf8'));
    expect(tests.numPassedTests).toBe(3);
    expect(tests.numFailedTests).toBe(0);
    const rawNodeMap: CoverageMapData = JSON.parse(await readFile(join(root, 'coverage/node/coverage-final.json'), 'utf8'));
    const nodeMap = Object.fromEntries(Object.entries(rawNodeMap).map(([file, data]) => [resolve(file), { ...data, path: resolve(file) }]));
    const untouched = nodeMap[resolve(root, 'lib/untouched.ts')];
    expect(Object.values(untouched.s).every(hit => hit === 0)).toBe(true);
    const access = nodeMap[resolve(root, 'lib/access.ts')];
    expect(Object.values(access.f).some(hit => hit === 0)).toBe(true);
    expect(Object.values(access.b).flat().some(hit => hit === 0)).toBe(true);
    const filter = (map: ReturnType<typeof createCoverageMap>) => Object.fromEntries(map.files().filter(file => captured[file]).map(file => [file, map.fileCoverageFor(file).toJSON()]));
    await writeFile(resolve(workspace, '.local/coverage-conformance-diagnostics.json'), JSON.stringify({ node: nodeMap, server: filter(serverMap), browser: filter(browserMap) }, null, 2));
    const merged = mergeReports([nodeMap, filter(serverMap), filter(browserMap)]);
    expect(merged.files().filter(file => file === resolve(root, 'lib/access.ts'))).toHaveLength(1);
    expect(Object.values(merged.fileCoverageFor(resolve(root, 'lib/untouched.ts')).data.s).every(hit => hit === 0)).toBe(true);
  } finally {
    // This path was created by mkdtemp directly beneath this workspace's ignored .local directory.
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
