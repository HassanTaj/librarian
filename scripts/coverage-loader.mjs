import { programVisitor } from '@vitest/istanbul-lib-instrument';
import { transformSync } from '@babel/core';
import { pathToFileURL } from 'node:url';

// Instrument original source before either compiler changes its function boundaries.
export function instrumentSource(code, filename) {
  /** @type {import('@vitest/istanbul-lib-coverage').FileCoverageData | undefined} */
  let coverage;
  const result = transformSync(code, {
    filename, configFile: false, babelrc: false, sourceMaps: true, compact: false,
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    plugins: [({ types }) => {
      const visitor = programVisitor(types, filename, {
        coverageVariable: '__VITEST_COVERAGE__', coverageGlobalScope: 'globalThis', coverageGlobalScopeFunc: false,
      });
      return { visitor: { Program: {
        enter(path) {
          if (path.hub.file.ast.comments.some(comment => /^\s*(?:istanbul|v8|c8)\s+ignore\b/.test(comment.value))) throw new Error('Coverage ignore annotations are not allowed');
          visitor.enter(path);
        },
        exit(path) {
          coverage = visitor.exit(path).fileCoverage;
        },
      } } };
    }],
  });
  const map = result?.map;
  if (!coverage) throw new Error('Instrumenter omitted executable source');
  if (!map || map.sources.length !== 1 || map.sourcesContent?.[0] !== code) throw new Error('Instrumenter lost original source identity');
  return { code: result.code, map: { ...map, sources: [pathToFileURL(filename).href] }, coverage };
}

export default function coverageLoader(code) {
  const result = instrumentSource(code, this.resourcePath);
  this.callback(null, result.code, result.map);
}
