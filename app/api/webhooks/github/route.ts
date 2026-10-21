import { withRuntimeInstanceAdmission } from '@/lib/instance/access';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { connectMongo, getMongo } from '@/lib/mongo';
import { blockCatalogForAccessLoss, type Catalog } from '@/lib/catalog';
import { admitControlReceipt, admitSyncJob, newGitHubJobId, type ControlReceipt, type SyncJob } from '@/lib/sync/jobs';
import { verifyGitHubSignature } from '@/lib/sync/webhook';
import { loadConfig } from '@/lib/config';
import { LIMITS } from '@/lib/limits';
import { readInstanceHost } from '@/lib/instance/bootstrap';
import { consumeInstanceRate } from '@/lib/instance/access';
import { decryptInstanceSecret } from '@/lib/instance/secrets';
import { readInstance, recordInstanceCheck } from '@/lib/instance/store';

export const runtime = 'nodejs';

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuid = z.uuid();
const removedRepositories = z.array(z.object({ id: positiveId }).passthrough()).max(LIMITS.maxControlRepositories);
const pushPayload = z.object({
  installation: z.object({ id: positiveId }).passthrough(),
  repository: z.object({
    id: positiveId,
    full_name: z.string().min(3).max(300),
  }).passthrough(),
  ref: z.string().min(1).max(1024),
}).passthrough();

type ControlQuery = 'invalid' | 'ignored' | { event: 'installation' | 'installation_repositories' | 'repository';
  action: 'deleted' | 'removed'; installationId?: number; repositoryId?: number; filter: Record<string, unknown> };

function controlQuery(event: string, payload: unknown): ControlQuery {
  if (!['installation', 'installation_repositories', 'repository'].includes(event)) return 'ignored';
  if (!payload || typeof payload !== 'object' || !('action' in payload) || typeof payload.action !== 'string') return 'invalid';
  const action = payload.action;
  if (event === 'installation') {
    if (action !== 'deleted') return 'ignored';
    const parsed = z.object({ installation: z.object({ id: positiveId }).passthrough() }).passthrough().safeParse(payload);
    return parsed.success ? { event: 'installation', action: 'deleted', installationId: parsed.data.installation.id,
      filter: { 'github.installationId': parsed.data.installation.id } } : 'invalid';
  }
  if (event === 'installation_repositories') {
    if (action !== 'removed') return 'ignored';
    const parsed = z.object({ installation: z.object({ id: positiveId }).passthrough(), repositories_removed: removedRepositories }).passthrough().safeParse(payload);
    if (!parsed.success) return 'invalid';
    const repositoryIds = [...new Set(parsed.data.repositories_removed.map(repository => repository.id))];
    return repositoryIds.length ? { event: 'installation_repositories', action: 'removed', installationId: parsed.data.installation.id,
      filter: { 'github.installationId': parsed.data.installation.id, 'github.repositoryId': { $in: repositoryIds } } } : 'ignored';
  }
  if (event === 'repository') {
    if (action !== 'deleted') return 'ignored';
    const parsed = z.object({ repository: z.object({ id: positiveId }).passthrough(),
      installation: z.object({ id: positiveId }).passthrough().optional() }).passthrough().safeParse(payload);
    if (!parsed.success) return 'invalid';
    const installationId = parsed.data.installation?.id;
    return { event: 'repository', action: 'deleted', installationId, repositoryId: parsed.data.repository.id,
      filter: { 'github.repositoryId': parsed.data.repository.id, ...(installationId ? { 'github.installationId': installationId } : {}) } };
  }
  return 'ignored';
}

async function readBounded(request: Request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > LIMITS.maxWebhookBytes)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.maxWebhookBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

type SetupWebhookReceipt = { _id: string; instanceId: string; candidateVersion: number; payloadDigest: string; event: string; expiresAt: Date };

