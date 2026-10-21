import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';
import { readInstance, updateInstance, type StoredInstanceControl } from '../../lib/instance/store';

it('activates and restarts with an owner-managed connection and webhook URL, rejecting a different database', async () => {
  const harness = await createInstanceHarness({ port: 3286 });
  try {
    const owner = await seedReadyInstance(harness);
    const originalUri = (await readFile(harness.env.MONGODB_URI_FILE, 'utf8')).trim();
    const changedUri = originalUri + (originalUri.includes('?') ? '&' : '?') + 'appName=synthetic-settings-update';
    harness.env.INSTANCE_DATABASE_FILE = join(dirname(harness.env.INSTANCE_STATE_FILE), 'instance-database.json');
    await writeFile(harness.env.INSTANCE_DATABASE_FILE, JSON.stringify({ mongodbUri: originalUri, mongodbDatabase: harness.env.MONGODB_DATABASE }), { mode: 0o600 });
    let server = await harness.start();
    const candidateSession = await fetch(`${server.origin}/api/instance/auth/session`);
    expect(candidateSession.status).toBe(200);
    expect(candidateSession.headers.get('cache-control')).toBe('private, no-store');
    expect(await candidateSession.json()).toBeNull();
    const patch = (body: unknown, revision: number) => fetch(`${server.origin}/api/instance/settings`, {
      method: 'PATCH', headers: owner.headers({ 'Content-Type': 'application/json', 'If-Match': `"${revision}"` }), body: JSON.stringify(body),
    });
    const saved = await patch({ candidateVersion: 0, changes: { database: { mongodbUri: changedUri, mongodbDatabase: harness.env.MONGODB_DATABASE },
      github: { webhookUrl: 'https://hooks.example.test/github/events' } } }, 0);
    expect(saved.status, JSON.stringify((await saved.clone().json()).error)).toBe(200);
    const draft = await saved.json();
    expect(JSON.stringify(draft)).not.toContain(changedUri);
    expect(draft.candidate.github.webhookUrl).toBe('https://hooks.example.test/github/events');
    const checked = await fetch(`${server.origin}/api/instance/settings/check`, { method: 'POST',
      headers: owner.headers({ 'Content-Type': 'application/json', 'If-Match': saved.headers.get('etag')! }),
      body: JSON.stringify({ candidateVersion: draft.candidateVersion, type: 'database' }),
    });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ status: 'passed', code: 'database_ok' });
    expect(await harness.storage.db.collection('instance_check_leases').countDocuments({})).toBe(0);
    const current = (await readInstance(harness.storage.db, harness.instanceId))!;
    // Synthetic provider results isolate this test to the connection/activation protocol.
    const now = new Date();
    const verified = await updateInstance(harness.storage.db, harness.instanceId, current.revision, control => ({ ...control, candidate: { ...control.candidate!,
      checks: (['database', 'zitadel_discovery', 'github_structure', 'github_authentication', 'github_permissions', 'github_installation', 'github_webhook'] as const).map(type => ({
        type, candidateVersion: draft.candidateVersion, at: now, status: 'passed' as const, code: type === 'database' ? 'database_ok' : 'provider_ok',
      })),
    } }), now);
    const active = await fetch(`${server.origin}/api/instance/settings/activate`, { method: 'POST',
      headers: owner.headers({ 'Content-Type': 'application/json', 'If-Match': `"${verified.editRevision}"` }),
      body: JSON.stringify({ candidateVersion: draft.candidateVersion, confirmationNonce: draft.impact.confirmationNonce, confirm: true }),
    });
    // This harness deliberately disables the worker, so activation reports pending runtime health.
    expect(active.status, JSON.stringify(await active.clone().json())).toBe(202);
    expect(await active.json()).toMatchObject({ state: 'ready', status: 'pending', activeVersion: draft.candidateVersion, candidate: null });
    expect(JSON.parse(await readFile(harness.env.INSTANCE_DATABASE_FILE, 'utf8'))).toEqual({ mongodbUri: changedUri, mongodbDatabase: harness.env.MONGODB_DATABASE });
    const stored = await harness.storage.db.collection<StoredInstanceControl>('instance_configuration').findOne({ _id: 'instance' });
    expect(stored?.active).toHaveProperty('configuration.ciphertext');
    expect(JSON.stringify(stored)).not.toContain(changedUri);
    expect(JSON.stringify(stored)).not.toContain('https://hooks.example.test/github/events');
    server = await harness.restart();
    const refreshed = await fetch(`${server.origin}/api/instance/settings`, { headers: owner.headers() });
    expect(refreshed.status).toBe(200);
    const settings = await refreshed.json();
    expect(settings).toMatchObject({ activeVersion: draft.candidateVersion, webhookUrl: 'https://hooks.example.test/github/events' });
    expect(settings.active.publicOrigin).toBe(owner.control.active!.publicOrigin);
    const unrelatedName = harness.env.MONGODB_DATABASE + '_unrelated';
    const unrelatedUri = originalUri.replace(harness.env.MONGODB_DATABASE, unrelatedName);
    const rejectedDraft = await patch({ candidateVersion: 0, changes: { database: { mongodbUri: unrelatedUri, mongodbDatabase: unrelatedName } } }, settings.editRevision);
    expect(rejectedDraft.status).toBe(200);
    const nextDraft = await rejectedDraft.json();
    const mismatch = await fetch(`${server.origin}/api/instance/settings/check`, { method: 'POST',
      headers: owner.headers({ 'Content-Type': 'application/json', 'If-Match': rejectedDraft.headers.get('etag')! }),
      body: JSON.stringify({ candidateVersion: nextDraft.candidateVersion, type: 'database' }),
    });
    expect(mismatch.status).toBe(409);
    expect((await readInstance(harness.storage.db, harness.instanceId))!.active!.version).toBe(draft.candidateVersion);
    expect(JSON.parse(await readFile(harness.env.INSTANCE_DATABASE_FILE, 'utf8')).mongodbUri).toBe(changedUri);
  } finally { await harness.close(); }
});

