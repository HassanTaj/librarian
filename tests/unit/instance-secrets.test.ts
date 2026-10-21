import { expect, it } from 'vitest';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { encryptOAuthToken, decryptOAuthToken } from '../../lib/auth/tokens';
import { beginInstanceKeyRotation, decryptInstanceSecret, encryptInstanceSecret, rotateInstanceBundles, serializeInstanceKeyring, verifyInstanceBundles } from '../../lib/instance/secrets';
import { readyInstance } from '../fixtures/instance';

it('binds authenticated envelopes to instance, purpose, key and credential version without altering OAuth', () => {
  const keyring = { activeKeyId: 'root-1', keys: { 'root-1': randomBytes(32) } };
  const context = { instanceId: randomUUID(), purpose: 'zitadelClientSecret' as const, credentialVersion: randomUUID() };
  const plaintext = 'synthetic-provider-secret';
  const first = encryptInstanceSecret(plaintext, context, keyring);
  const second = encryptInstanceSecret(plaintext, context, keyring);
  expect(first.nonce).not.toBe(second.nonce);
  expect(Buffer.from(first.nonce, 'base64')).toHaveLength(12);
  expect(Buffer.from(first.tag, 'base64')).toHaveLength(16);
  expect(decryptInstanceSecret(first, context, keyring)).toBe(plaintext);
  const oauthKey = randomBytes(32);
  expect(decryptOAuthToken(encryptOAuthToken(plaintext, oauthKey), oauthKey)).toBe(plaintext);
  for (const patch of [{ instanceId: randomUUID() }, { purpose: 'githubPrivateKey' as const }, { credentialVersion: randomUUID() }]) {
    expect(() => decryptInstanceSecret(first, { ...context, ...patch }, keyring)).toThrow('instance_secret_invalid');
  }
  const changedCiphertext = Buffer.from(first.ciphertext, 'base64');
  changedCiphertext[0] ^= 1;
  expect(() => decryptInstanceSecret({ ...first, ciphertext: changedCiphertext.toString('base64') }, context, keyring)).toThrow('instance_secret_invalid');
  const changedTag = Buffer.from(first.tag, 'base64');
  changedTag[0] ^= 1;
  expect(() => decryptInstanceSecret({ ...first, tag: changedTag.toString('base64') }, context, keyring)).toThrow('instance_secret_invalid');
  expect(() => decryptInstanceSecret(first, context, { ...keyring, keys: { 'root-1': randomBytes(32) } })).toThrow('instance_secret_invalid');
  for (const patch of [{ formatVersion: 2 }, { algorithm: 'none' }, { keyId: 'missing' }, { nonce: first.nonce + '=' }, { tag: Buffer.alloc(16).toString('base64') }, { ciphertext: '!!!!' }, { extra: true }]) {
    expect(() => decryptInstanceSecret({ ...first, ...patch }, context, keyring)).toThrow('instance_secret_invalid');
  }
  expect(() => encryptInstanceSecret('', context, keyring)).toThrow('instance_secret_invalid');
});

it('enforces each credential size and rejects authenticated invalid UTF-8 before returning plaintext', () => {
  const key = randomBytes(32);
  const keyring = { activeKeyId: 'root-1', keys: { 'root-1': key } };
  const limits = { zitadelClientSecret: 4096, githubPrivateKey: 16384, githubWebhookSecret: 1024 } as const;
  for (const [purpose, max] of Object.entries(limits) as Array<[keyof typeof limits, number]>) {
    const context = { instanceId: randomUUID(), purpose, credentialVersion: randomUUID() };
    const accepted = encryptInstanceSecret('x'.repeat(max), context, keyring);
    expect(decryptInstanceSecret(accepted, context, keyring)).toHaveLength(max);
    expect(() => encryptInstanceSecret('x'.repeat(max + 1), context, keyring)).toThrow('instance_secret_invalid');

    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([1, context.instanceId, purpose, keyring.activeKeyId, context.credentialVersion])));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from([0xff])), cipher.final()]);
    const invalidUtf8 = { formatVersion: 1, algorithm: 'aes-256-gcm', keyId: keyring.activeKeyId, credentialVersion: context.credentialVersion,
      nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), updatedAt: new Date() };
    expect(() => decryptInstanceSecret(invalidUtf8, context, keyring)).toThrow('instance_secret_invalid');
  }
});

