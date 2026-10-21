import { randomUUID } from 'node:crypto';
import { encryptInstanceSecret } from '../../lib/instance/secrets';
import type { InstanceControl } from '../../lib/instance/store';

export function instanceControl(instanceId: string = randomUUID(), now = new Date()): InstanceControl {
  return {
    _id: 'instance', instanceId, schemaVersion: 1, revision: 0, editRevision: 0, nextBundleVersion: 1,
    lifecycle: 'configuring', createdAt: now, updatedAt: now, initializedAt: null,
    bootstrap: { epoch: 1, verifierHash: 'a'.repeat(64), expiresAt: new Date(now.getTime() + 86_400_000), consumedAt: null, sessionSlots: [] },
    securityEpoch: 1, recoveryEpoch: 1, active: null, previous: null, candidate: null,
    administrators: [], gate: { state: 'open', activationId: null, deadline: null },
    admissions: [], activation: null, auditOutbox: [], migration: null,
  };
}

export function readyInstance(instanceId: string = randomUUID(), now = new Date()): InstanceControl {
  const control = instanceControl(instanceId, now);
  const keyring = { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } };
  const secret = (purpose: 'zitadelClientSecret' | 'githubPrivateKey' | 'githubWebhookSecret') => encryptInstanceSecret('synthetic', { instanceId, purpose, credentialVersion: randomUUID() }, keyring, now);
  return {
    ...control, nextBundleVersion: 2, lifecycle: 'ready', initializedAt: now, bootstrap: { ...control.bootstrap, consumedAt: now },
    active: {
      version: 1, createdAt: now, createdBy: 'synthetic-owner', preferences: { displayName: 'Synthetic', description: '', docsFolder: 'docs' },
      publicOrigin: 'https://portal.example.test', zitadel: { issuer: 'https://identity.example.test', clientId: 'client', projectId: 'project', audience: 'audience' },
      github: { provider: 'github', appId: '123' }, secrets: { zitadelClientSecret: secret('zitadelClientSecret'), githubPrivateKey: secret('githubPrivateKey'), githubWebhookSecret: secret('githubWebhookSecret'), previousWebhook: null },
      checks: [], ownerProof: null, impact: null, previousUntil: null,
    },
    administrators: [{ bindingId: randomUUID(), issuer: 'https://identity.example.test', subject: 'synthetic-owner', projectId: 'project', kind: 'owner', status: 'active', boundAt: now, boundByActionId: randomUUID() }],
  };
}