it('configures the first database from setup without any Mongo or application-secret environment inputs', async () => {
  const harness = await createInstanceHarness({ port: 3287 });
  try {
    const uri = (await readFile(harness.env.MONGODB_URI_FILE, 'utf8')).trim();
    const database = harness.env.MONGODB_DATABASE;
    const operator = JSON.parse(await readFile(harness.env.INSTANCE_OPERATOR_AUTH_FILE, 'utf8'));
    harness.env.INSTANCE_SETUP_ORIGIN = 'https://initial-setup.example.test';
    harness.env.INSTANCE_OUTBOUND_POLICY_FILE = '';
    harness.env.INSTANCE_DATABASE_FILE = join(dirname(harness.env.INSTANCE_STATE_FILE), 'instance-database.json');
    for (const key of ['MONGODB_URI_FILE', 'MONGODB_DATABASE', 'AUTH_SECRET_FILE', 'OAUTH_TOKEN_ENCRYPTION_KEY_FILE']) delete (harness.env as NodeJS.ProcessEnv)[key];
    const server = await harness.start();
    const initial = await fetch(`${server.origin}/instance/setup`);
    expect(initial.status).toBe(200);
    expect(await initial.text()).toContain('database-setup-title');
    const configure = () => fetch(`${server.origin}/api/instance/database`, { method: 'POST',
      headers: { Origin: harness.env.INSTANCE_SETUP_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: operator.credential, mongodbUri: uri, mongodbDatabase: database }),
    });
    const response = await configure();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'configured', nextUrl: '/instance/setup' });
    expect(JSON.parse(await readFile(harness.env.INSTANCE_DATABASE_FILE, 'utf8'))).toEqual({ mongodbUri: uri, mongodbDatabase: database });
    expect(JSON.parse(await readFile(harness.env.INSTANCE_STATE_FILE, 'utf8')).phase).toBe('sealed');
    expect(await readInstance(harness.storage.db, harness.instanceId)).toMatchObject({ lifecycle: 'configuring', active: null, candidate: null });
    expect((await configure()).status).toBe(409);
    const next = await fetch(`${server.origin}/instance/setup`);
    const html = await next.text();
    expect(next.status).toBe(200);
    expect(html).not.toContain('id="database-setup-title"');
    expect(html).toContain('Configure the identity provider');
  } finally { await harness.close(); }
});
