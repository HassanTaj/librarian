import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sourceInventory } from './check-coverage.mjs';
import { instrumentSource } from './coverage-loader.mjs';

const hash = code => createHash('sha256').update(code).digest('hex');

export async function captureSources(root) {
  /** @type {Record<string, {code: string, hash: string}>} */
  const sources = {};
  for (const path of await sourceInventory(root)) {
    const code = await readFile(path, 'utf8');
    sources[path] = { code, hash: hash(code) };
  }
  return sources;
}

/** Instrumented counters must have the exact maps of the unchanged original source. */
export async function verifyInstrumentedCoverage(input, captured) {
  /** @type {Record<string, import('@vitest/istanbul-lib-coverage').FileCoverageData>} */
  const output = {};
  for (const [file, data] of Object.entries(input)) {
    const path = resolve(file);
    const source = captured[path];
    if (!source || source.hash !== hash(source.code)) throw new Error('Missing pre-build source provenance');
    if (hash(await readFile(path, 'utf8')) !== source.hash) throw new Error(`Source changed after pre-build capture: ${relative(process.cwd(), path).replaceAll('\\', '/')}`);
    if (resolve(data.path) !== path) throw new Error('Coverage path/map mismatch');
    const expected = instrumentSource(source.code, path).coverage;
    const maps = coverage => JSON.stringify([coverage.statementMap, coverage.fnMap, coverage.branchMap]);
    if (maps(data) !== maps(expected)) throw new Error('Instrumented map differs from original source');
    output[path] = { ...data, path };
  }
  return output;
}

/** Missing embedded content is restored only from an unchanged pre-build source. */
export async function verifySourceMap(root, input, captured, virtualId) {
  if (!input || input.version !== 3 || !Array.isArray(input.sources) ||
      !Array.isArray(input.sourcesContent) || input.sourcesContent.length > input.sources.length) {
    throw new Error('Missing or invalid source map');
  }
  const map = { ...input, sources: [...input.sources], sourcesContent: [...input.sourcesContent], sourceRoot: '' };
  for (const [index, source] of input.sources.entries()) {
    const path = source.replace(/^webpack:\/\/[^/]+\/(?:_N_E\/)?(?:\.\/)?/, '');
    const absolute = path.startsWith('file:') ? fileURLToPath(path) : resolve(root, path);
    const original = Object.hasOwn(captured, absolute) || /^(?:app|lib|components)\/.*\.(?:ts|tsx)$/.test(path) || path === 'mdx-components.tsx';
    if (!original) {
      map.sources[index] = pathToFileURL(resolve(root, `.next/coverage-virtual/${virtualId}-${index}.js`)).href;
      continue;
    }
    const before = captured[absolute];
    if (!before || before.hash !== hash(before.code)) throw new Error('Missing pre-build source provenance');
    const current = await readFile(absolute, 'utf8');
    if (hash(current) !== before.hash) throw new Error(`Source changed after pre-build capture: ${relative(root, absolute).replaceAll('\\', '/')}`);
    if (map.sourcesContent[index] != null && map.sourcesContent[index] !== before.code) {
      throw new Error('Source-map content differs from pre-build source');
    }
    map.sourcesContent[index] = before.code;
    map.sources[index] = pathToFileURL(absolute).href;
  }
  return map;
}
