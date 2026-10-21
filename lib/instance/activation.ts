import { checkInstanceDatabase, writeInstanceDatabase } from './database';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Db } from 'mongodb';
import { LIMITS } from '../limits';
import { checkHealth } from '../operations/health';
import { ensureAuthIndexes } from '../auth/adapter';
import { ensureCatalogStorage } from '../catalog';
import { ensureSyncJobStorage } from '../sync/jobs';
import { connectMongo } from '../mongo';
import { readInstanceHost } from './bootstrap';
import { decryptInstanceSecret } from './secrets';
import { InstanceBundleSchema, readInstance, updateInstance, type InstanceControl } from './store';
import { createGitHubClient } from '../sync/github';
import { CatalogSchema, type Catalog } from '../catalog';

export async function beginInstanceActivation(db: Db, instanceId: string, editRevision: number, candidateVersion: number,
  confirmationNonce: string, bindingId: string, now = new Date()) {
  const current = await readInstance(db, instanceId);
  const candidate = current?.candidate;
  const binding = current?.administrators.find(item => item.bindingId === bindingId && item.status === 'active');
  if (!current?.active || current.lifecycle !== 'ready' || current.gate.state !== 'open' || !candidate || !binding ||
      current.editRevision !== editRevision || candidate.version !== candidateVersion || candidate.impact?.confirmationNonce !== confirmationNonce) throw new Error('instance_conflict');
  if (candidate.createdBy !== bindingId || candidate.createdAt > now || now.getTime() - candidate.createdAt.getTime() >= LIMITS.instanceProofMs) throw new Error('instance_conflict');
  if (current.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox) throw new Error('instance_unavailable');
  const active = InstanceBundleSchema.parse(candidate);
  if (candidate.impact?.categories.includes('database')) {
    if (binding.kind !== 'owner' || !candidate.runtime) throw new Error('instance_forbidden');
    await checkInstanceDatabase(candidate.runtime, current, (await readInstanceHost()).keyring, db);
  }
  for (const type of requiredChecks.filter(type => type !== 'zitadel_owner_login')) {
    const result = candidate.checks.find(item => item.type === type);
    if (!result || result.candidateVersion !== candidateVersion || result.at > now || now.getTime() - result.at.getTime() >= LIMITS.instanceProofMs ||
        (result.status !== 'passed' && !(type === 'github_webhook' && result.status === 'warning' && result.code === 'delivery_unverified') &&
          !(type === 'github_installation' && result.status === 'warning' && result.code === 'installation_missing'))) throw new Error('instance_setup_incomplete');
  }
  if (candidate.impact.categories.includes('identity') || candidate.impact.categories.includes('origin')) {
    const proof = candidate.ownerProof;
    if (binding.kind !== 'owner' || !proof || proof.instanceId !== instanceId || proof.candidateVersion !== candidateVersion ||
        proof.securityEpoch !== current.securityEpoch || proof.expiresAt <= now || proof.issuer !== candidate.zitadel.issuer || proof.projectId !== candidate.zitadel.projectId) throw new Error('instance_owner_continuity_required');
  }
  const id = randomUUID();
  const deadline = new Date(now.getTime() + LIMITS.instanceActivationMs);
  return updateInstance(db, instanceId, current.revision, control => ({ ...control,
    gate: { state: 'closing', activationId: id, deadline },
    activation: { id, from: current.active!.version, to: active.version, phase: 'draining', actor: bindingId, deadline, fencedCatalogIds: [], result: null },
  }), now);
}

