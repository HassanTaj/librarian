import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Db } from 'mongodb';
import { hasHealthySyncWorker, type InstanceWorkerAuthority } from '../sync/worker';

export async function checkHealth(db: Db, contentRoot: string) {
  try {
    const [, directory] = await Promise.all([
      db.command({ ping: 1 }, { timeoutMS: 5000 }), stat(contentRoot), access(contentRoot, constants.R_OK | constants.W_OK),
    ]);
    if (!directory.isDirectory()) throw new Error();
    return { status: 'ok' as const };
  } catch { return { status: 'unavailable' as const }; }
}

export async function checkRuntimeHealth(db: Db, contentRoot: string, instance?: InstanceWorkerAuthority) {
  const storage = await checkHealth(db, contentRoot);
  if (storage.status !== 'ok' || !await hasHealthySyncWorker(db, instance)) return { status: 'unavailable' as const };
  return storage;
}
