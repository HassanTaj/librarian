import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { readAuthorizedGeneration } from '../auth/authorization';
import { generationRoot, openSafeFile } from './paths';

export type DeliveredAsset = { bytes: Buffer; mime: string; inline: boolean; sha256: string; filename: string };

export async function readAsset(db: Db, contentRoot: string, slug: string, generationId: string | undefined,
  assetPath: string, signal?: AbortSignal) {
  return readAuthorizedGeneration(db, contentRoot, slug, generationId, async (manifest, abort, pin) => {
    const file = manifest.assets.find(item => item.path === assetPath);
    if (!file) throw new Error('not_found');
    abort.throwIfAborted();
    const root = generationRoot(contentRoot, pin.catalogId, manifest.generationId);
    let handle: Awaited<ReturnType<typeof openSafeFile>> | undefined;
    try {
      handle = await openSafeFile(root, file.path);
      if ((await handle.stat()).size !== file.size) throw new Error('invalid_content');
      const bytes = await handle.readFile();
      abort.throwIfAborted();
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('invalid_content');
      return { bytes, mime: file.mime, inline: file.inline, sha256: file.sha256, filename: file.path.split('/').at(-1)! } satisfies DeliveredAsset;
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_content') throw error;
      throw new Error('invalid_content');
    } finally { await handle?.close(); }
  }, signal);
}
