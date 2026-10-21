import { expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInstanceHarness } from './instance-harness';

it('isolates instance identity and protected roots, persists across real Next restarts and closes its resources', async () => {
  const fixture = await createInstanceHarness({ port: 3192 });
  const { root, contentRoot, db } = fixture.storage;
  try {
    expect(fixture.instanceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(db.databaseName).toMatch(/^librarian_test_[a-f0-9]+$/);
    const marker = JSON.parse(await readFile(fixture.env.INSTANCE_STATE_FILE, 'utf8'));
    expect(marker).toMatchObject({ instanceId: fixture.instanceId, phase: 'prepared', recoveryEpoch: 1 });
    expect(fixture.env).not.toHaveProperty('AUTH_ZITADEL_SECRET_FILE');
    const keyring = JSON.parse(await readFile(fixture.env.INSTANCE_KEYRING_FILE, 'utf8'));
    expect(Buffer.from(keyring.keys[keyring.activeKeyId], 'base64')).toHaveLength(32);
    expect(await readFile(fixture.env.OAUTH_TOKEN_ENCRYPTION_KEY_FILE, 'utf8')).not.toBe(keyring.keys[keyring.activeKeyId]);
    for (const key of ['INSTANCE_STATE_FILE', 'INSTANCE_KEYRING_FILE', 'INSTANCE_OPERATOR_AUTH_FILE'] as const) {
      expect(fixture.env[key].startsWith(contentRoot)).toBe(false);
      if (process.platform !== 'win32') expect((await stat(fixture.env[key])).mode & 0o077).toBe(0);
    }
    await db.collection('instance_harness_probe').insertOne({ instanceId: fixture.instanceId });
    const discovery = await (await fetch(`${fixture.providers.origin}/.well-known/openid-configuration`)).json();
    expect(discovery.issuer).toBe(fixture.providers.origin);
    fixture.providers.state.github.set('/app', { status: 200, body: { id: 123, permissions: { contents: 'read' } } });
    expect(await (await fetch(`${fixture.providers.origin}/app`)).json()).toMatchObject({ permissions: { contents: 'read' } });
    const first = await fixture.start();
    expect((await fetch(first.origin)).status).toBe(200);
    const second = await fixture.restart();
    expect(second.process.pid).not.toBe(first.process.pid);
    expect((await fetch(second.origin)).status).toBe(200);
    expect(await db.collection('instance_harness_probe').countDocuments({ instanceId: fixture.instanceId })).toBe(1);
    expect(JSON.parse(await readFile(fixture.env.INSTANCE_STATE_FILE, 'utf8'))).toEqual(marker);
  } finally { await fixture.close(); }
  await expect(readFile(join(root, 'protected', 'marker.json'))).rejects.toThrow();
  await expect(fetch(fixture.providers.origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  await expect(fetch('http://127.0.0.1:3192', { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  await fixture.close();
});

it('refuses a shared Mongo URI before opening providers or creating instance files', async () => {
  await expect(createInstanceHarness({ port: 3192, mongoUri: 'mongodb://remote.example.test/librarian_dev' })).rejects.toThrow('Disposable loopback');
});
