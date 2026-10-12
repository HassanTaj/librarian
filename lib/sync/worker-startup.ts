import { loadConfig } from '../config';
import { getMongo } from '../mongo';
import { shouldStartSyncWorker } from './worker-policy';
import { markSyncWorkerUnavailable, startSyncWorker } from './worker';

let stopWorker: (() => Promise<void>) | undefined;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

async function stop() {
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  signalHandlers.clear();
  const shutdown = stopWorker;
  stopWorker = undefined;
  if (shutdown) await shutdown();
}

function installSignal(signal: NodeJS.Signals) {
  const handler = () => {
    void stop().finally(() => {
      try { process.kill(process.pid, signal); } catch { /* The server may already have exited. */ }
    });
  };
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

export async function startConfiguredWorker(runtime = process.env.NEXT_RUNTIME) {
  if (!shouldStartSyncWorker({ ...process.env, NEXT_RUNTIME: runtime }) || stopWorker) return;
  try {
    const config = await loadConfig();
    const { db } = await getMongo(config);
    const handle = startSyncWorker({ db, contentRoot: config.contentRoot,
      publicCatalogApprovalsFile: config.publicCatalogApprovalsFile,
      github: { githubAppId: config.githubAppId, githubPrivateKey: config.githubPrivateKey } });
    stopWorker = handle.stop;
    installSignal('SIGTERM'); installSignal('SIGINT');
  } catch {
    markSyncWorkerUnavailable();
  }
}

export async function stopConfiguredWorker() { await stop(); }
