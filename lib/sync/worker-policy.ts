export function shouldStartSyncWorker(env: NodeJS.ProcessEnv = process.env) {
  if (env.NEXT_RUNTIME !== 'nodejs' || env.NEXT_PHASE === 'phase-production-build') return false;
  return env.NODE_ENV === 'production' ? env.LIBRARIAN_WORKER_ENABLED !== '0' : env.LIBRARIAN_WORKER_ENABLED === '1';
}
