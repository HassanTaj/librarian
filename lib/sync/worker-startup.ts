import { loadConfig } from '../config';
import { getMongo } from '../mongo';
import { shouldStartSyncWorker } from './worker-policy';
import { markSyncWorkerUnavailable, startSyncWorker } from './worker';
import { reconcileInitialAdoption, reconcileInstanceActivation } from '../instance/activation';
import { readInstanceHost } from '../instance/bootstrap';
import { readInstance } from '../instance/store';

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
  if (runtime !== 'nodejs') return;
  try {
    await reconcileInitialAdoption();
    await reconcileInstanceActivation();
    if (stopWorker) return;
    const config = await loadConfig();
    if (!shouldStartSyncWorker({ ...process.env, LIBRARIAN_WORKER_ENABLED: config.workerEnabled ? '1' : '0', NEXT_RUNTIME: runtime })) return;
    const { db } = await getMongo(config);
    let instance;
    if (process.env.INSTANCE_STATE_FILE || process.env.INSTANCE_ID) {
      const host = await readInstanceHost();
      const control = await readInstance(db, host.instanceId);
      if (control?.migration && !control.initializedAt) {
        instance = undefined;
      } else {
        if (!control || control.lifecycle !== 'ready' || control.gate.state !== 'open' || !control.active || host.marker.phase !== 'initialized') throw new Error('instance_not_adopted');
        instance = { instanceId: host.instanceId, activeVersion: control.active.version,
        securityEpoch: control.securityEpoch, recoveryEpoch: control.recoveryEpoch };
      }
    }
    const handle = startSyncWorker({ db, contentRoot: config.contentRoot,
      publicCatalogApprovalsFile: config.publicCatalogApprovalsFile,
      github: { githubAppId: config.githubAppId, githubPrivateKey: config.githubPrivateKey }, instance });
    stopWorker = handle.stop;
    installSignal('SIGTERM'); installSignal('SIGINT');
  } catch {
    if (shouldStartSyncWorker({ ...process.env, NEXT_RUNTIME: runtime })) markSyncWorkerUnavailable();
  }
}

export async function stopConfiguredWorker() { await stop(); }
