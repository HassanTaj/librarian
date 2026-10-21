import { expect, it } from 'vitest';
import { instanceOperationEvent, operationError, operationEvent } from '../../lib/operations/logging';

it('returns only bounded known operational errors and drops private provider details', () => {
  expect(operationError(new Error('invalid_content'))).toEqual({ code: 'invalid_content', message: 'Documentation validation failed.' });
  for (const error of [new Error('SYNTHETIC_PRIVATE_BODY /outside/path token=synthetic'), { code: 'invalid_content', body: 'synthetic' }, null]) {
    expect(operationError(error)).toEqual({ code: 'operation_failed', message: 'The operation could not be completed.' });
  }
});

it('retains valid diagnostic identities and omits tokens, bodies, physical paths and invalid context', () => {
  const catalogId = '00000000-0000-4000-8000-000000000001';
  const generationId = '00000000-0000-4000-8000-000000000002';
  const deliveryId = '00000000-0000-4000-8000-000000000003';
  const jobId = `github:123:${deliveryId}:${catalogId}`;
  expect(operationEvent(new Error('invalid_content'), { catalogId, generationId, deliveryId, jobId, fence: 2, token: 'synthetic', body: 'SYNTHETIC_PRIVATE_BODY', path: '/outside' })).toEqual({ code: 'invalid_content', message: 'Documentation validation failed.', catalogId, generationId, deliveryId, jobId, fence: 2 });
  expect(operationEvent(new Error('unknown'), { catalogId: '/outside', jobId: 'private body', fence: -1, generationId: 4, deliveryId: null })).toEqual(operationError(null));
  expect(operationEvent(null, null)).toEqual(operationError(null));
});

it('logs only allowlisted instance audit identifiers and bounded outcomes', () => {
  const instanceId = '00000000-0000-4000-8000-000000000004';
  const requestId = '00000000-0000-4000-8000-000000000005';
  expect(instanceOperationEvent(new Error('instance_conflict'), {
    instanceId, requestId, operation: 'candidate_saved', resultCode: 'revision_conflict', fromVersion: 2, toVersion: null, editRevision: 4,
    actor: 'synthetic-user@example.test', secret: 'SYNTHETIC_SECRET', ciphertext: 'SYNTHETIC_CIPHERTEXT', path: 'C:\\private', providerBody: 'SYNTHETIC_BODY',
  })).toEqual({ code: 'operation_failed', message: 'The operation could not be completed.', instanceId, requestId, operation: 'candidate_saved', resultCode: 'revision_conflict', fromVersion: 2, toVersion: null, editRevision: 4 });
  expect(instanceOperationEvent(null, { instanceId: 'private', operation: 'unknown', resultCode: 'SYNTHETIC_SECRET', requestId: 'private' })).toEqual(operationError(null));
  expect(instanceOperationEvent(null, null)).toEqual(operationError(null));
});
