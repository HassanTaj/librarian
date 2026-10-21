import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { classifyInstance, issueBootstrapCredential, verifyBootstrapCredential } from '../../lib/instance/bootstrap';
import { instanceControl } from '../fixtures/instance';

it('preserves validated legacy and requires explicit prepared host intent for a fresh database', () => {
  const record = instanceControl();
  const marker = { instanceId: record.instanceId, phase: 'prepared', recoveryEpoch: record.recoveryEpoch };
  expect(classifyInstance({ marker: null, record: null, legacyValid: true, empty: false })).toBe('legacy');
  expect(classifyInstance({ marker, record: null, legacyValid: false, empty: true })).toBe('prepared');
  expect(classifyInstance({ marker: null, record: null, legacyValid: false, empty: true })).toBe('maintenance');
  expect(classifyInstance({ marker, record: null, legacyValid: false, empty: false })).toBe('maintenance');
});

it('fails closed on sealed missing records, identity/epoch mismatch and initialized record loss', () => {
  const record = instanceControl();
  const marker = { instanceId: record.instanceId, phase: 'sealed', recoveryEpoch: record.recoveryEpoch };
  expect(classifyInstance({ marker, record: null, legacyValid: true, empty: true })).toBe('maintenance');
  expect(classifyInstance({ marker, record, legacyValid: false, empty: false })).toBe('configuring');
  for (const changed of [{ ...marker, instanceId: randomUUID() }, { ...marker, recoveryEpoch: 2 }, { ...marker, phase: 'initialized' }]) {
    expect(classifyInstance({ marker: changed, record, legacyValid: true, empty: false })).toBe('maintenance');
  }
  expect(classifyInstance({ marker: { ...marker, phase: 'initialized' }, record: null, legacyValid: true, empty: true })).toBe('maintenance');
});

it('uses current-time bootstrap expiry and fails closed on malformed host intent', () => {
  const record = instanceControl(); const issued = issueBootstrapCredential(record.instanceId, 1);
  record.bootstrap.verifierHash = issued.verifierHash; record.bootstrap.expiresAt = issued.expiresAt;
  expect(verifyBootstrapCredential(record, issued.credential)).toBe(true);
  expect(classifyInstance({ marker: { instanceId: 'invalid' }, record, legacyValid: true, empty: true })).toBe('maintenance');
});
