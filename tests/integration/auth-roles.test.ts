import { expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Db, MongoServerError } from 'mongodb';
import { ensureAuthIndexes } from '../../lib/auth/adapter';
import { getVerifiedRoles } from '../../lib/auth/roles';
import { LIMITS } from '../../lib/limits';
import { createStorageHarness } from './http-harness';

const active = (id: number, userId = 'subject', projectId = 'project', key = 'docs:manual:reader') => ({
  id: `auth-${id}`, user: { id: userId }, project: { id: projectId }, state: 'STATE_ACTIVE', roles: [{ key }],
});
const page = (authorizations: unknown[]) => new Response(JSON.stringify({ pagination: { totalResult: authorizations.length, appliedLimit: 100 }, authorizations }));
const identity = { issuer: 'https://identity.example', subject: 'subject', projectId: 'project' };

it('persists complete current roles and refreshes exactly at the 900-second deadline', async () => {
  const storage = await createStorageHarness();
  let now = 1_000_000;
  const call = vi.fn(async () => page([active(1), active(2, 'subject', 'project', 'librarian-admin')]));
  const token = vi.fn(async () => 'synthetic-access');
  try {
    await ensureAuthIndexes(storage.db);
    await expect(getVerifiedRoles(storage.db, identity, token, call, () => now)).resolves.toEqual(['docs:manual:reader', 'librarian-admin']);
    now += 899_999;
    await expect(getVerifiedRoles(storage.db, identity, token, call, () => now)).resolves.toHaveLength(2);
    expect(call).toHaveBeenCalledTimes(1);
    now += 1;
    call.mockImplementation(async () => page([]));
    await expect(getVerifiedRoles(storage.db, identity, token, call, () => now)).resolves.toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
    const state = await storage.db.collection('identity_authorizations').findOne({ issuer: identity.issuer, subject: identity.subject, projectId: identity.projectId });
    expect(state?.verifiedAt).toEqual(new Date(now));
  } finally { await storage.close(); }
});

