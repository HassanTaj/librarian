import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorageHarness } from './http-harness';
import { catalogs } from '../fixtures/catalogs';
import { CatalogSchema, type Catalog } from '../../lib/catalog';
import { generationRoot } from '../../lib/content/paths';
import { pinGeneration, readManifest, withGeneration, retireGeneration, ManifestSchema } from '../../lib/content/generations';
import { LIMITS } from '../../lib/limits';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function seed() {
  const storage = await createStorageHarness();
  const generationId = randomUUID();
  const catalog = CatalogSchema.parse(catalogs[0]);
  const manifest = {
    formatVersion: 1, complete: true, catalogId: catalog._id, configRevision: 1, generationId,
    commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), fence: 1, completedAt: new Date().toISOString(),
    normalizedBytes: 1024, documents: [{ path: 'index.md', route: '', title: 'Synthetic', description: '', headings: [], links: [], sha256: digest(Buffer.from('Synthetic')), size: 9 }],
    assets: [], metadata: [],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const root = generationRoot(storage.contentRoot, catalog._id, generationId);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'manifest.json'), bytes);
  const published = { generationId, commitSha: manifest.commitSha, jobId: `manual:${catalog._id}:${randomUUID()}`, fence: 1, configRevision: 1, manifestDigest: digest(bytes), publishedAt: new Date() };
  const record = CatalogSchema.parse({ ...catalog, published, publicationRevision: 1, leaseFence: 1 });
  await storage.db.collection<Catalog>('catalogs').insertOne(record);
  const request = { catalogId: catalog._id, configRevision: 1, authEpoch: 1 };
  return { ...storage, generationDirectory: root, record, request, manifest, bytes, generationId };
}

it('selects one complete current generation, validates its manifest and releases the atomic read pin', async () => {
  const storage = await seed();
  try {
    const pin = await pinGeneration(storage.db, storage.request);
    expect(pin.generation.generationId).toBe(storage.generationId);
    expect(pin.expiresAt.getTime() - Date.now()).toBeGreaterThan(59_000);
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.record._id }))?.readPins).toHaveLength(1);
    expect(await readManifest(storage.contentRoot, pin)).toEqual(storage.manifest);
    await pin.release(); await pin.release();
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.record._id }))?.readPins).toHaveLength(0);
  } finally { await storage.close(); }
});

it('bounds concurrent pins, prunes expired pins, and rejects changed catalog state before selection', async () => {
  const storage = await seed();
  const collection = storage.db.collection<Catalog>('catalogs');
  try {
    const pins = await Promise.all(Array.from({ length: LIMITS.maxReadPins }, () => pinGeneration(storage.db, storage.request)));
    await expect(pinGeneration(storage.db, storage.request)).rejects.toThrow('capacity_exceeded');
    await collection.updateOne({ _id: storage.record._id }, { $set: { readPins: [{ requestId: randomUUID(), generationId: storage.generationId, expiresAt: new Date(0) }] } });
    const fresh = await pinGeneration(storage.db, storage.request);
    expect((await collection.findOne({ _id: storage.record._id }))?.readPins).toHaveLength(1);
    await fresh.release();
    for (const patch of [{ enabled: false }, { accessState: 'blocked' as const }, { authEpoch: 2 }, { configRevision: 2 }, { published: null }]) {
      await collection.replaceOne({ _id: storage.record._id }, { ...storage.record, ...patch });
      await expect(pinGeneration(storage.db, storage.request)).rejects.toThrow();
    }
    await Promise.all(pins.map(pin => pin.release()));
  } finally { await storage.close(); }
});

