import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { assertRuntimeInstanceEffect } from '../instance/access';
import type { FileHandle } from 'node:fs/promises';
import { open, lstat, mkdir, readdir, realpath, rename, rm, type FileHandle as Handle } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { CatalogSchema, type Catalog } from '../catalog';
import { LIMITS } from '../limits';
import { SyncJobIdSchema } from '../sync/jobs';
import { validateCandidate, type CandidateFile } from './validate';
import { trimBlobCache } from './blob-cache';
import { canonicalPath, documentRoute, generationRoot, openSafeFile, resolveLinkTarget } from './paths';

const uuid = z.uuidv4();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path = z.string().refine(value => { try { return canonicalPath(value) === value; } catch { return false; } });
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const display = (maximum: number) => z.string().refine(value => [...value].length <= maximum && !/\p{Cc}/u.test(value));
const file = { path, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: integer };
const document = z.object({ ...file, size: integer.max(LIMITS.maxMarkdownBytes), route: z.string(),
  title: display(120).refine(value => value.trim().length > 0), description: display(500),
  headings: z.array(z.object({ id: display(1024), title: display(500), depth: integer.min(1).max(6) }).strict()).max(LIMITS.maxAstNodes),
  links: z.array(z.object({ href: display(1024), image: z.boolean() }).strict()).max(LIMITS.maxAstNodes),
}).strict();
const asset = z.object({ ...file, size: integer.max(LIMITS.maxAssetBytes),
  mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv', 'application/json']), inline: z.boolean(),
}).strict();
export const ManifestSchema = z.object({ formatVersion: z.literal(1), complete: z.literal(true), catalogId: uuid,
  configRevision: integer.min(1), generationId: uuid, commitSha: sha, treeSha: sha, fence: integer.min(1),
  completedAt: z.iso.datetime(), normalizedBytes: integer.max(LIMITS.maxSnapshotBytes),
  documents: z.array(document).min(1).max(LIMITS.maxPages), assets: z.array(asset).max(LIMITS.maxFiles),
  metadata: z.array(z.object({ ...file, size: integer.max(LIMITS.maxMetadataBytes) }).strict()).max(LIMITS.maxFiles),
}).strict().superRefine((value, context) => {
  const files = [...value.documents, ...value.assets, ...value.metadata];
  const valid = files.length <= LIMITS.maxFiles && new Set(files.map(item => item.path)).size === files.length &&
    new Set(value.documents.map(item => item.route)).size === value.documents.length &&
    files.reduce((total, item) => total + item.size, 0) <= value.normalizedBytes &&
    value.documents.every(item => item.route === documentRoute(item.path) && item.links.every(link => {
      try { resolveLinkTarget(item.path, link.href, link.image); return true; } catch { return false; }
    })) && value.metadata.every(item => item.path.split('/').at(-1) === 'meta.json') &&
    value.assets.every(item => {
      const mimes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json' };
      return mimes[item.path.split('.').at(-1)!.toLowerCase()] === item.mime && item.inline === item.mime.startsWith('image/');
    });
  if (!valid) context.addIssue({ code: 'custom', message: 'Invalid generation manifest' });
});
export type Manifest = z.infer<typeof ManifestSchema>;
const requestSchema = z.object({ catalogId: uuid, configRevision: integer.min(1), authEpoch: integer.min(1), generationId: uuid.optional() }).strict();
export type GenerationRequest = z.infer<typeof requestSchema>;

const livePins = { $filter: { input: '$readPins', as: 'pin', cond: { $gt: ['$$pin.expiresAt', '$$NOW'] } } };
function selectable(generationId: string, configRevision: number) {
  return { $or: [
    { $and: [{ $eq: ['$published.generationId', generationId] }, { $eq: ['$published.configRevision', configRevision] }] },
    { $anyElementTrue: { $map: { input: '$retained', as: 'generation', in: { $and: [
      { $eq: ['$$generation.generationId', generationId] }, { $eq: ['$$generation.configRevision', configRevision] },
      { $gt: ['$$generation.retiredAt', { $subtract: ['$$NOW', LIMITS.maxRetainedAgeMs] }] },
    ] } } } },
  ] };
}

