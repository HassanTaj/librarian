import { getMongo } from '@/lib/mongo';
import { checkRuntimeHealth } from '@/lib/operations/health';
import { readInstanceHost } from '@/lib/instance/bootstrap';
import { readInstance, cleanupInstanceState, drainInstanceAudit } from '@/lib/instance/store';
import { startConfiguredWorker } from '@/lib/sync/worker-startup';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET() {
  try {
    if (process.env.INSTANCE_STATE_FILE || process.env.INSTANCE_ID) await startConfiguredWorker('nodejs');
    const { db, contentRoot } = await getMongo();
    if (!contentRoot) throw new Error('runtime_not_ready');
    let instance;
    if (process.env.INSTANCE_STATE_FILE || process.env.INSTANCE_ID) {
      const host = await readInstanceHost();
      const control = await readInstance(db, host.instanceId);
      if (!control || control.lifecycle !== 'ready' || control.gate.state !== 'open' || !control.active || !control.initializedAt ||
          !control.bootstrap.consumedAt || host.marker.phase !== 'initialized') throw new Error('runtime_not_adopted');
      instance = { instanceId: host.instanceId, activeVersion: control.active.version,
        securityEpoch: control.securityEpoch, recoveryEpoch: control.recoveryEpoch };
      await cleanupInstanceState(db, host.instanceId);
      if (control.auditOutbox.length) await drainInstanceAudit(db, host.instanceId);
    }
    const storage = await checkRuntimeHealth(db, contentRoot, instance);
    const ready = storage.status === 'ok';
    return Response.json({ status: ready ? 'ok' : 'not_ready' }, {
      status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ status: 'not_ready' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
