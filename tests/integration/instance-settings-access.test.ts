import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createInstanceHarness, seedReadyInstance } from './instance-harness';
import type { InstanceControl } from '../../lib/instance/store';
import { catalogs } from '../fixtures/catalogs';
import { CatalogSchema, type Catalog } from '../../lib/catalog';

it('enforces real session, binding, independent role, CSRF and epoch guards on every Settings delivery path', async () => {
  const harness = await createInstanceHarness({ port: 3211 });
  try {
    const fixture = await seedReadyInstance(harness);
    const server = await harness.start();
    const call = (path: string, init?: RequestInit) => fetch(`${server.origin}${path}`, init);
    for (const path of ['/api/instance/settings', '/api/instance/audit']) {
      const denied = await call(path); const body = await denied.text(); expect(denied.status, body).toBe(401);
      expect(denied.headers.get('Cache-Control')).toBe('private, no-store');
      expect(body).not.toMatch(/SYNTHETIC_(?:CLIENT|WEBHOOK)_SENTINEL/);
    }
    for (const path of ['', '/check', '/activate', '/rollback']) {
      const denied = await call(`/api/instance/settings${path}`, { method: path ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(denied.status, await denied.text()).toBe(401);
    }
    const page = await call('/instance/settings'); expect(await page.text()).not.toContain('Save draft');
    const session = await call('/api/auth/session', { headers: fixture.headers() });
    const sessionBody = await session.text();
    expect(JSON.parse(sessionBody), sessionBody).toMatchObject({ user: { id: fixture.userId.toHexString() } });
    const allowed = await call('/api/instance/settings', { headers: fixture.headers() });
    expect(allowed.status).toBe(200); expect((await allowed.json()).bindingKind).toBe('owner');
    expect((await call('/api/admin/repos', { headers: fixture.headers() })).status).toBe(403);
    await harness.storage.db.collection<Catalog>('catalogs').insertOne(CatalogSchema.parse(catalogs[1]));
    for (const path of ['/api/search/private-one?query=SYNTHETIC_PRIVATE_ONE_BODY', '/api/assets/private-one/docs/guide.md']) {
      const privateDelivery = await call(path, { headers: fixture.headers() }); const body = await privateDelivery.text();
      expect(privateDelivery.status).toBe(404); expect(body).not.toContain('SYNTHETIC_PRIVATE_ONE_BODY');
    }
    const records = harness.storage.db.collection<{ _id: string; issuer: string; subject: string; projectId: string; roles: string[]; verifiedAt: Date; leaseFence: number; lease: null }>('identity_authorizations');
    for (const roles of [[], ['librarian-admin'], ['docs:private-one:reader']]) {
      await records.updateOne(fixture.identity, { $set: { roles, verifiedAt: new Date() } });
      expect((await call('/api/instance/settings', { headers: fixture.headers() })).status).toBe(403);
    }
    await records.updateOne(fixture.identity, { $set: { roles: ['librarian-instance-admin'], verifiedAt: new Date() } });
    const controls = harness.storage.db.collection<InstanceControl>('instance_configuration');
    await controls.updateOne({ _id: 'instance' }, { $set: { 'administrators.0.issuer': 'https://wrong-issuer.synthetic.invalid' } });
    expect((await call('/api/instance/settings', { headers: fixture.headers() })).status).toBe(403);
    await controls.updateOne({ _id: 'instance' }, { $set: { 'administrators.0.issuer': fixture.identity.issuer, 'administrators.0.projectId': 'wrong-project' } });
    expect((await call('/api/instance/settings', { headers: fixture.headers() })).status).toBe(403);
    await controls.updateOne({ _id: 'instance' }, { $set: { 'administrators.0.projectId': fixture.identity.projectId } });
    await controls.updateOne({ _id: 'instance' }, { $set: { 'administrators.0.subject': 'different-bound-owner' } });
    expect((await call('/api/instance/settings', { headers: fixture.headers() })).status).toBe(403);
    await controls.updateOne({ _id: 'instance' }, { $set: { 'administrators.0.subject': fixture.identity.subject } });

    const identityId = (subject: string) => createHash('sha256').update(`${fixture.identity.issuer}\0${subject}\0${fixture.identity.projectId}`).digest('hex');
    const accounts = harness.storage.db.collection('accounts');
    const roleOnlySubject = 'synthetic-role-only-admin';
    await accounts.updateOne({ userId: fixture.userId }, { $set: { providerAccountId: roleOnlySubject } });
    await records.insertOne({ _id: identityId(roleOnlySubject), ...fixture.identity, subject: roleOnlySubject,
      roles: ['librarian-instance-admin'], verifiedAt: new Date(), leaseFence: 0, lease: null });
    expect((await call('/api/instance/settings', { headers: fixture.headers() })).status).toBe(403);
    await accounts.updateOne({ userId: fixture.userId }, { $set: { providerAccountId: fixture.identity.subject } });
    await records.deleteOne({ _id: identityId(roleOnlySubject) });

    const adminSubject = 'synthetic-bound-admin';
    const adminBindingId = randomUUID();
    await accounts.updateOne({ userId: fixture.userId }, { $set: { providerAccountId: adminSubject } });
    await records.insertOne({ _id: identityId(adminSubject), ...fixture.identity, subject: adminSubject,
      roles: ['librarian-instance-admin'], verifiedAt: new Date(), leaseFence: 0, lease: null });
    await controls.updateOne({ _id: 'instance' }, { $push: { administrators: { bindingId: adminBindingId, ...fixture.identity,
      subject: adminSubject, kind: 'administrator', status: 'active', boundAt: fixture.control.updatedAt, boundByActionId: randomUUID() } } });
    const boundAdmin = await call('/api/instance/settings', { headers: fixture.headers() });
    const boundAdminBody = await boundAdmin.text();
    expect(boundAdmin.status, boundAdminBody).toBe(200); expect(JSON.parse(boundAdminBody).bindingKind).toBe('administrator');
    expect((await call('/api/admin/repos', { headers: fixture.headers() })).status).toBe(403);
    await controls.updateOne({ _id: 'instance' }, { $pull: { administrators: { bindingId: adminBindingId } } });
    await accounts.updateOne({ userId: fixture.userId }, { $set: { providerAccountId: fixture.identity.subject } });
    await records.deleteOne({ _id: identityId(adminSubject) });

    for (const headers of [fixture.headers({ origin: 'https://attacker.example.test' }), fixture.headers({ 'x-csrf-token': 'wrong' })]) {
      const denied = await call('/api/instance/settings', { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
      expect(denied.status).toBe(403);
    }
    await records.updateOne(fixture.identity, { $set: { verifiedAt: new Date(Date.now() - 900_000) } });
    expect((await call('/api/instance/settings', { headers: fixture.headers() })).status).toBe(503);
    await records.updateOne(fixture.identity, { $set: { verifiedAt: new Date() } });
    await harness.storage.db.collection('sessions').updateOne({ userId: fixture.userId }, { $set: { securityEpoch: 0 } });
    expect((await call('/api/instance/settings', { headers: fixture.headers() })).status).toBe(401);
  } finally { await harness.close(); }
});
