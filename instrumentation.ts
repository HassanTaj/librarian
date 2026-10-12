export { shouldStartSyncWorker } from './lib/sync/worker-policy';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startConfiguredWorker } = await import('./lib/sync/worker-startup');
    await startConfiguredWorker(process.env.NEXT_RUNTIME);
  }
}
