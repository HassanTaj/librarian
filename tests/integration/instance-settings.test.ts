import { expect, it } from 'vitest';
import { issueSetupOwnerProof } from '../../lib/instance/access';
import { readInstance, updateInstance, type StoredInstanceControl } from '../../lib/instance/store';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';
import { catalogs } from '../fixtures/catalogs';
import { CatalogSchema, type Catalog } from '../../lib/catalog';

it('atomically persists canonical encrypted drafts, rejects stale/invalid edits, and survives a real Next restart', async () => {
  const harness = await createInstanceHarness({ port: 3212 });
  try {
    const catalog = CatalogSchema.parse(catalogs[0]);
    await harness.storage.db.collection<Catalog>('catalogs').insertOne(catalog);
    const fixture = await seedReadyInstance(harness); let server = await harness.start();
    const get = async () => {
      const response = await fetch(`${server.origin}/api/instance/settings`, { headers: fixture.headers() });
      const body = await response.text(); expect(response.status, body).toBe(200); return { response, snapshot: JSON.parse(body) };
    };
    const initial = await get();
    expect(initial.snapshot.active.secrets).toMatchObject({ zitadelClientSecret: { configured: true }, githubPrivateKey: { configured: true }, githubWebhookSecret: { configured: true } });
    expect(JSON.stringify(initial.snapshot)).not.toMatch(/ciphertext|SYNTHETIC_(?:CLIENT|WEBHOOK)_SENTINEL/);
    const patch = (body: string, etag = initial.response.headers.get('etag')!) => fetch(`${server.origin}/api/instance/settings`, {
      method: 'PATCH', headers: fixture.headers({ 'Content-Type': 'application/json', 'If-Match': etag }), body,
    });
    const candidates = await Promise.all(['First administrator', 'Second administrator'].map(displayName => patch(JSON.stringify({ candidateVersion: 0, changes: { displayName } }))));
    expect(candidates.map(response => response.status).sort()).toEqual([200, 409]);
    const committed = await candidates.find(response => response.status === 200)!.json();
    expect(committed.active.preferences.displayName).toBe('Synthetic');
    expect(committed.activeVersion).toBe(1); expect(committed.candidateVersion).toBe(2);
    expect((await patch(JSON.stringify({ candidateVersion: 0, changes: { displayName: 'Stale replacement' } }))).status).toBe(409);
    const current = await get();
    for (const body of [
      JSON.stringify({ candidateVersion: 2, changes: { renderer: 'unsafe' } }),
      JSON.stringify({ candidateVersion: 2, changes: { defaultDocsFolder: '../escape' } }),
      JSON.stringify({ candidateVersion: 2, changes: { displayName: 'Atomic rejection', defaultDocsFolder: '../escape' } }),
      JSON.stringify({ candidateVersion: 2, changes: {}, secretReplacements: { githubWebhookSecret: { action: 'replace', value: '' } } }),
      JSON.stringify({ candidateVersion: 2, changes: {}, secretReplacements: { githubWebhookSecret: { action: 'clear' } } }),
      JSON.stringify({ candidateVersion: 2, changes: {}, secretReplacements: { githubWebhookSecret: null } }),
      '{"candidateVersion":2,"candidateVersion":3,"changes":{"displayName":"ambiguous"}}',
    ]) expect((await patch(body, current.response.headers.get('etag')!)).status).toBe(400);
    const rejected = await get();
    expect(rejected.snapshot.candidate.preferences.displayName).toBe(committed.candidate.preferences.displayName);
    const replaced = await patch(JSON.stringify({ candidateVersion: 2, changes: {}, secretReplacements: {
      githubWebhookSecret: { action: 'replace', value: 'REPLACEMENT_PROVIDER_SENTINEL'.repeat(2) },
    } }), current.response.headers.get('etag')!);
    expect(replaced.status).toBe(200);
    const safe = await replaced.text(); expect(safe).not.toContain('REPLACEMENT_PROVIDER_SENTINEL');
    expect(safe).not.toContain('ciphertext'); expect(safe).not.toContain('SYNTHETIC_CLIENT_SENTINEL');
    const stored = await harness.storage.db.collection<StoredInstanceControl>('instance_configuration').findOne({});
    expect(JSON.stringify(stored)).not.toContain('REPLACEMENT_PROVIDER_SENTINEL');
    expect(stored?.candidate?.configuration.algorithm).toBe('aes-256-gcm');
    const logicalStored = await readInstance(harness.storage.db, harness.instanceId);
    expect(logicalStored?.candidate?.createdBy).toBe(fixture.control.administrators[0].bindingId);
    expect(logicalStored?.active?.secrets.githubWebhookSecret).toEqual(fixture.control.active?.secrets.githubWebhookSecret);
    expect(stored?.active?.version).toBe(1); expect(stored?.candidate?.version).toBe(3);
    server = await harness.restart();
    const persisted = await get(); expect(persisted.snapshot.candidateVersion).toBe(3);
    expect(persisted.snapshot.candidate.preferences.displayName).toBe(committed.candidate.preferences.displayName);
    expect(persisted.snapshot.activeVersion).toBe(1);
    const audit = await fetch(`${server.origin}/api/instance/audit?limit=1`, { headers: fixture.headers() });
    expect(audit.status).toBe(200); const first = await audit.json(); expect(first.events).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const next = await fetch(`${server.origin}/api/instance/audit?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, { headers: fixture.headers() });
    expect(next.status).toBe(200); expect((await next.json()).events[0].id).not.toBe(first.events[0].id);
    for (const query of ['limit=0', 'limit=51', 'limit=1&limit=2', 'cursor=forged', 'unexpected=1']) {
      expect((await fetch(`${server.origin}/api/instance/audit?${query}`, { headers: fixture.headers() })).status).toBe(400);
    }
    expect(await harness.storage.db.collection<Catalog>('catalogs').findOne({ _id: catalog._id })).toEqual(catalog);
  } finally { await harness.close(); }
});

it('checks only the current Settings candidate and records owner login as unperformed without proof', async () => {
  const harness = await createInstanceHarness({ port: 3213 });
  try {
    const fixture = await seedReadyInstance(harness); const server = await harness.start();
    const created = await fetch(`${server.origin}/api/instance/settings`, {
      method: 'PATCH', headers: fixture.headers({ 'Content-Type': 'application/json', 'If-Match': '"0"' }),
      body: JSON.stringify({ candidateVersion: 0, changes: { displayName: 'Settings check candidate' } }),
    });
    expect(created.status).toBe(200);
    const candidateVersion = (await created.json()).candidateVersion as number;
    const check = (type: string, version = candidateVersion, etag = created.headers.get('etag')!) => fetch(`${server.origin}/api/instance/settings/check`, {
      method: 'POST', headers: fixture.headers({ 'Content-Type': 'application/json', 'If-Match': etag }),
      body: JSON.stringify({ candidateVersion: version, type }),
    });

    expect((await check('database', candidateVersion, '"0"')).status).toBe(409);
    expect((await check('database', candidateVersion - 1)).status).toBe(409);
    expect((await check('unknown')).status).toBe(400);
    const database = await check('database');
    expect(database.status).toBe(200);
    expect(database.headers.get('cache-control')).toContain('no-store');
    expect(await database.json()).toMatchObject({ type: 'database', candidateVersion, status: 'passed', code: 'database_ok' });

    const ownerLogin = await check('zitadel_owner_login');
    expect(ownerLogin.status).toBe(200);
    expect(await ownerLogin.json()).toMatchObject({ type: 'zitadel_owner_login', candidateVersion, status: 'not_run', code: 'not_run' });
    const webhook = await check('github_webhook');
    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toMatchObject({ type: 'github_webhook', candidateVersion, status: 'warning', code: 'delivery_unverified' });
    const persisted = await readInstance(harness.storage.db, harness.instanceId);
    expect(persisted?.active?.version).toBe(1);
    expect(persisted?.candidate?.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'database', candidateVersion, status: 'passed', code: 'database_ok' }),
      expect.objectContaining({ type: 'zitadel_owner_login', candidateVersion, status: 'not_run', code: 'not_run' }),
    ]));
  } finally { await harness.close(); }
});

it('records a current owner-login check only when candidate proof and its passed result are fresh', async () => {
  const harness = await createInstanceHarness({ port: 3232 });
  try {
    const fixture = await seedReadyInstance(harness); const server = await harness.start();
    const created = await fetch(`${server.origin}/api/instance/settings`, {
      method: 'PATCH', headers: fixture.headers({ 'Content-Type': 'application/json', 'If-Match': '"0"' }),
      body: JSON.stringify({ candidateVersion: 0, changes: { displayName: 'Proven owner check' } }),
    });
    expect(created.status).toBe(200);
    const current = (await readInstance(harness.storage.db, harness.instanceId))!;
    const candidate = structuredClone(current.candidate!);
    const at = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
    candidate.ownerProof = issueSetupOwnerProof({ ...current, candidate }, fixture.identity, at);
    candidate.checks.push({ type: 'zitadel_owner_login', candidateVersion: candidate.version,
      status: 'passed', code: 'provider_ok', at });
    const updated = await updateInstance(harness.storage.db, harness.instanceId, current.revision,
      control => ({ ...control, candidate }), at);
    const verified = await fetch(`${server.origin}/api/instance/settings/check`, {
      method: 'POST', headers: fixture.headers({ 'Content-Type': 'application/json', 'If-Match': `"${updated.editRevision}"` }),
      body: JSON.stringify({ candidateVersion: candidate.version, type: 'zitadel_owner_login' }),
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ type: 'zitadel_owner_login', candidateVersion: candidate.version,
      status: 'passed', code: 'provider_ok' });
  } finally { await harness.close(); }
});

it('decrypts configured key material for a structural check without exposing it', async () => {
  const harness = await createInstanceHarness({ port: 3216 });
  try {
    const fixture = await seedReadyInstance(harness); const server = await harness.start();
    const created = await fetch(`${server.origin}/api/instance/settings`, { method: 'PATCH', headers: fixture.headers({
      'Content-Type': 'application/json', 'If-Match': '"0"',
    }), body: JSON.stringify({ candidateVersion: 0, changes: { displayName: 'Provider check candidate' } }) });
    expect(created.status).toBe(200);
    const candidateVersion = (await created.json()).candidateVersion as number;
    const provider = await fetch(`${server.origin}/api/instance/settings/check`, { method: 'POST', headers: fixture.headers({
      'Content-Type': 'application/json', 'If-Match': created.headers.get('etag')!,
    }), body: JSON.stringify({ candidateVersion, type: 'github_structure' }) });
    expect(provider.status).toBe(200);
    const result = await provider.text();
    expect(result).toContain('"status":"passed"');
    expect(result).toContain('"code":"provider_ok"');
    expect(result).not.toContain('SYNTHETIC_CLIENT_SENTINEL');
    expect(result).not.toContain('SYNTHETIC_WEBHOOK_SENTINEL');
  } finally { await harness.close(); }
});
