import { fileURLToPath } from 'node:url';
import { sourceInventory } from '../../scripts/check-coverage.mjs';
import { instrumentSource } from '../../scripts/coverage-loader.mjs';

let sources;
export async function initialize({ root }) { sources = new Set(await sourceInventory(root)); }
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith('file:')) return result;
  const file = fileURLToPath(url);
  if (!sources.has(file)) return result;
  return { ...result, source: instrumentSource(result.source.toString(), file).code };
}
