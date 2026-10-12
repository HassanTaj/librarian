import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureSources, verifySourceMap, verifyInstrumentedCoverage } from '../../scripts/coverage-provenance.mjs';
import { instrumentSource } from '../../scripts/coverage-loader.mjs';

let root: string;
let file: string;
const code = 'export const value = 1;\n';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'librarian-map-proof-'));
  await mkdir(join(root, 'lib'));
  file = join(root, 'lib/example.ts');
  await writeFile(file, code);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const map = (content: string | null = code) => ({ version: 3, sources: ['webpack://app/./lib/example.ts'], sourcesContent: [content], names: [], mappings: 'AAAA' });

it.each(['', 'webpack://app/'])('preserves full file URL identities after webpack composition: %s', async prefix => {
  const input = { ...map(), sources: [`${prefix}${pathToFileURL(file).href}`] };
  const output = await verifySourceMap(root, input, await captureSources(root), 'instrumented');
  expect(output.sources).toEqual([pathToFileURL(file).href]);
  expect(output.mappings).toBe(input.mappings);
});

it('verifies instrumented ranges against original source and rejects altered maps or identities', async () => {
  const sources = await captureSources(root);
  const data = instrumentSource(code, file).coverage!;
  expect(await verifyInstrumentedCoverage({ [file]: data }, sources)).toEqual({ [file]: data });
  await expect(verifyInstrumentedCoverage({ [file]: { ...data, path: `${file}.other` } }, sources)).rejects.toThrow('path/map');
  const changed = structuredClone(data);
  changed.statementMap['0'].end.column++;
  await expect(verifyInstrumentedCoverage({ [file]: changed }, sources)).rejects.toThrow('differs');
  await expect(verifyInstrumentedCoverage({ [file]: data }, {})).rejects.toThrow('provenance');
  await writeFile(file, `${code}// changed`);
  await expect(verifyInstrumentedCoverage({ [file]: data }, sources)).rejects.toThrow('changed');
});

it.each([code, null])('preserves mapping positions with verified embedded or omitted content', async content => {
  const input = map(content);
  const result = await verifySourceMap(root, input, await captureSources(root), 'probe');
  expect(result).toMatchObject({ sources: [pathToFileURL(file).href], sourcesContent: [code], mappings: 'AAAA', sourceRoot: '' });
  expect(input.sourcesContent).toEqual([content]);
});

it('rejects source edits made after the pre-build capture', async () => {
  const captured = await captureSources(root);
  await writeFile(file, 'export const value = 2;\n');
  await expect(verifySourceMap(root, map(null), captured, 'probe')).rejects.toThrow('changed');
});

it('rejects missing or corrupted pre-build provenance', async () => {
  await expect(verifySourceMap(root, map(null), {}, 'probe')).rejects.toThrow('provenance');
  const captured = await captureSources(root);
  captured[file].code = 'modified';
  await expect(verifySourceMap(root, map(null), captured, 'probe')).rejects.toThrow('provenance');
});

it('rejects a map containing different application source', async () => {
  await expect(verifySourceMap(root, map('different'), await captureSources(root), 'probe')).rejects.toThrow('differs');
});

it.each([null, {}, { version: 2, sources: [], sourcesContent: [] }, { version: 3, sources: [] }, { version: 3, sources: [], sourcesContent: ['extra'] }])('rejects missing or malformed source maps', async input => {
  await expect(verifySourceMap(root, input, {}, 'probe')).rejects.toThrow('source map');
});

it('restores omitted trailing content only with pre-build application provenance', async () => {
  const input = { ...map(), sourcesContent: [] };
  const result = await verifySourceMap(root, input, await captureSources(root), 'probe');
  expect(result.sourcesContent).toEqual([code]);
  await expect(verifySourceMap(root, input, {}, 'probe')).rejects.toThrow('provenance');
});

it('keeps third-party identities separate from canonical application sources', async () => {
  const input = { version: 3, sources: ['webpack://app/./node_modules/example.js'], sourcesContent: ['export {}'], mappings: '' };
  const result = await verifySourceMap(root, input, {}, 'probe');
  expect(result.sources).toEqual([pathToFileURL(join(root, '.next/coverage-virtual/probe-0.js')).href]);
});