export async function reconcileInstanceActivation(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  let storage: Awaited<ReturnType<typeof connectMongo>> | undefined;
  try {
    const host = await readInstanceHost(env, cwd);
    storage = await connectMongo(host.config, { initializeLegacy: false });
    const db = storage.db;
    let current = await readInstance(db, host.instanceId);
    const initial = current?.activation;
    if (!current || !initial || initial.actor === 'bootstrap') return false;
    const now = new Date();
    if (initial.deadline <= now) {
      if (current.gate.state !== 'maintenance' || current.lifecycle !== 'maintenance') await updateInstance(db, host.instanceId, current.revision,
        value => ({ ...value, lifecycle: 'maintenance', gate: { ...value.gate, state: 'maintenance' }, activation: { ...initial, phase: 'maintenance', result: 'activation_timeout' } }), now,
        { allowFullAuditOutbox: true });
      return false;
    }
    if (initial.phase === 'draining') {
      // An expired pin may still have filesystem work in progress; timeout stays in maintenance.
      if (current.admissions.length) return false;
      current = await updateInstance(db, host.instanceId, current.revision, value => ({ ...value,
        gate: { ...value.gate, state: 'maintenance' }, activation: { ...initial, phase: 'fencing' } }), undefined, { allowFullAuditOutbox: true });
    }
    if (current.activation?.phase === 'fencing') {
      const candidate = InstanceBundleSchema.parse(current.candidate);
      const catalogs = await db.collection<Catalog>('catalogs').find({}).limit(21).toArray();
      if (catalogs.length > 20) throw new Error('instance_unavailable');
      const key = decryptInstanceSecret(candidate.secrets.githubPrivateKey, { instanceId: host.instanceId, purpose: 'githubPrivateKey', credentialVersion: candidate.secrets.githubPrivateKey.credentialVersion }, host.keyring);
      const provider = createGitHubClient({ githubAppId: candidate.github.appId, githubPrivateKey: key });
      for (const raw of catalogs) {
        const catalog = CatalogSchema.parse(raw);
        current = await readInstance(db, host.instanceId);
        if (!current || current.activation?.id !== initial.id || current.activation.phase !== 'fencing' || current.activation.deadline <= new Date()) throw new Error('instance_conflict');
        if (candidate.impact?.revalidateSources) {
          const repository = await provider.verifyRepository(catalog.github);
          if (repository.repositoryId !== catalog.github.repositoryId) throw new Error('instance_setup_incomplete');
        }
        const fenced = await db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id, instanceActivationId: { $ne: initial.id }, leaseFence: { $lt: Number.MAX_SAFE_INTEGER } },
          { $set: { instanceRuntimeRevision: candidate.version, instanceActivationId: initial.id, lease: null }, $inc: { leaseFence: 1 } }, { writeConcern: { w: 1, j: true } });
        if (!fenced.matchedCount && !await db.collection<Catalog>('catalogs').findOne({ _id: catalog._id, instanceActivationId: initial.id, instanceRuntimeRevision: candidate.version })) throw new Error('instance_conflict');
        current = await readInstance(db, host.instanceId);
        if (!current || current.activation?.id !== initial.id || current.activation.phase !== 'fencing') throw new Error('instance_conflict');
        if (!current.activation.fencedCatalogIds.includes(catalog._id)) current = await updateInstance(db, host.instanceId, current.revision, value => ({ ...value,
          activation: { ...value.activation!, fencedCatalogIds: [...value.activation!.fencedCatalogIds, catalog._id] } }), undefined, { allowFullAuditOutbox: true });
      }
      current = await readInstance(db, host.instanceId);
      if (!current?.active || current.activation?.id !== initial.id || current.activation.phase !== 'fencing' || current.candidate?.version !== candidate.version || current.activation.deadline <= new Date()) throw new Error('instance_conflict');
      const at = new Date();
      const previous = { ...current.active, previousUntil: new Date(at.getTime() + 24 * 3600_000) };
      const webhookChanged = candidate.secrets.githubWebhookSecret.credentialVersion !== current.active.secrets.githubWebhookSecret.credentialVersion;
      candidate.secrets.previousWebhook = webhookChanged ? { envelope: current.active.secrets.githubWebhookSecret, acceptUntil: new Date(at.getTime() + 5 * 60_000) } : current.active.secrets.previousWebhook;
      const identityChanged = candidate.impact?.securityEpochIncrement;
      const proof = candidate.ownerProof;
      let administrators = current.administrators;
      if (identityChanged) {
        if (!proof || proof.expiresAt <= at) throw new Error('instance_owner_continuity_required');
        administrators = current.administrators.map(item => item.status === 'active' ? { ...item, status: 'retired' as const } : item);
        administrators.push({ bindingId: randomUUID(), issuer: proof.issuer, subject: proof.subject, projectId: proof.projectId, kind: 'owner', status: 'active', boundAt: at, boundByActionId: initial.id });
      }
      current = await updateInstance(db, host.instanceId, current.revision, value => ({ ...value, lifecycle: 'maintenance',
        active: candidate, previous, candidate: null, administrators,
        securityEpoch: value.securityEpoch + (identityChanged ? 1 : 0),
        activation: { ...value.activation!, phase: 'adopting' },
        auditOutbox: [...value.auditOutbox, { _id: randomUUID(), instanceId: host.instanceId, at, actor: initial.actor, operation: 'activated',
          fromVersion: previous.version, toVersion: candidate.version, resultCode: 'pending_adoption', requestId: initial.id }],
      }), at, { allowFullAuditOutbox: true });
    }
    if (current.activation?.phase === 'adopting') {
      const active = InstanceBundleSchema.parse(current.active);
      for (const purpose of ['zitadelClientSecret', 'githubPrivateKey', 'githubWebhookSecret'] as const) {
        const envelope = active.secrets[purpose];
        decryptInstanceSecret(envelope, { instanceId: host.instanceId, purpose, credentialVersion: envelope.credentialVersion }, host.keyring);
      }
      if ((await checkHealth(db, host.config.contentRoot)).status !== 'ok' || host.marker.phase !== 'initialized' || current.admissions.length) return false;
      if (current.activation.deadline <= new Date()) return false;
      if (active.runtime && (active.runtime.mongodbUri !== host.config.mongodbUri || active.runtime.mongodbDatabase !== host.config.mongodbDatabase)) {
        await checkInstanceDatabase(active.runtime, current, host.keyring, storage.db);
        await writeInstanceDatabase(active.runtime);
      }
      await updateInstance(db, host.instanceId, current.revision, value => ({ ...value, lifecycle: 'ready',
        gate: { state: 'open', activationId: null, deadline: null }, activation: null,
        auditOutbox: value.auditOutbox.map(event => event.requestId === initial.id ? { ...event, resultCode: 'accepted' } : event),
      }), undefined, { allowFullAuditOutbox: true });
      return true;
    }
    return false;
  } catch { return false; }
  finally { await storage?.client.close(); }
}