export async function pinGeneration(db: Db, input: GenerationRequest) {
  const request = requestSchema.parse(input);
  const collection = db.collection<Catalog>('catalogs');
  const value = await collection.findOne({ _id: request.catalogId, enabled: true, accessState: 'ready', configRevision: request.configRevision, authEpoch: request.authEpoch });
  if (!value) throw new Error('content_unavailable');
  const catalog = CatalogSchema.parse(value);
  const generation = request.generationId ? [catalog.published, ...catalog.retained].find(item => item?.generationId === request.generationId) : catalog.published;
  if (!generation) throw new Error(request.generationId ? 'reload_required' : 'content_unavailable');
  const requestId = randomUUID();
  const updated = await collection.findOneAndUpdate({
    _id: catalog._id, enabled: true, accessState: 'ready', configRevision: request.configRevision, authEpoch: request.authEpoch,
    $expr: { $and: [selectable(generation.generationId, request.configRevision), { $lt: [{ $size: livePins }, LIMITS.maxReadPins] }] },
  }, [{ $set: { readPins: { $concatArrays: [livePins, [{ requestId, generationId: generation.generationId, expiresAt: { $add: ['$$NOW', LIMITS.readPinMs] } }]] } } }], { returnDocument: 'after' });
  if (!updated) {
    const current = await collection.findOne({ _id: catalog._id });
    if (current && current.readPins.filter(pin => pin.expiresAt > new Date()).length >= LIMITS.maxReadPins) throw new Error('capacity_exceeded');
    throw new Error('reload_required');
  }
  const expiresAt = updated.readPins.find(pin => pin.requestId === requestId)!.expiresAt;
  return { catalogId: catalog._id, configRevision: request.configRevision, generation, requestId, expiresAt,
    async release() { await collection.updateOne({ _id: catalog._id }, { $pull: { readPins: { requestId } } }); },
  };
}
export type GenerationPin = Awaited<ReturnType<typeof pinGeneration>>;

export async function readManifest(contentRoot: string, pin: GenerationPin) {
  let handle: FileHandle | undefined;
  try {
    const root = generationRoot(contentRoot, pin.catalogId, pin.generation.generationId);
    const path = relative(contentRoot, join(root, 'manifest.json')).split(sep).join('/');
    handle = await openSafeFile(contentRoot, path);
    if ((await handle.stat()).size > LIMITS.maxSnapshotBytes) throw new Error('invalid_content');
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== pin.generation.manifestDigest) throw new Error('invalid_content');
    const manifest = ManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (manifest.catalogId !== pin.catalogId || manifest.configRevision !== pin.configRevision || manifest.generationId !== pin.generation.generationId ||
        manifest.commitSha !== pin.generation.commitSha || manifest.fence !== pin.generation.fence ||
        bytes.length + [...manifest.documents, ...manifest.assets, ...manifest.metadata].reduce((total, item) => total + item.size, 0) > manifest.normalizedBytes) throw new Error('invalid_content');
    return manifest;
  } catch { throw new Error('invalid_content'); }
  finally { await handle?.close(); }
}

export async function withGeneration<T>(db: Db, contentRoot: string, request: GenerationRequest,
  read: (manifest: Manifest, signal: AbortSignal, pin: GenerationPin) => Promise<T>, signal?: AbortSignal) {
  const pin = await pinGeneration(db, request);
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new Error('delivery_timeout')), LIMITS.requestTimeoutMs);
  let abort: (() => void) | undefined;
  try {
    combined.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(combined.reason);
      combined.addEventListener('abort', abort, { once: true });
    });
    return await Promise.race([readManifest(contentRoot, pin).then(manifest => { combined.throwIfAborted(); return read(manifest, combined, pin); }), aborted]);
  } finally {
    clearTimeout(timer);
    if (abort) combined.removeEventListener('abort', abort);
    await pin.release();
  }
}

