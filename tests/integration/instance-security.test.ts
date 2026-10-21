import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';
import { readInstance } from '../../lib/instance/store';

it('keeps host authority, encrypted provider values, paths, and private content out of instance responses and audit records', async () => {
  const harness = await createInstanceHarness({ port: 3223 });
  try {
    const fixture = await seedReadyInstance(harness);
    const server = await harness.start();
    const active = (await readInstance(harness.storage.db, harness.instanceId))!.active!;
    const replacement = 'SYNTHETIC_PROVIDER_RESPONSE_SENTINEL'.repeat(2);
    const saved = await fetch(`${server.origin}/api/instance/settings`, { method: 'PATCH', headers: fixture.headers({
      'Content-Type': 'application/json', 'If-Match': '"0"',
    }), body: JSON.stringify({ candidateVersion: 0, changes: { displayName: 'Synthetic security scan' }, secretReplacements: {
      githubWebhookSecret: { action: 'replace', value: replacement },
    } }) });
    expect(saved.status).toBe(200);

    const badCheck = await fetch(`${server.origin}/api/instance/settings/check`, { method: 'POST', headers: fixture.headers({
      'Content-Type': 'application/json', 'If-Match': saved.headers.get('etag')!,
    }), body: JSON.stringify({ candidateVersion: 2, type: 'SYNTHETIC_PROVIDER_BODY /private/path' }) });
    expect(badCheck.status).toBe(400);

    const responses = await Promise.all([
      fetch(`${server.origin}/api/instance/status`),
      fetch(`${server.origin}/api/instance/settings`, { headers: fixture.headers() }),
      fetch(`${server.origin}/api/instance/audit?limit=20`, { headers: fixture.headers() }),
      fetch(`${server.origin}/instance/settings`),
      badCheck,
      saved,
    ]);
    const bodies = await Promise.all(responses.map(response => response.text()));
    const control = await readInstance(harness.storage.db, harness.instanceId);
    const audit = await harness.storage.db.collection('instance_audit_events').find({ instanceId: harness.instanceId }).toArray();
    const rootSecret = await readFile(harness.env.AUTH_SECRET_FILE, 'utf8');
    const oauthKey = await readFile(harness.env.OAUTH_TOKEN_ENCRYPTION_KEY_FILE, 'utf8');
    const encodedKeyring = await readFile(harness.env.INSTANCE_KEYRING_FILE, 'utf8');
    const secretValues = [
      rootSecret, oauthKey, ...Object.values(JSON.parse(encodedKeyring).keys as Record<string, string>),
      'SYNTHETIC_CLIENT_SENTINEL', 'SYNTHETIC_WEBHOOK_SENTINEL'.repeat(2), harness.providers.privateKey,
      replacement, 'SYNTHETIC_PROVIDER_BODY', 'SYNTHETIC_PRIVATE_BODY', 'ciphertext', harness.env.INSTANCE_STATE_FILE,
      harness.env.INSTANCE_KEYRING_FILE, harness.env.MONGODB_URI_FILE, harness.storage.contentRoot,
    ];
    for (const body of bodies) for (const sentinel of secretValues) expect(body).not.toContain(sentinel);
    expect(JSON.stringify(control?.auditOutbox)).not.toContain(replacement);
    expect(JSON.stringify(audit)).not.toContain(replacement);
    expect(JSON.stringify(control?.active?.secrets)).not.toContain('SYNTHETIC_CLIENT_SENTINEL');
    expect(JSON.stringify(control?.candidate?.secrets)).not.toContain(replacement);
    expect(control?.active?.secrets).toEqual(active.secrets);
    expect(control?.candidate?.secrets.githubWebhookSecret?.ciphertext).toBeTruthy();
  } finally { await harness.close(); }
});
