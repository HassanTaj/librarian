import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { BSON } from 'mongodb';
import { z } from 'zod';
import { InstanceBundleEnvelopeSchema, InstanceBundleSchema, InstanceCandidateSchema, InstanceEnvelopeSchema } from './store';
import { LIMITS } from '../limits';
import type { InstanceControl } from './store';

const contextSchema = z.strictObject({ instanceId: z.uuid(), purpose: z.enum(['zitadelClientSecret', 'githubPrivateKey', 'githubWebhookSecret']), credentialVersion: z.uuid() });
type SecretContext = z.infer<typeof contextSchema>;
export type InstanceKeyring = { activeKeyId: string; keys: Record<string, Buffer>; rotation?: { id: string; baseRevision: number; fromKeyId: string; toKeyId: string; startedAt: Date } };
const bundleContextSchema = z.strictObject({ instanceId: z.uuid(), bundleVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
type BundleContext = z.infer<typeof bundleContextSchema>;
const bundleSchema = z.union([InstanceBundleSchema, InstanceCandidateSchema]);

export function beginInstanceKeyRotation(keyring: InstanceKeyring, baseRevision: number, excludedKeys: readonly Buffer[], now = new Date()): InstanceKeyring {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !Number.isFinite(now.getTime())) throw new Error('instance_key_rotation_invalid');
  if (keyring.rotation) {
    if (keyring.rotation.toKeyId !== keyring.activeKeyId || keyring.rotation.fromKeyId === keyring.rotation.toKeyId ||
        !Object.hasOwn(keyring.keys, keyring.rotation.fromKeyId) || !Object.hasOwn(keyring.keys, keyring.rotation.toKeyId) ||
        !Number.isSafeInteger(keyring.rotation.baseRevision) || keyring.rotation.baseRevision < 0) throw new Error('instance_key_rotation_invalid');
    return keyring;
  }
  if (Object.keys(keyring.keys).length >= LIMITS.maxInstanceKeyringKeys) throw new Error('instance_keyring_full');
  const id = randomUUID();
  let key: Buffer;
  do { key = randomBytes(32); }
  while (Object.values(keyring.keys).some(existing => key.equals(existing)) || excludedKeys.some(existing => key.equals(existing)));
  return { activeKeyId: id, keys: { ...keyring.keys, [id]: key }, rotation: { id: randomUUID(), baseRevision, fromKeyId: keyring.activeKeyId, toKeyId: id, startedAt: now } };
}

export function serializeInstanceKeyring(keyring: InstanceKeyring, includeRotation = true) {
  return { activeKeyId: keyring.activeKeyId, keys: Object.fromEntries(Object.entries(keyring.keys).map(([id, key]) => [id, key.toString('base64')])),
    ...(includeRotation && keyring.rotation ? { rotation: keyring.rotation } : {}) };
}

export function verifyInstanceBundles(control: InstanceControl, keyring: InstanceKeyring) {
  for (const bundle of [control.active, control.previous, control.candidate]) {
    if (!bundle) continue;
    for (const purpose of ['zitadelClientSecret', 'githubPrivateKey', 'githubWebhookSecret'] as const) {
      const envelope = bundle.secrets[purpose];
      if (envelope) {
        if (envelope.keyId !== keyring.activeKeyId) throw new Error('instance_key_rotation_incomplete');
        decryptInstanceSecret(envelope, { instanceId: control.instanceId, purpose, credentialVersion: envelope.credentialVersion }, keyring);
      }
    }
    if (bundle.secrets.previousWebhook) {
      const { envelope } = bundle.secrets.previousWebhook;
      if (envelope.keyId !== keyring.activeKeyId) throw new Error('instance_key_rotation_incomplete');
      decryptInstanceSecret(envelope, { instanceId: control.instanceId, purpose: 'githubWebhookSecret', credentialVersion: envelope.credentialVersion }, keyring);
    }
  }
}

export function rotateInstanceBundles(control: InstanceControl, keyring: InstanceKeyring, now = new Date()) {
  const rotate = <T extends InstanceControl['active'] | InstanceControl['candidate']>(bundle: T): T => {
    if (!bundle) return bundle;
    const copy = structuredClone(bundle);
    for (const purpose of ['zitadelClientSecret', 'githubPrivateKey', 'githubWebhookSecret'] as const) {
      const envelope = copy.secrets[purpose];
      if (envelope) {
        const context = { instanceId: control.instanceId, purpose, credentialVersion: envelope.credentialVersion };
        const plaintext = decryptInstanceSecret(envelope, context, keyring);
        if (envelope.keyId !== keyring.activeKeyId) copy.secrets[purpose] = encryptInstanceSecret(plaintext, context, keyring, now);
      }
    }
    if (copy.secrets.previousWebhook) {
      const { envelope } = copy.secrets.previousWebhook;
      const context = { instanceId: control.instanceId, purpose: 'githubWebhookSecret' as const, credentialVersion: envelope.credentialVersion };
      const plaintext = decryptInstanceSecret(envelope, context, keyring);
      if (envelope.keyId !== keyring.activeKeyId) copy.secrets.previousWebhook.envelope = encryptInstanceSecret(plaintext, context, keyring, now);
    }
    return copy as T;
  };
  const bundles = { active: rotate(control.active), previous: rotate(control.previous), candidate: rotate(control.candidate) };
  verifyInstanceBundles({ ...control, ...bundles }, keyring);
  return bundles;
}
const bounds = { zitadelClientSecret: LIMITS.maxInstanceClientSecretBytes, githubPrivateKey: LIMITS.maxInstanceAppKeyBytes, githubWebhookSecret: LIMITS.maxInstanceWebhookSecretBytes };

function keyFor(keyring: InstanceKeyring, keyId: string) {
  if (!Object.hasOwn(keyring.keys, keyId) || keyring.keys[keyId].length !== 32) throw new Error('instance_secret_invalid');
  return keyring.keys[keyId];
}
function aad(context: SecretContext, keyId: string) {
  const parsed = contextSchema.parse(context);
  return Buffer.from(JSON.stringify([1, parsed.instanceId, parsed.purpose, keyId, parsed.credentialVersion]));
}

function bundleAad(context: BundleContext, keyId: string) {
  const parsed = bundleContextSchema.parse(context);
  return Buffer.from(JSON.stringify([2, parsed.instanceId, 'configuration_bundle', keyId, parsed.bundleVersion]));
}

export function encryptInstanceBundle(value: unknown, context: BundleContext, keyring: InstanceKeyring, now = new Date()) {
  try {
    const bundle = bundleSchema.parse(value);
    const parsed = bundleContextSchema.parse(context);
    if (bundle.version !== parsed.bundleVersion || !Number.isFinite(now.getTime())) throw new Error();
    const associated = bundleAad(parsed, keyring.activeKeyId);
    const plaintext = Buffer.from(BSON.EJSON.stringify(bundle));
    if (!plaintext.length || plaintext.length > 128 * 1024) throw new Error();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyFor(keyring, keyring.activeKeyId), nonce);
    cipher.setAAD(associated);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return InstanceBundleEnvelopeSchema.parse({ formatVersion: 2, algorithm: 'aes-256-gcm', keyId: keyring.activeKeyId, bundleVersion: parsed.bundleVersion,
      nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), updatedAt: now });
  } catch { throw new Error('instance_secret_invalid'); }
}