export async function retireGeneration(db: Db, catalogId: string, generationId: string) {
  uuid.parse(catalogId); uuid.parse(generationId);
  const result = await db.collection<Catalog>('catalogs').updateOne({ _id: catalogId,
    'published.generationId': { $ne: generationId },
    $expr: { $and: [
      { $not: { $anyElementTrue: { $map: { input: livePins, as: 'pin', in: { $eq: ['$$pin.generationId', generationId] } } } } },
      { $anyElementTrue: { $map: { input: '$retained', as: 'generation', in: { $and: [
        { $eq: ['$$generation.generationId', generationId] }, { $lte: ['$$generation.retiredAt', { $subtract: ['$$NOW', LIMITS.retainedGraceMs] }] },
      ] } } } },
    ] },
  }, { $pull: { retained: { generationId } } });
  return result.modifiedCount === 1;
}

const roomRequest = z.object({ catalogId: uuid, configRevision: integer.min(1), owner: uuid, fence: integer.min(1) }).strict();

async function deleteContainedDirectory(root: string, target: string) {
  await assertRuntimeInstanceEffect();
  const info = await lstat(target);
  const actual = await realpath(target);
  if (!info.isDirectory() || info.isSymbolicLink() || !contained(root, actual)) throw new Error('generation_invalid_path');
  await assertRuntimeInstanceEffect();
  await rm(actual, { recursive: true });
}

export async function deleteCatalogSnapshot(contentRoot: string, catalogId: string) {
  const id = uuid.parse(catalogId);
  const root = await realpath(contentRoot).catch(() => { throw new Error('generation_storage_unavailable'); });
  try { await deleteContainedDirectory(root, join(root, id)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('generation_storage_unavailable');
  }
}

async function pointerSize(root: string, catalogId: string, pointer: NonNullable<Catalog['published']>) {
  const manifestPath = relative(root, join(generationRoot(root, catalogId, pointer.generationId), 'manifest.json')).split(sep).join('/');
  let handle: FileHandle | undefined;
  try {
    handle = await openSafeFile(root, manifestPath);
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== pointer.manifestDigest) throw new Error();
    const manifest = ManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (manifest.catalogId !== catalogId || manifest.configRevision !== pointer.configRevision ||
        manifest.generationId !== pointer.generationId || manifest.commitSha !== pointer.commitSha ||
        manifest.normalizedBytes > LIMITS.maxSnapshotBytes) throw new Error();
    return manifest.normalizedBytes;
  } catch { throw new Error('generation_storage_unavailable'); }
  finally { await handle?.close(); }
}