it('rotates every retained provider envelope while preserving old backup keys and resumable rotation metadata', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const control = readyInstance(undefined, now);
  const oldKeyring = { activeKeyId: 'synthetic-root', keys: { 'synthetic-root': Buffer.alloc(32, 1) } };
  const previous = structuredClone(control.active!);
  previous.previousUntil = new Date(now.getTime() + 60_000);
  const candidate = structuredClone(control.active!);
  control.previous = previous;
  control.candidate = candidate;
  control.active!.secrets.previousWebhook = {
    envelope: encryptInstanceSecret('synthetic-previous-webhook', {
      instanceId: control.instanceId, purpose: 'githubWebhookSecret', credentialVersion: randomUUID(),
    }, oldKeyring, now),
    acceptUntil: new Date(now.getTime() + 5 * 60_000),
  };

  const authKey = randomBytes(32);
  const oauthKey = randomBytes(32);
  const rotating = beginInstanceKeyRotation(oldKeyring, control.revision, [authKey, oauthKey], now);
  expect(rotating.activeKeyId).not.toBe(oldKeyring.activeKeyId);
  expect(rotating.keys[rotating.activeKeyId]).toHaveLength(32);
  expect(rotating.keys[rotating.activeKeyId].equals(authKey)).toBe(false);
  expect(rotating.keys[rotating.activeKeyId].equals(oauthKey)).toBe(false);
  expect(rotating.keys['synthetic-root']).toEqual(oldKeyring.keys['synthetic-root']);
  expect(rotating.rotation).toMatchObject({ baseRevision: control.revision, fromKeyId: oldKeyring.activeKeyId, toKeyId: rotating.activeKeyId, startedAt: now });
  expect(() => verifyInstanceBundles(control, rotating)).toThrow('instance_key_rotation_incomplete');

  const serialized = serializeInstanceKeyring(rotating);
  const reloaded = {
    activeKeyId: serialized.activeKeyId,
    keys: Object.fromEntries(Object.entries(serialized.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])),
    rotation: serialized.rotation,
  };
  expect(beginInstanceKeyRotation(reloaded, control.revision + 5, [authKey, oauthKey], now)).toBe(reloaded);
  expect(reloaded.rotation?.baseRevision).toBe(control.revision);

  const rotated = rotateInstanceBundles(control, reloaded, now);
  verifyInstanceBundles({ ...control, ...rotated }, reloaded);
  for (const bundle of [rotated.active, rotated.previous, rotated.candidate]) {
    expect(bundle).not.toBeNull();
    for (const purpose of ['zitadelClientSecret', 'githubPrivateKey', 'githubWebhookSecret'] as const) {
      const envelope = bundle!.secrets[purpose]!;
      expect(envelope.keyId).toBe(reloaded.activeKeyId);
      expect(decryptInstanceSecret(envelope, { instanceId: control.instanceId, purpose, credentialVersion: envelope.credentialVersion }, reloaded)).toBe('synthetic');
    }
  }
  const previousWebhook = rotated.active!.secrets.previousWebhook!.envelope;
  expect(decryptInstanceSecret(previousWebhook, { instanceId: control.instanceId, purpose: 'githubWebhookSecret', credentialVersion: previousWebhook.credentialVersion }, reloaded)).toBe('synthetic-previous-webhook');
  expect(Object.keys(reloaded.keys)).toHaveLength(2);
});

it('refuses key rotation when retaining another backup would exceed the host keyring bound', () => {
  const keys = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`root-${index}`, randomBytes(32)]));
  expect(() => beginInstanceKeyRotation({ activeKeyId: 'root-7', keys }, 1, [])).toThrow('instance_keyring_full');
});