export function decryptInstanceBundle(value: unknown, context: BundleContext, keyring: InstanceKeyring) {
  try {
    const envelope = InstanceBundleEnvelopeSchema.parse(value);
    const parsed = bundleContextSchema.parse(context);
    if (envelope.bundleVersion !== parsed.bundleVersion) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', keyFor(keyring, envelope.keyId), Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(bundleAad(parsed, envelope.keyId));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    if (!plaintext.length || plaintext.length > 128 * 1024) throw new Error();
    const bundle = bundleSchema.parse(BSON.EJSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
    if (bundle.version !== parsed.bundleVersion) throw new Error();
    return bundle;
  } catch { throw new Error('instance_secret_invalid'); }
}

export function encryptInstanceSecret(value: string, context: SecretContext, keyring: InstanceKeyring, now = new Date()) {
  try {
    const associated = aad(context, keyring.activeKeyId);
    if (!value || Buffer.byteLength(value) > bounds[context.purpose]) throw new Error();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyFor(keyring, keyring.activeKeyId), nonce);
    cipher.setAAD(associated);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return InstanceEnvelopeSchema.parse({ formatVersion: 1, algorithm: 'aes-256-gcm', keyId: keyring.activeKeyId, credentialVersion: context.credentialVersion,
      nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), updatedAt: now });
  } catch { throw new Error('instance_secret_invalid'); }
}

export function decryptInstanceSecret(value: unknown, context: SecretContext, keyring: InstanceKeyring) {
  try {
    const envelope = InstanceEnvelopeSchema.parse(value);
    if (envelope.credentialVersion !== context.credentialVersion) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', keyFor(keyring, envelope.keyId), Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(aad(context, envelope.keyId));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    if (!plaintext.length || plaintext.length > bounds[context.purpose]) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch { throw new Error('instance_secret_invalid'); }
}