export async function prepareGenerationRoom(db: Db, contentRoot: string, input: unknown) {
  const request = roomRequest.parse(input);
  const catalogs = db.collection<Catalog>('catalogs');
  const identity = { _id: request.catalogId, enabled: true, accessState: 'ready' as const, configRevision: request.configRevision,
    leaseFence: request.fence, 'lease.owner': request.owner, 'lease.fence': request.fence,
    $expr: { $gt: ['$lease.expiresAt', '$$NOW'] } };
  const catalogValue = await catalogs.findOneAndUpdate(identity, [{ $set: { readPins: livePins } }],
    { returnDocument: 'after', writeConcern: { w: 1, j: true } });
  if (!catalogValue) throw new Error('sync_lease_lost');
  let catalog = CatalogSchema.parse(catalogValue);
  const root = await realpath(contentRoot).catch(() => { throw new Error('generation_storage_unavailable'); });
  const catalogRoot = join(root, request.catalogId);
  const catalogInfo = await lstat(catalogRoot).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('generation_storage_unavailable');
  });
  if (catalogInfo && (!catalogInfo.isDirectory() || catalogInfo.isSymbolicLink() || !contained(root, await realpath(catalogRoot)))) {
    throw new Error('generation_invalid_path');
  }
  if (catalogInfo) {
    const activeStaging = `staging-${request.owner}-${request.fence}`;
    for (const entry of await readdir(catalogRoot, { withFileTypes: true })) {
      if (entry.name === 'generations' || entry.name === 'blob-cache') {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('generation_invalid_path');
        continue;
      }
      if (!entry.name.startsWith('staging-') || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error('generation_invalid_path');
      if (entry.name === activeStaging) throw new Error('retention_pressure');
      await deleteContainedDirectory(root, join(catalogRoot, entry.name));
    }
  }

  const protectedIds = new Set([catalog.published?.generationId, ...catalog.retained.map(item => item.generationId),
    ...catalog.readPins.map(pin => pin.generationId)].filter((value): value is string => Boolean(value)));
  const generationsRoot = join(catalogRoot, 'generations');
  const generationsInfo = await lstat(generationsRoot).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('generation_storage_unavailable');
  });
  if (generationsInfo) {
    if (!generationsInfo.isDirectory() || generationsInfo.isSymbolicLink() || !contained(root, await realpath(generationsRoot))) {
      throw new Error('generation_invalid_path');
    }
    for (const entry of await readdir(generationsRoot, { withFileTypes: true })) {
      if (!uuid.safeParse(entry.name).success || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error('generation_invalid_path');
      if (!protectedIds.has(entry.name)) await deleteContainedDirectory(root, join(generationsRoot, entry.name));
    }
  }

  while (catalog.retained.length >= LIMITS.maxRetainedGenerations) {
    const oldest = [...catalog.retained].sort((left, right) => left.retiredAt.getTime() - right.retiredAt.getTime())[0];
    if (!await retireGeneration(db, catalog._id, oldest.generationId)) throw new Error('retention_pressure');
    const generationPath = generationRoot(root, catalog._id, oldest.generationId);
    await deleteContainedDirectory(root, generationPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    const latest = await catalogs.findOne(identity);
    if (!latest) throw new Error('sync_lease_lost');
    catalog = CatalogSchema.parse(latest);
  }

  const generationBytes = (await Promise.all([catalog.published, ...catalog.retained].filter((pointer): pointer is NonNullable<Catalog['published']> => pointer !== null)
    .map(pointer => pointerSize(root, catalog._id, pointer)))).reduce((total, size) => total + size, 0);
  // The cache is disposable; reserve a full snapshot before retaining any cached blobs.
  const cacheBytes = await trimBlobCache(root, catalog._id, request.configRevision,
    LIMITS.maxCatalogPayloadBytes - generationBytes - LIMITS.maxSnapshotBytes);
  return generationBytes + cacheBytes;
}

const stageRequestSchema = z.object({ catalogId: uuid, configRevision: integer.min(1), owner: uuid, fence: integer.min(1),
  jobId: SyncJobIdSchema, commitSha: sha, treeSha: sha, files: z.array(z.object({ path: z.string(), mode: z.string(), content: z.instanceof(Buffer) }).strict()) }).strict();
const publishRequestSchema = z.object({ catalogId: uuid, configRevision: integer.min(1), owner: uuid, fence: integer.min(1),
  jobId: SyncJobIdSchema, publicationRevision: integer }).strict();
export type StagedGeneration = { root: string; manifest: Manifest; manifestDigest: string; owner: string; jobId: string };

function contained(root: string, path: string) {
  const fromRoot = relative(root, path);
  return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

async function safeDirectories(root: string, segments: string[], known: Set<string>) {
  let current = root;
  for (const segment of segments) {
    current = join(current, canonicalPath(segment));
    try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !contained(root, await realpath(current))) throw new Error('generation_invalid_path');
    known.add(current);
  }
  return current;
}

async function syncDirectory(path: string) {
  // Node cannot flush directory handles on Windows; each file is still flushed before rename there.
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeStagedFile(root: string, path: string, bytes: Buffer, directories: Set<string>) {
  const normalized = canonicalPath(path);
  const parent = posix.dirname(normalized);
  if (parent !== '.') await safeDirectories(root, parent.split('/'), directories);
  const target = join(root, ...normalized.split('/'));
  const handle: Handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function stageGeneration(contentRoot: string, input: unknown, catalogBytesUsed = 0): Promise<StagedGeneration> {
  await assertRuntimeInstanceEffect();
  const request = stageRequestSchema.parse(input);
  integer.max(LIMITS.maxCatalogPayloadBytes).parse(catalogBytesUsed);
  const candidate = validateCandidate(request.files as CandidateFile[]);
  if (request.files.some(file => canonicalPath(file.path) === 'manifest.json')) throw new Error('invalid_content');
  let actualRoot: string;
  try { actualRoot = await realpath(contentRoot); }
  catch { throw new Error('generation_storage_unavailable'); }
  if (!isAbsolute(actualRoot)) throw new Error('generation_storage_unavailable');
  const publicPath = resolve(process.cwd(), 'public');
  const publicRoot = await realpath(publicPath).catch(() => publicPath);
  if (actualRoot === publicRoot || contained(publicRoot, actualRoot)) throw new Error('generation_invalid_path');

  const generationId = randomUUID();
  const directories = new Set<string>([actualRoot]);
  let staging = '';
  try {
    const catalogRoot = await safeDirectories(actualRoot, [request.catalogId], directories);
    staging = join(catalogRoot, `staging-${request.owner}-${request.fence}`);
    await mkdir(staging);
    directories.add(staging);

    const documentFiles = candidate.documents.map(document => ({
      path: document.path, bytes: Buffer.from(document.markdown),
      manifest: { path: document.path, route: document.route, title: document.title,
        description: document.frontmatter.description ?? '', headings: document.headings, links: document.links },
    }));
    const assetFiles = candidate.assets.map(assetFile => ({ path: assetFile.path, bytes: assetFile.content,
      manifest: { path: assetFile.path, mime: assetFile.mime, inline: assetFile.inline } }));
    const metadataFiles = candidate.metadata.map(metadataFile => ({ path: metadataFile.path, bytes: metadataFile.content,
      manifest: { path: metadataFile.path } }));
    const documentManifest = documentFiles.map(({ bytes, manifest }) => ({ ...manifest,
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }));
    const assetManifest = assetFiles.map(({ bytes, manifest }) => ({ ...manifest,
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }));
    const metadataManifest = metadataFiles.map(({ bytes, manifest }) => ({ ...manifest,
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }));
    let normalizedBytes = candidate.bytes;
    let manifest = ManifestSchema.parse({ formatVersion: 1, complete: true, catalogId: request.catalogId,
      configRevision: request.configRevision, generationId, commitSha: request.commitSha, treeSha: request.treeSha,
      fence: request.fence, completedAt: new Date().toISOString(), normalizedBytes,
      documents: documentManifest, assets: assetManifest, metadata: metadataManifest });
    let manifestBytes = Buffer.from(JSON.stringify(manifest));
    for (let attempt = 0; attempt < 4 && normalizedBytes !== candidate.bytes + manifestBytes.length; attempt++) {
      normalizedBytes = candidate.bytes + manifestBytes.length;
      if (normalizedBytes > LIMITS.maxSnapshotBytes) throw new Error('invalid_content');
      manifest = ManifestSchema.parse({ ...manifest, normalizedBytes });
      manifestBytes = Buffer.from(JSON.stringify(manifest));
    }
    if (normalizedBytes !== candidate.bytes + manifestBytes.length || normalizedBytes > LIMITS.maxSnapshotBytes) throw new Error('invalid_content');
    if (normalizedBytes + catalogBytesUsed > LIMITS.maxCatalogPayloadBytes) throw new Error('retention_pressure');
    for (const file of [...documentFiles, ...assetFiles, ...metadataFiles]) {
      await writeStagedFile(staging, file.path, file.bytes, directories);
    }
    await writeStagedFile(staging, 'manifest.json', manifestBytes, directories);
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) await syncDirectory(directory);

    const parent = await safeDirectories(actualRoot, [request.catalogId, 'generations'], directories);
    const finalRoot = generationRoot(actualRoot, request.catalogId, generationId);
    await assertRuntimeInstanceEffect();
    await rename(staging, finalRoot);
    staging = '';
    await syncDirectory(parent);
    return { root: finalRoot, manifest, manifestDigest: createHash('sha256').update(manifestBytes).digest('hex'),
      owner: request.owner, jobId: request.jobId };
  } catch (error) {
    if (error instanceof Error && ['invalid_content', 'generation_invalid_path', 'retention_pressure'].includes(error.message)) throw error;
    throw new Error('generation_storage_unavailable');
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifyStagedGeneration(contentRoot: string, staged: StagedGeneration, request: z.infer<typeof publishRequestSchema>) {
  const { manifest } = staged;
  if (staged.owner !== request.owner || staged.jobId !== request.jobId || manifest.catalogId !== request.catalogId ||
      manifest.configRevision !== request.configRevision || manifest.fence !== request.fence) throw new Error('generation_invalid');
  const root = generationRoot(contentRoot, request.catalogId, manifest.generationId);
  const manifestPath = relative(contentRoot, join(root, 'manifest.json')).split(sep).join('/');
  let handle: FileHandle | undefined;
  try {
    handle = await openSafeFile(contentRoot, manifestPath);
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== staged.manifestDigest ||
        JSON.stringify(ManifestSchema.parse(JSON.parse(bytes.toString('utf8')))) !== JSON.stringify(manifest)) throw new Error('generation_invalid');
  } catch { throw new Error('generation_invalid'); }
  finally { await handle?.close(); }
  const files = [...manifest.documents, ...manifest.assets, ...manifest.metadata];
  let total = Buffer.byteLength(JSON.stringify(manifest));
  for (const file of files) {
    let item: FileHandle | undefined;
    try {
      item = await openSafeFile(root, file.path);
      if ((await item.stat()).size !== file.size) throw new Error();
      const bytes = await item.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error();
      total += bytes.length;
    } catch { throw new Error('generation_invalid'); }
    finally { await item?.close(); }
  }
  if (total !== manifest.normalizedBytes || total > LIMITS.maxSnapshotBytes) throw new Error('generation_invalid');
}

export async function publishGeneration(db: Db, contentRoot: string, staged: StagedGeneration, input: unknown) {
  const request = publishRequestSchema.parse(input);
  await verifyStagedGeneration(contentRoot, staged, request);
  await assertRuntimeInstanceEffect();
  const published = {
    generationId: staged.manifest.generationId, commitSha: staged.manifest.commitSha, jobId: request.jobId,
    fence: request.fence, configRevision: request.configRevision, manifestDigest: staged.manifestDigest, publishedAt: new Date(),
  };
  const result = await db.collection<Catalog>('catalogs').findOneAndUpdate({
    _id: request.catalogId, enabled: true, accessState: 'ready', configRevision: request.configRevision,
    leaseFence: request.fence, 'lease.owner': request.owner, 'lease.fence': request.fence,
    publicationRevision: request.publicationRevision,
    $expr: { $and: [{ $gt: ['$lease.expiresAt', '$$NOW'] },
      { $lt: [{ $size: '$retained' }, LIMITS.maxRetainedGenerations] }] },
  }, [{ $set: {
    retained: { $concatArrays: [
      { $cond: [{ $ne: ['$published', null] }, [{ $mergeObjects: ['$published', { retiredAt: '$$NOW' }] }], []] }, '$retained',
    ] },
    published: { ...published, publishedAt: '$$NOW' }, publicationRevision: { $add: ['$publicationRevision', 1] },
    lastSuccess: { jobId: request.jobId, commitSha: staged.manifest.commitSha, at: '$$NOW' },
    lastFailure: null, lease: null, updatedAt: '$$NOW',
  } }], { returnDocument: 'after', writeConcern: { w: 1, j: true } });
  if (!result) throw new Error('publication_conflict');
  try { return CatalogSchema.parse(result); }
  catch { throw new Error('publication_conflict'); }
}
