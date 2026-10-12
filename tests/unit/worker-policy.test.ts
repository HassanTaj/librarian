import { expect, it } from 'vitest';
import { shouldStartSyncWorker } from '../../lib/sync/worker-policy';

const env = (overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv => Object.assign({ NEXT_RUNTIME: 'nodejs', NODE_ENV: 'test' }, overrides);

it('starts workers only in the selected Node runtime and build/runtime phase', () => {
  expect(shouldStartSyncWorker(env({ NEXT_RUNTIME: 'edge', LIBRARIAN_WORKER_ENABLED: '1' }))).toBe(false);
  expect(shouldStartSyncWorker(env({ NEXT_RUNTIME: 'nodejs', NEXT_PHASE: 'phase-production-build', LIBRARIAN_WORKER_ENABLED: '1' }))).toBe(false);
  expect(shouldStartSyncWorker(env({ NEXT_RUNTIME: 'nodejs', LIBRARIAN_WORKER_ENABLED: '1' }))).toBe(true);
});

it('requires explicit development enablement and honors the production disable switch', () => {
  expect(shouldStartSyncWorker(env({ NEXT_RUNTIME: 'nodejs' }))).toBe(false);
  expect(shouldStartSyncWorker(env({ NEXT_RUNTIME: 'nodejs', LIBRARIAN_WORKER_ENABLED: '1' }))).toBe(true);
  expect(shouldStartSyncWorker(env({ NEXT_RUNTIME: 'nodejs', NODE_ENV: 'production' }))).toBe(true);
  expect(shouldStartSyncWorker(env({ NEXT_RUNTIME: 'nodejs', NODE_ENV: 'production', LIBRARIAN_WORKER_ENABLED: '0' }))).toBe(false);
});