it('coalesces concurrent role refreshes under the bounded lease', async () => {
  const storage = await createStorageHarness();
  try {
    await ensureAuthIndexes(storage.db);
    let begin!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { begin = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn(async () => { begin(); await gate; return page([active(1)]); });
    const first = getVerifiedRoles(storage.db, identity, async () => 'synthetic-access', fetcher);
    await entered;
    const second = getVerifiedRoles(storage.db, identity, async () => 'synthetic-access', fetcher);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toEqual(['docs:manual:reader']);
    const firstState = await storage.db.collection('identity_authorizations').findOne({ issuer: identity.issuer, subject: identity.subject, projectId: identity.projectId });
    expect(firstState?.verifiedAt).toBeInstanceOf(Date);
    expect(firstState?.leaseFence).toBe(1);
    await expect(second).resolves.toEqual(['docs:manual:reader']);
    const state = await storage.db.collection('identity_authorizations').findOne({ issuer: identity.issuer, subject: identity.subject, projectId: identity.projectId });
    expect({ calls: fetcher.mock.calls.length, leaseFence: state?.leaseFence, roles: state?.roles, verifiedAt: state?.verifiedAt, lease: state?.lease })
      .toMatchObject({ calls: 1, leaseFence: 1, roles: ['docs:manual:reader'], lease: null });
  } finally { await storage.close(); }
});

it('continues after a competing role-record upsert wins the unique key', async () => {
  const storage = await createStorageHarness();
  const _id = createHash('sha256').update(`${identity.issuer}\0${identity.subject}\0${identity.projectId}`).digest('hex');
  try {
    await ensureAuthIndexes(storage.db);
    const records = storage.db.collection<{ _id: string; issuer: string; subject: string; projectId: string; roles: string[];
      verifiedAt: Date | null; leaseFence: number; lease: { owner: string; fence: number; expiresAt: Date } | null }>('identity_authorizations');
    await records.insertOne({ _id, ...identity,
      roles: [], verifiedAt: null, leaseFence: 0, lease: null });

    const original = Db.prototype.collection;
    let injected = false;
    vi.spyOn(Db.prototype, 'collection').mockImplementation(function(this: Db, name, options) {
      const collection = original.call(this, name, options);
      if (name !== 'identity_authorizations' || injected) return collection;
      injected = true;
      return new Proxy(collection, {
        get(target, property) {
          if (property === 'updateOne') return async () => { throw new MongoServerError({ code: 11000, message: 'Synthetic concurrent upsert' }); };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });

    await expect(getVerifiedRoles(storage.db, identity, async () => 'synthetic-access', async () => page([active(1)])))
      .resolves.toEqual(['docs:manual:reader']);
    expect((await records.findOne({ _id }))?.lease).toBeNull();
  } finally { vi.restoreAllMocks(); await storage.close(); }
});

it('does not extend stale roles after provider failure and retries after the lease is released', async () => {
  const storage = await createStorageHarness();
  let now = 2_000_000;
  try {
    await ensureAuthIndexes(storage.db);
    await expect(getVerifiedRoles(storage.db, identity, async () => 'token', async () => page([active(1)]), () => now))
      .resolves.toEqual(['docs:manual:reader']);
    now += 900_000;
    await expect(getVerifiedRoles(storage.db, identity, async () => 'token', async () => new Response('{}', { status: 503 }), () => now))
      .rejects.toThrow('role_verification_failed');
    const afterFailure = await storage.db.collection('identity_authorizations').findOne({ issuer: identity.issuer, subject: identity.subject, projectId: identity.projectId });
    expect(afterFailure?.verifiedAt).toEqual(new Date(2_000_000));
    await expect(getVerifiedRoles(storage.db, identity, async () => 'token', async () => page([]), () => now)).resolves.toEqual([]);
  } finally { await storage.close(); }
});

it('uses the configured identity endpoint when the caller relies on the default fetch and clock', async () => {
  const storage = await createStorageHarness();
  try {
    await ensureAuthIndexes(storage.db);
    let requestedUrl: RequestInfo | URL | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => { requestedUrl = input; return page([active(1)]); });
    vi.stubGlobal('fetch', fetcher);
    await expect(getVerifiedRoles(storage.db, identity, async () => 'synthetic-access')).resolves.toEqual(['docs:manual:reader']);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(requestedUrl)).toBe(`${identity.issuer}/zitadel.authorization.v2.AuthorizationService/ListAuthorizations`);
  } finally { vi.unstubAllGlobals(); await storage.close(); }
});

it('denies corrupted identity records and a refresh lease that stays held past the bounded wait', async () => {
  const storage = await createStorageHarness();
  try {
    await ensureAuthIndexes(storage.db);
    const states = storage.db.collection<{ _id: string; issuer: string; subject: string; projectId: string; roles: string[];
      verifiedAt: Date | null; leaseFence: number; lease: unknown }>('identity_authorizations');
    const _id = createHash('sha256').update(`${identity.issuer}\0${identity.subject}\0${identity.projectId}`).digest('hex');
    await states.insertOne({ _id, ...identity, issuer: 'https://other-issuer.example',
      roles: ['librarian-admin'], verifiedAt: new Date(), leaseFence: 1, lease: null });
    await expect(getVerifiedRoles(storage.db, identity, async () => 'token', async () => page([])))
      .rejects.toThrow('role_verification_failed');

    const contended = { ...identity, subject: 'contended-subject' };
    const id = createHash('sha256').update(`${contended.issuer}\0${contended.subject}\0${contended.projectId}`).digest('hex');
    await states.insertOne({ _id: id, ...contended, roles: [], verifiedAt: null,
      leaseFence: 1, lease: { owner: randomUUID(), fence: 1, expiresAt: new Date(Date.now() + 60_000) } });
    const started = Date.now();
    await expect(getVerifiedRoles(storage.db, contended, async () => 'token', async () => page([])))
      .rejects.toThrow('role_verification_busy');
    expect(Date.now() - started).toBeGreaterThanOrEqual(LIMITS.roleContenderMs);
  } finally { await storage.close(); }
});