it('retained selection remains explicit and cleanup cannot remove a pinned or active generation', async () => {
  const storage = await seed();
  const collection = storage.db.collection<Catalog>('catalogs');
  try {
    const current = { ...storage.record.published!, generationId: randomUUID() };
    const retained = { ...storage.record.published!, retiredAt: new Date(Date.now() - LIMITS.retainedGraceMs - 1000) };
    await collection.updateOne({ _id: storage.record._id }, { $set: { published: current, retained: [retained] } });
    const pin = await pinGeneration(storage.db, { ...storage.request, generationId: storage.generationId });
    expect(await retireGeneration(storage.db, storage.record._id, storage.generationId)).toBe(false);
    expect(await retireGeneration(storage.db, storage.record._id, current.generationId)).toBe(false);
    await pin.release();
    expect(await retireGeneration(storage.db, storage.record._id, storage.generationId)).toBe(true);
    await expect(pinGeneration(storage.db, { ...storage.request, generationId: storage.generationId })).rejects.toThrow('reload_required');
    await collection.updateOne({ _id: storage.record._id }, { $set: { retained: [{ ...retained, retiredAt: new Date(Date.now() - LIMITS.maxRetainedAgeMs - 1000) }] } });
    await expect(pinGeneration(storage.db, { ...storage.request, generationId: storage.generationId })).rejects.toThrow('reload_required');
    await collection.updateOne({ _id: storage.record._id }, { $set: { retained: [{ ...retained, retiredAt: new Date() }] } });
    expect(await retireGeneration(storage.db, storage.record._id, storage.generationId)).toBe(false);
  } finally { await storage.close(); }
});

it('denies incomplete, corrupt, wrong-scope or oversized manifests and always releases pins', async () => {
  const storage = await seed();
  try {
    for (const patch of [{ complete: false }, { catalogId: randomUUID() }, { generationId: randomUUID() }, { commitSha: 'c'.repeat(40) }, { configRevision: 2 }, { normalizedBytes: LIMITS.maxSnapshotBytes + 1 }]) {
      const bytes = Buffer.from(JSON.stringify({ ...storage.manifest, ...patch }));
      await writeFile(join(storage.generationDirectory, 'manifest.json'), bytes);
      await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.record._id }, { $set: { 'published.manifestDigest': digest(bytes) } });
      await expect(withGeneration(storage.db, storage.contentRoot, storage.request, async () => 'Never delivered')).rejects.toThrow('invalid_content');
      expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.record._id }))?.readPins).toHaveLength(0);
    }
    await writeFile(join(storage.generationDirectory, 'manifest.json'), storage.bytes);
    await expect(withGeneration(storage.db, storage.contentRoot, storage.request, async () => 'Never delivered')).rejects.toThrow('invalid_content');
  } finally { await storage.close(); }
});

it('releases pins on callback failure, abort and delivery timeout', async () => {
  const storage = await seed();
  try {
    await expect(withGeneration(storage.db, storage.contentRoot, storage.request, async () => { throw new Error('synthetic_callback_failure'); })).rejects.toThrow('synthetic_callback_failure');
    const controller = new AbortController();
    const read = withGeneration(storage.db, storage.contentRoot, storage.request, async (_manifest, signal) => {
      controller.abort();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, controller.signal);
    await expect(read).rejects.toThrow();
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.record._id }))?.readPins).toHaveLength(0);
  } finally { await storage.close(); }
});

it('rejects a generation directory symlink even when its copied manifest has the expected digest', async () => {
  const storage = await seed();
  try {
    const outside = join(storage.root, 'outside');
    await rename(storage.generationDirectory, outside);
    await symlink(outside, storage.generationDirectory, 'junction');
    const pin = await pinGeneration(storage.db, storage.request);
    try { await expect(readManifest(storage.contentRoot, pin)).rejects.toThrow(); }
    finally { await pin.release(); }
  } finally { await storage.close(); }
});