const requiredChecks = ['database', 'zitadel_discovery', 'zitadel_owner_login', 'github_structure', 'github_authentication', 'github_permissions',
  'github_installation', 'github_webhook'] as const;

export async function commitInitialInstance(db: Db, instanceId: string, revision: number, candidateVersion: number, confirmationNonce: string, now = new Date()) {
  let current = await readInstance(db, instanceId);
  const candidate = current?.candidate;
  if (!current || current.revision !== revision || !candidate || candidate.version !== candidateVersion || candidate.impact?.confirmationNonce !== confirmationNonce ||
      current.lifecycle !== 'awaiting_owner' || current.active || current.initializedAt || current.bootstrap.consumedAt || now >= current.bootstrap.expiresAt) throw new Error('instance_conflict');
  if (!Number.isFinite(now.getTime()) || now < current.updatedAt || current.auditOutbox.length >= LIMITS.maxInstanceAuditOutbox ||
      now.getTime() - candidate.createdAt.getTime() >= LIMITS.instanceProofMs ||
      candidate.checks.some(result => result.candidateVersion !== candidate.version || result.at > now || now.getTime() - result.at.getTime() >= LIMITS.instanceProofMs)) {
    throw new Error('instance_setup_incomplete');
  }
  const proof = candidate.ownerProof;
  const ownerCheck = candidate.checks.find(result => result.type === 'zitadel_owner_login');
  if (!proof || !ownerCheck || ownerCheck.status !== 'passed' || ownerCheck.code !== 'provider_ok' || proof.instanceId !== instanceId ||
      proof.candidateVersion !== candidate.version || proof.issuer !== candidate.zitadel.issuer || proof.projectId !== candidate.zitadel.projectId ||
      proof.securityEpoch !== current.securityEpoch || proof.expiresAt <= now) throw new Error('instance_owner_continuity_required');
  for (const type of requiredChecks) {
    const result = candidate.checks.find(item => item.type === type && item.candidateVersion === candidate.version);
    if (!result || (result.status !== 'passed' && !(type === 'github_installation' && result.status === 'warning' && result.code === 'installation_missing') &&
        !(type === 'github_webhook' && result.status === 'warning' && result.code === 'delivery_unverified'))) throw new Error('instance_setup_incomplete');
  }
  let active;
  try { active = InstanceBundleSchema.parse(candidate); }
  catch { throw new Error('instance_setup_incomplete'); }
  if (current.migration) {
    if (!current.migration.verificationSummary.includes('legacy_drained')) throw new Error('instance_migration_conflict');
    if (current.gate.state === 'open') {
      const id = randomUUID();
      const deadline = new Date(now.getTime() + LIMITS.instanceActivationMs);
      return updateInstance(db, instanceId, current.revision, value => ({ ...value,
        gate: { state: 'closing', activationId: id, deadline },
        activation: { id, from: 0, to: active.version, phase: 'draining', actor: 'bootstrap', deadline, fencedCatalogIds: [], result: null },
      }), now);
    }
    const pending = current.activation;
    if (!pending || pending.actor !== 'bootstrap' || pending.to !== active.version || pending.deadline <= now || current.admissions.length) return current;
    const catalogs = await db.collection<Catalog>('catalogs').find({}).limit(21).toArray();
    if (catalogs.length > 20) throw new Error('instance_unavailable');
    for (const catalog of catalogs) {
      const fenced = await db.collection<Catalog>('catalogs').updateOne({ _id: catalog._id, instanceActivationId: { $ne: pending.id }, leaseFence: { $lt: Number.MAX_SAFE_INTEGER } },
        { $set: { instanceRuntimeRevision: active.version, instanceActivationId: pending.id, lease: null }, $inc: { leaseFence: 1 } }, { writeConcern: { w: 1, j: true } });
      if (!fenced.matchedCount && !await db.collection<Catalog>('catalogs').findOne({ _id: catalog._id, instanceActivationId: pending.id })) throw new Error('instance_conflict');
    }
    current = await readInstance(db, instanceId);
    if (!current || current.activation?.id !== pending.id || current.activation.deadline <= new Date() || current.admissions.length) throw new Error('instance_conflict');
    revision = current.revision;
  }
  if (candidate.impact.securityEpochIncrement && current.securityEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('instance_unavailable');
  const activationId = current.activation?.id ?? randomUUID();
  const actionId = randomUUID();
  const auditId = randomUUID();
  const deadline = current.activation?.deadline ?? new Date(now.getTime() + LIMITS.instanceActivationMs);
  return updateInstance(db, instanceId, revision, control => ({
    ...control,
    lifecycle: 'maintenance', initializedAt: now,
    bootstrap: { ...control.bootstrap, consumedAt: now, sessionSlots: [] },
    securityEpoch: control.securityEpoch + (candidate.impact!.securityEpochIncrement ? 1 : 0),
    active, previous: null, candidate: null,
    administrators: [{ bindingId: randomUUID(), issuer: proof.issuer, subject: proof.subject, projectId: proof.projectId, kind: 'owner', status: 'active', boundAt: now, boundByActionId: actionId }],
    gate: { state: 'maintenance', activationId, deadline },
    activation: { id: activationId, from: 0, to: active.version, phase: 'adopting', actor: 'bootstrap', deadline, fencedCatalogIds: [], result: null },
    auditOutbox: [...control.auditOutbox, { _id: auditId, instanceId, at: now, actor: 'bootstrap', operation: 'setup_finalized', fromVersion: null,
      toVersion: active.version, resultCode: 'pending_adoption', requestId: randomUUID() }],
  }), now);
}

export function initialFinalizeReplay(control: InstanceControl | null, candidateVersion: number, confirmationNonce: string) {
  return !!control && !!control.bootstrap.consumedAt && !!control.initializedAt && !!control.active &&
    ['maintenance', 'ready'].includes(control.lifecycle) && control.active.version === candidateVersion &&
    control.active.impact?.confirmationNonce === confirmationNonce;
}

async function setInitializedMarker(path: string, instanceId: string, recoveryEpoch: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('instance_host_unavailable');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ instanceId, phase: 'initialized', recoveryEpoch }), 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function adopted(control: InstanceControl) {
  return control.lifecycle === 'ready' && control.gate.state === 'open' && control.initializedAt !== null &&
    control.bootstrap.consumedAt !== null && control.activation === null;
}