async function handleSetupWebhook(request: Request, raw: Uint8Array): Promise<Response | null> {
  if (!process.env.INSTANCE_STATE_FILE && !process.env.INSTANCE_ID) return null;
  let host: Awaited<ReturnType<typeof readInstanceHost>>;
  try { host = await readInstanceHost(); }
  catch { return reply(503, { status: 'unavailable' }); }
  let storage: Awaited<ReturnType<typeof connectMongo>>;
  try { storage = await connectMongo(host.config, { initializeLegacy: false }); }
  catch { return reply(503, { status: 'unavailable' }); }
  try {
    const control = await readInstance(storage.db, host.instanceId);
    if (!control) return reply(503, { status: 'unavailable' });
    if (control.lifecycle === 'ready') return null;
    if (!['configuring', 'awaiting_owner'].includes(control.lifecycle) || control.bootstrap.consumedAt || Date.now() >= control.bootstrap.expiresAt.getTime()) {
      return reply(503, { status: 'unavailable' });
    }
    const candidate = control.candidate;
    const envelope = candidate?.secrets.githubWebhookSecret;
    if (!candidate || !envelope) return reply(403, { status: 'forbidden' });
    let secret: string;
    try { secret = decryptInstanceSecret(envelope, { instanceId: host.instanceId, purpose: 'githubWebhookSecret', credentialVersion: envelope.credentialVersion }, host.keyring); }
    catch { return reply(503, { status: 'unavailable' }); }
    if (!verifyGitHubSignature(raw, request.headers.get('x-hub-signature-256'), secret)) return reply(403, { status: 'forbidden' });

    const deliveryId = uuid.safeParse(request.headers.get('x-github-delivery'));
    const event = request.headers.get('x-github-event')?.toLowerCase();
    if (!deliveryId.success || !event || !/^[a-z][a-z0-9_]{0,63}$/.test(event)) return reply(400, { status: 'invalid_request' });
    if (event !== 'ping') return reply(202, { status: 'ignored' });

    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { return reply(400, { status: 'invalid_payload' }); }
    const ping = z.object({ hook_id: positiveId, hook: z.object({ id: positiveId }).passthrough() }).passthrough().safeParse(payload);
    if (!ping.success || ping.data.hook_id !== ping.data.hook.id) return reply(400, { status: 'invalid_payload' });

    const receipts = storage.db.collection<SetupWebhookReceipt>('instance_setup_webhook_receipts');
    try { await receipts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); }
    catch { return reply(503, { status: 'unavailable' }); }
    const payloadDigest = createHash('sha256').update(raw).digest('hex');
    const _id = createHash('sha256').update(JSON.stringify([host.instanceId, candidate.version, deliveryId.data])).digest('hex');
    const prior = await receipts.findOne({ _id });
    if (prior && (prior.payloadDigest !== payloadDigest || prior.event !== event || prior.candidateVersion !== candidate.version)) return reply(409, { status: 'conflict' });
    let duplicateReceipt = !!prior;
    if (!prior) {
      try { await consumeInstanceRate(storage.db, host.instanceId, host.instanceId, 'webhook'); }
      catch (error) { if (error instanceof Error && error.message === 'instance_rate_limited') return reply(429, { status: 'rate_limited' }); return reply(503, { status: 'unavailable' }); }
      try {
        await receipts.insertOne({ _id, instanceId: host.instanceId, candidateVersion: candidate.version, payloadDigest, event,
          expiresAt: new Date(Date.now() + LIMITS.instanceSetupReceiptMs) }, { writeConcern: { w: 1, j: true } });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) return reply(503, { status: 'unavailable' });
        const duplicate = await receipts.findOne({ _id });
        if (!duplicate || duplicate.payloadDigest !== payloadDigest || duplicate.event !== event || duplicate.candidateVersion !== candidate.version) return reply(409, { status: 'conflict' });
        duplicateReceipt = true;
      }
    }
    const currentCheck = control.candidate?.checks.find(item => item.type === 'github_webhook' && item.candidateVersion === candidate.version);
    if (currentCheck?.status !== 'passed' || currentCheck.code !== 'provider_ok') {
      try {
        await recordInstanceCheck(storage.db, host.instanceId, { type: 'github_webhook', candidateVersion: candidate.version,
          at: new Date(), status: 'passed', code: 'provider_ok' });
      } catch (error) {
        if (error instanceof Error && error.message === 'instance_conflict') {
          const latest = await readInstance(storage.db, host.instanceId).catch(() => null);
          const saved = latest?.candidate?.checks.find(item => item.type === 'github_webhook' && item.candidateVersion === candidate.version);
          if (saved?.status === 'passed' && saved.code === 'provider_ok') return reply(200, { status: 'duplicate', candidateVersion: candidate.version });
          return reply(409, { status: 'conflict' });
        }
        return reply(503, { status: 'unavailable' });
      }
    }
    return reply(duplicateReceipt ? 200 : 202, { status: duplicateReceipt ? 'duplicate' : 'accepted', candidateVersion: candidate.version });
  } catch { return reply(503, { status: 'unavailable' }); }
  finally { await storage.client.close(); }
}

