import { createHash, timingSafeEqual } from 'node:crypto';
import { InstanceDatabaseSchema, sealInstanceDatabaseSetup, writeInstanceDatabase } from '@/lib/instance/database';
import { readInstanceHost, readInstancePreparation } from '@/lib/instance/bootstrap';
import { instanceErrorResponse, readInstanceJson } from '@/lib/instance/access';
import { connectMongo } from '@/lib/mongo';
import { initializeInstance, readInstance } from '@/lib/instance/store';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;
const inputSchema = InstanceDatabaseSchema.safeExtend({ credential: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/) });
let attempts = { until: 0, count: 0 };

/** Initial connection configuration is authorized by the protected host token. */
export async function POST(request: Request) {
  let storage;
  try {
    const prepared = await readInstancePreparation();
    if (prepared.marker.phase !== 'prepared' || prepared.operator.purpose !== 'bootstrap' || !process.env.INSTANCE_DATABASE_FILE) throw new Error('instance_setup_closed');
    if (request.headers.get('origin') !== prepared.setupOrigin || !request.headers.get('content-type')?.startsWith('application/json')) throw new Error('instance_origin');
    const now = new Date();
    if (now.getTime() >= attempts.until) attempts = { until: now.getTime() + 60_000, count: 0 };
    if (++attempts.count > 10) throw new Error('instance_rate_limited');
    const parsed = inputSchema.safeParse(await readInstanceJson(request));
    if (!parsed.success) throw new Error('instance_invalid');
    const { credential, ...locator } = parsed.data;
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(hash(credential), hash(prepared.operator.credential))) throw new Error('instance_setup_unauthorized');
    const host = await readInstanceHost({ ...process.env, MONGODB_URI: locator.mongodbUri, MONGODB_DATABASE: locator.mongodbDatabase, INSTANCE_DATABASE_FILE: undefined });
    storage = await connectMongo({ ...host.config, ...locator }, { initializeLegacy: false });
    const existing = await storage.db.collection<{ _id: string; instanceId: string }>('instance_configuration').findOne({ _id: 'instance' }, { projection: { instanceId: 1 } });
    if (existing && existing.instanceId !== host.instanceId) throw new Error('instance_database_not_empty');
    const current = await readInstance(storage.db, host.instanceId);
    const verifierHash = hash(credential).toString('hex');
    if (current && (current.lifecycle !== 'configuring' || current.active || current.candidate || current.initializedAt ||
        current.bootstrap.verifierHash !== verifierHash || current.recoveryEpoch !== prepared.marker.recoveryEpoch)) throw new Error('instance_database_mismatch');
    let count = 0;
    for await (const { name } of storage.db.listCollections({}, { nameOnly: true, maxTimeMS: 1000 })) {
      if (++count > 64) throw new Error('instance_database_not_empty');
      if (name.startsWith('system.')) continue;
      if (name === 'instance_configuration' && current && await storage.db.collection(name).countDocuments({}, { limit: 2 }) === 1) continue;
      if (await storage.db.collection(name).countDocuments({}, { limit: 1, maxTimeMS: 1000 })) throw new Error('instance_database_not_empty');
    }
    if (!current) await initializeInstance(storage.db, {
      _id: 'instance', instanceId: host.instanceId, schemaVersion: 2, revision: 0, editRevision: 0, nextBundleVersion: 1,
      lifecycle: 'configuring', createdAt: now, updatedAt: now, initializedAt: null,
      bootstrap: { epoch: 1, verifierHash, expiresAt: new Date(host.operator.expiresAt), consumedAt: null, sessionSlots: [] },
      securityEpoch: 1, recoveryEpoch: host.marker.recoveryEpoch, active: null, previous: null, candidate: null, administrators: [],
      gate: { state: 'open', activationId: null, deadline: null }, admissions: [], activation: null, auditOutbox: [], migration: null,
    });
    await writeInstanceDatabase(locator);
    await sealInstanceDatabaseSetup(host.instanceId);
    return Response.json({ status: 'configured', nextUrl: '/instance/setup' }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return instanceErrorResponse(error); }
  finally { await storage?.client.close(); }
}