export async function reconcileInitialAdoption(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), now = new Date()) {
  let storage: Awaited<ReturnType<typeof connectMongo>> | undefined;
  try {
    const host = await readInstanceHost(env, cwd, now);
    storage = await connectMongo(host.config, { initializeLegacy: false });
    const current = await readInstance(storage.db, host.instanceId);
    if (!current) return false;
    if (current.migration && !current.initializedAt && current.activation?.actor === 'bootstrap' && current.activation.phase === 'draining' && current.candidate?.impact) {
      await commitInitialInstance(storage.db, host.instanceId, current.revision, current.candidate.version, current.candidate.impact.confirmationNonce, now);
      const updated = await readInstance(storage.db, host.instanceId);
      if (!updated?.initializedAt) return false;
      await storage.client.close(); storage = undefined;
      return reconcileInitialAdoption(env, cwd, now);
    }
    if (adopted(current) && host.marker.phase === 'initialized') return true;
    const active = current.active && InstanceBundleSchema.safeParse(current.active);
    const activation = current.activation;
    const owner = current.administrators.filter(binding => binding.status === 'active' && binding.kind === 'owner');
    const proof = active?.success ? active.data.ownerProof : null;
    const required = ['database', 'zitadel_discovery', 'zitadel_owner_login', 'github_structure', 'github_authentication', 'github_permissions', 'github_installation', 'github_webhook'];
    if (!['sealed', 'initialized'].includes(host.marker.phase) || current.lifecycle !== 'maintenance' || current.gate.state !== 'maintenance' ||
        current.bootstrap.consumedAt === null || current.initializedAt === null || !active?.success || !activation || activation.phase !== 'adopting' ||
        activation.actor !== 'bootstrap' || activation.from !== 0 || activation.to !== active.data.version || activation.deadline <= now ||
        owner.length !== 1 || !proof || proof.instanceId !== host.instanceId || proof.issuer !== owner[0].issuer ||
        proof.subject !== owner[0].subject || proof.projectId !== owner[0].projectId || current.admissions.some(pin => pin.expiresAt > now) ||
        required.some(type => !active.data.checks.some(check => check.type === type && check.candidateVersion === active.data.version &&
          (check.status === 'passed' || type === 'github_installation' && check.status === 'warning' && check.code === 'installation_missing' ||
            type === 'github_webhook' && check.status === 'warning' && check.code === 'delivery_unverified')))) return false;

    const getSecret = (purpose: 'zitadelClientSecret' | 'githubPrivateKey' | 'githubWebhookSecret') => {
      const envelope = active.data.secrets[purpose];
      return decryptInstanceSecret(envelope, { instanceId: host.instanceId, purpose, credentialVersion: envelope.credentialVersion }, host.keyring);
    };
    const privateKey = createPrivateKey(getSecret('githubPrivateKey'));
    if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        !getSecret('zitadelClientSecret') || !getSecret('githubWebhookSecret')) return false;
    if (await checkHealth(storage.db, host.config.contentRoot).then(result => result.status !== 'ok')) return false;
    await Promise.all([ensureCatalogStorage(storage.db), ensureSyncJobStorage(storage.db), ensureAuthIndexes(storage.db)]);

    const markerPath = resolve(cwd, env.INSTANCE_STATE_FILE ?? '');
    if (host.marker.phase !== 'initialized') await setInitializedMarker(markerPath, host.instanceId, host.marker.recoveryEpoch);
    const committedAt = new Date(Math.max(now.getTime(), current.updatedAt.getTime()));
    await updateInstance(storage.db, host.instanceId, current.revision, latest => {
      if (latest.lifecycle !== 'maintenance' || latest.gate.state !== 'maintenance' || latest.activation?.id !== activation.id ||
          latest.active?.version !== active.data.version || latest.bootstrap.consumedAt === null) throw new Error('instance_conflict');
      return { ...latest, lifecycle: 'ready', gate: { state: 'open', activationId: null, deadline: null }, activation: null,
        auditOutbox: latest.auditOutbox.map(event => event.operation === 'setup_finalized' && event.resultCode === 'pending_adoption'
          ? { ...event, resultCode: 'accepted' } : event) };
    }, committedAt, { allowFullAuditOutbox: true });
    return true;
  } catch {
    return false;
  }
  finally { await storage?.client.close(); }
}