export async function POST(request: Request) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return reply(400, { status: 'invalid_request' });
  }
  const raw = await readBounded(request);
  if (!raw) return reply(413, { status: 'too_large' });

  const setupProof = await handleSetupWebhook(request, raw);
  if (setupProof) return setupProof;

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try { config = await loadConfig(); }
  catch { return reply(503, { status: 'unavailable' }); }
  let signatureValid = verifyGitHubSignature(raw, request.headers.get('x-hub-signature-256'), config.githubWebhookSecret);
  if (!signatureValid && (process.env.INSTANCE_ID || process.env.INSTANCE_STATE_FILE)) {
    try {
      const host = await readInstanceHost();
      const { db } = await getMongo(config);
      const control = await readInstance(db, host.instanceId);
      const previous = control?.active?.secrets.previousWebhook;
      if (control?.lifecycle === 'ready' && control.gate.state === 'open' && previous && previous.acceptUntil > new Date()) {
        const secret = decryptInstanceSecret(previous.envelope, { instanceId: host.instanceId, purpose: 'githubWebhookSecret', credentialVersion: previous.envelope.credentialVersion }, host.keyring);
        signatureValid = verifyGitHubSignature(raw, request.headers.get('x-hub-signature-256'), secret);
      }
    } catch { return reply(503, { status: 'unavailable' }); }
  }
  if (!signatureValid) {
    return reply(403, { status: 'forbidden' });
  }
  const deliveryId = uuid.safeParse(request.headers.get('x-github-delivery'));
  const event = request.headers.get('x-github-event')?.toLowerCase();
  if (!deliveryId.success || !event || !/^[a-z][a-z0-9_]{0,63}$/.test(event)) {
    return reply(400, { status: 'invalid_request' });
  }

  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { return reply(400, { status: 'invalid_payload' }); }

  const payloadDigest = createHash('sha256').update(raw).digest('hex');
  let db;
  try { db = (await getMongo(config)).db; }
  catch { return reply(503, { status: 'unavailable' }); }

  try { return await withRuntimeInstanceAdmission(db, 'request', async () => {
  const prefix = `github:${config.githubAppId}:${deliveryId.data}:`;
  const jobs = db.collection<SyncJob>('syncJobs');
  const receipts = db.collection<ControlReceipt>('controlReceipts');
  let prior: SyncJob[];
  let priorControls: ControlReceipt[];
  try {
    [prior, priorControls] = await Promise.all([
      jobs.find({ _id: { $regex: `^${prefix}` } }).toArray(), receipts.find({ _id: { $regex: `^${prefix}` } }).toArray(),
    ]);
  }
  catch { return reply(503, { status: 'unavailable' }); }
  if (prior.some(job => job.payloadDigest !== payloadDigest || job.origin !== 'github' || job.event !== event) ||
      priorControls.some(receipt => receipt.payloadDigest !== payloadDigest || receipt.event !== event)) {
    return reply(409, { status: 'conflict' });
  }

  if (event !== 'push') {
    const control = controlQuery(event, payload);
    if (control === 'invalid') return reply(400, { status: 'invalid_payload' });
    if (control === 'ignored') return reply(prior.length || priorControls.length
      ? 200 : 202, { status: prior.length || priorControls.length ? 'duplicate' : 'ignored' });
    let matches: Catalog[];
    try { matches = await db.collection<Catalog>('catalogs').find(control.filter)
      .sort({ _id: 1 }).limit(LIMITS.maxCatalogs).toArray(); }
    catch { return reply(503, { status: 'unavailable' }); }
    if (!matches.length) return priorControls.length
      ? reply(200, { status: 'duplicate', jobs: priorControls.map(receipt => receipt._id) })
      : reply(202, { status: 'ignored' });

    const accepted: string[] = [];
    let duplicates = 0;
    for (const catalog of matches) {
      const repositoryId = control.event === 'installation' ? catalog.github.repositoryId : control.repositoryId ?? catalog.github.repositoryId;
      const installationId = control.installationId ?? catalog.github.installationId;
      const jobId = newGitHubJobId(config.githubAppId, deliveryId.data, catalog._id);
      try {
        const blocked = await blockCatalogForAccessLoss(db, { catalogId: catalog._id, installationId, repositoryId });
        if (blocked === 'unavailable') return reply(503, { status: 'unavailable' });
        if (blocked === 'missing') continue;
        const outcome = await admitControlReceipt(db, { _id: jobId, catalogId: catalog._id, installationId, repositoryId,
          event, action: control.action, payloadDigest, completedAt: new Date() });
        accepted.push(outcome.receipt._id);
        if (outcome.duplicate) duplicates++;
      } catch (error) {
        if (error instanceof Error && error.message === 'sync_replay_conflict') return reply(409, { status: 'conflict' });
        return reply(503, { status: 'unavailable' });
      }
    }
    if (!accepted.length && priorControls.length) return reply(200, { status: 'duplicate', jobs: priorControls.map(receipt => receipt._id) });
    if (!accepted.length) return reply(202, { status: 'ignored' });
    if (accepted.length && duplicates === accepted.length) return reply(200, { status: 'duplicate', jobs: accepted });
    return reply(202, { status: 'accepted', jobs: accepted });
  }

  const parsed = pushPayload.safeParse(payload);
  if (!parsed.success) return reply(400, { status: 'invalid_payload' });
  const { installation, repository, ref } = parsed.data;
  if (!/^refs\/heads\/.+/.test(ref)) return reply(202, { status: 'ignored' });
  let catalogs: Catalog[];
  try {
    catalogs = await db.collection<Catalog>('catalogs').find({
      enabled: true, accessState: 'ready', 'github.installationId': installation.id,
      'github.repositoryId': repository.id,
    }).sort({ _id: 1 }).toArray();
  } catch { return reply(503, { status: 'unavailable' }); }
  catalogs = catalogs.filter(catalog => ref === `refs/heads/${catalog.github.branch}` &&
    repository.full_name.toLowerCase() === `${catalog.github.owner}/${catalog.github.name}`.toLowerCase());
  if (catalogs.length === 0) {
    return prior.length ? reply(200, { status: 'duplicate', jobs: prior.map(job => job._id) }) : reply(202, { status: 'ignored' });
  }

  const accepted: string[] = [];
  let duplicateCount = 0;
  for (const catalog of catalogs) {
    try {
      const outcome = await admitSyncJob(db, {
        _id: newGitHubJobId(config.githubAppId, deliveryId.data, catalog._id),
        catalogId: catalog._id, origin: 'github', event, payloadDigest,
      });
      accepted.push(outcome.job._id);
      if (outcome.duplicate) duplicateCount++;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'sync_replay_conflict') return reply(409, { status: 'conflict' });
      if (code === 'sync_rate_limited') return reply(429, { status: 'rate_limited' });
      return reply(503, { status: 'unavailable' });
    }
  }
  if (duplicateCount === catalogs.length) return reply(200, { status: 'duplicate', jobs: accepted });
  return reply(202, { status: 'accepted', jobs: accepted });
  }); } catch { return reply(503, { status: 'unavailable' }); }
}