it('validates full manifest links, asset mapping, navigation metadata and bounded identity fields', async () => {
  const storage = await seed();
  try {
    const manifest = { ...storage.manifest,
      documents: [{ ...storage.manifest.documents[0], headings: [{ id: 'heading', title: 'Safe heading', depth: 1 }], links: [{ href: 'https://synthetic.invalid', image: false }, { href: 'pixel.png', image: true }] }],
      assets: [{ path: 'pixel.png', mime: 'image/png', inline: true, size: 33, sha256: 'a'.repeat(64) }, { path: 'notes.txt', mime: 'text/plain', inline: false, size: 10, sha256: 'b'.repeat(64) }],
      metadata: [{ path: 'meta.json', size: 2, sha256: 'c'.repeat(64) }],
    };
    expect(ManifestSchema.parse(manifest)).toEqual(manifest);
    for (const patch of [
      { documents: [{ ...manifest.documents[0], route: 'different' }] },
      { documents: [{ ...manifest.documents[0], links: [{ href: 'javascript:alert(1)', image: false }] }] },
      { documents: [{ ...manifest.documents[0], path: '../escape.md' }] },
      { documents: [manifest.documents[0], manifest.documents[0]] },
      { assets: [{ ...manifest.assets[0], mime: 'text/plain', inline: false }] },
      { assets: [{ ...manifest.assets[0], inline: false }] },
      { metadata: [{ ...manifest.metadata[0], path: 'ordinary.json' }] },
      { normalizedBytes: 1 },
    ]) expect(() => ManifestSchema.parse({ ...manifest, ...patch })).toThrow();
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.record._id }, { $set: { published: null } });
    await expect(pinGeneration(storage.db, storage.request)).rejects.toThrow('content_unavailable');
    await expect(pinGeneration(storage.db, { ...storage.request, generationId: randomUUID() })).rejects.toThrow('reload_required');
  } finally { await storage.close(); }
});

it('bounds manifest bytes, verifies the publication fence and sanitizes missing files', async () => {
  const storage = await seed();
  try {
    const collection = storage.db.collection<Catalog>('catalogs');
    const bytes = Buffer.from(JSON.stringify({ ...storage.manifest, fence: 2 }));
    await writeFile(join(storage.generationDirectory, 'manifest.json'), bytes);
    await collection.updateOne({ _id: storage.record._id }, { $set: { 'published.manifestDigest': digest(bytes) } });
    await expect(withGeneration(storage.db, storage.contentRoot, storage.request, async () => 'Never')).rejects.toThrow('invalid_content');
    await writeFile(join(storage.generationDirectory, 'manifest.json'), Buffer.alloc(LIMITS.maxSnapshotBytes + 1));
    await expect(withGeneration(storage.db, storage.contentRoot, storage.request, async () => 'Never')).rejects.toThrow('invalid_content');
  } finally { await storage.close(); }
});

it('ends an unresponsive delivery within thirty seconds and releases its pin', async () => {
  const storage = await seed();
  const started = Date.now();
  try {
    await expect(withGeneration(storage.db, storage.contentRoot, storage.request, async (_manifest, signal) => {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    })).rejects.toThrow('delivery_timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(LIMITS.requestTimeoutMs);
    expect(Date.now() - started).toBeLessThan(LIMITS.requestTimeoutMs + 5000);
    expect((await storage.db.collection<Catalog>('catalogs').findOne({ _id: storage.record._id }))?.readPins).toHaveLength(0);
    await expect(withGeneration(storage.db, storage.contentRoot, storage.request, async () => 'Never', AbortSignal.abort(new Error('pre_aborted')))).rejects.toThrow('pre_aborted');
  } finally { await storage.close(); }
});

it('serializes a retained-generation cleanup race against a new reader', async () => {
  const storage = await seed();
  try {
    const retained = { ...storage.record.published!, retiredAt: new Date(Date.now() - LIMITS.retainedGraceMs - 1000) };
    await storage.db.collection<Catalog>('catalogs').updateOne({ _id: storage.record._id }, { $set: { published: { ...storage.record.published!, generationId: randomUUID() }, retained: [retained] } });
    const [reader, cleanup] = await Promise.allSettled([
      pinGeneration(storage.db, { ...storage.request, generationId: storage.generationId }), retireGeneration(storage.db, storage.record._id, storage.generationId),
    ]);
    expect(cleanup.status).toBe('fulfilled');
    if (reader.status === 'fulfilled') {
      expect(cleanup.status === 'fulfilled' && cleanup.value).toBe(false);
      await reader.value.release();
    } else {
      expect(reader.reason.message).toBe('reload_required');
      expect(cleanup.status === 'fulfilled' && cleanup.value).toBe(true);
    }
  } finally { await storage.close(); }
});
