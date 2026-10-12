import { describe, expect, it } from 'vitest';
import { SYNC_JOB_INDEXES, SyncJobSchema, newGitHubJobId, newManualJobId, type SyncJob } from '../../lib/sync/jobs';

const catalogId = '00000000-0000-4000-8000-000000000001';
const deliveryId = '00000000-0000-4000-8000-000000000010';
const manualKey = '00000000-0000-4000-8000-000000000011';
const digest = 'a'.repeat(64);
const date = new Date('2026-10-12T00:00:00.000Z');

function queued(overrides: Partial<SyncJob> = {}): SyncJob {
  return {
    _id: newManualJobId(catalogId, manualKey), catalogId, configRevision: 1, origin: 'manual', event: 'manual',
    payloadDigest: digest, admissionSequence: 1, state: 'queued', requestedAt: date, availableAt: date,
    attempts: 0, owner: null, fence: 0, targetCommit: null, generationId: null, result: null,
    completedAt: null, detailExpiresAt: null, ...overrides,
  };
}

describe('durable sync job records', () => {
  it('builds stable per-catalog receipt IDs for webhook and manual requests', () => {
    expect(newGitHubJobId(12345, deliveryId, catalogId)).toBe(`github:12345:${deliveryId}:${catalogId}`);
    expect(newManualJobId(catalogId, manualKey)).toBe(`manual:${catalogId}:${manualKey}`);
    expect(newGitHubJobId(12345, deliveryId.toUpperCase(), catalogId)).toBe(`github:12345:${deliveryId}:${catalogId}`);
    expect(() => newGitHubJobId('0', deliveryId, catalogId)).toThrow('sync_invalid_id');
    expect(() => newManualJobId(catalogId, 'not-a-uuid')).toThrow();
  });

  it('accepts a bounded queued job and an acknowledged terminal publication receipt', () => {
    expect(SyncJobSchema.parse(queued()).state).toBe('queued');
    const done = queued({ state: 'succeeded', attempts: 1, owner: null, fence: 1,
      generationId: '00000000-0000-4000-8000-000000000020',
      result: { kind: 'published', commitSha: 'b'.repeat(40) }, completedAt: date,
      detailExpiresAt: new Date(date.getTime() + 14 * 24 * 60 * 60 * 1000) });
    expect(SyncJobSchema.parse(done).result?.kind).toBe('published');
  });

  it.each([
    ['unbounded id', { _id: `manual:${catalogId}:${'x'.repeat(400)}` }],
    ['invalid catalog', { catalogId: '../outside' }],
    ['zero config revision', { configRevision: 0 }],
    ['bad digest', { payloadDigest: 'secret-token' }],
    ['negative sequence', { admissionSequence: -1 }],
    ['unknown state', { state: 'waiting' }],
    ['attempt overflow', { attempts: 6 }],
    ['raw body field', { body: '{"private":"must-not-persist"}' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => SyncJobSchema.parse({ ...queued(), ...overrides })).toThrow();
  });

  it('requires lease and terminal fields to agree with state', () => {
    expect(() => SyncJobSchema.parse(queued({ state: 'running' }))).toThrow();
    expect(() => SyncJobSchema.parse(queued({ state: 'succeeded', completedAt: date }))).toThrow();
    expect(() => SyncJobSchema.parse(queued({ state: 'failed', completedAt: date,
      result: { kind: 'failure', code: 'provider_unavailable' } }))).not.toThrow();
    expect(() => SyncJobSchema.parse(queued({ state: 'failed', completedAt: date,
      result: { kind: 'failure', code: 'provider unavailable, token=secret' } }))).toThrow();
  });

  it('declares scheduling, per-catalog, and terminal-compaction indexes without receipt TTL deletion', () => {
    expect(SYNC_JOB_INDEXES).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { state: 1, availableAt: 1, requestedAt: 1 } }),
      expect.objectContaining({ key: { catalogId: 1, state: 1 } }),
      expect.objectContaining({ key: { state: 1, detailExpiresAt: 1 } }),
    ]));
    expect(SYNC_JOB_INDEXES.some(index => 'expireAfterSeconds' in index)).toBe(false);
  });
});
