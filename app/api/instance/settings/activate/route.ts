import { z } from 'zod';
import { requireInstanceAdmin, consumeInstanceRate, instanceErrorResponse, readInstanceJson } from '@/lib/instance/access';
import { beginInstanceActivation, reconcileInstanceActivation } from '@/lib/instance/activation';
import { instanceSnapshot, readInstance } from '@/lib/instance/store';
import { startConfiguredWorker } from '@/lib/sync/worker-startup';
import { checkRuntimeHealth } from '@/lib/operations/health';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
const inputSchema = z.strictObject({ candidateVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), confirmationNonce: z.uuid(), confirm: z.literal(true) });
export async function POST(request: Request) {
  try {
    const { db, host, control, binding } = await requireInstanceAdmin(request, true);
    await consumeInstanceRate(db, host.instanceId, binding.bindingId, 'mutation');
    const parsed = inputSchema.safeParse(await readInstanceJson(request));
    if (!parsed.success) throw new Error('instance_invalid');
    if (request.headers.get('if-match') !== `"${control.editRevision}"`) throw new Error('instance_conflict');
    if (control.candidate?.publicOrigin !== host.setupOrigin) throw new Error('instance_operator_required');
    await beginInstanceActivation(db, host.instanceId, control.editRevision, parsed.data.candidateVersion, parsed.data.confirmationNonce, binding.bindingId);
    await reconcileInstanceActivation();
    await startConfiguredWorker('nodejs');
    const latest = await readInstance(db, host.instanceId);
    const ready = latest?.lifecycle === 'ready' && latest.gate.state === 'open' && latest.active?.version === parsed.data.candidateVersion &&
      (await checkRuntimeHealth(db, host.config.contentRoot, { instanceId: host.instanceId, activeVersion: latest.active.version,
        securityEpoch: latest.securityEpoch, recoveryEpoch: latest.recoveryEpoch })).status === 'ok';
    return Response.json({ ...(latest ? instanceSnapshot(latest) : {}), status: ready ? 'active' : 'pending',
      message: ready ? 'The configuration is active.' : 'Activation is pending. Check instance status before continuing.' }, {
      status: ready ? 200 : 202, headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) { return instanceErrorResponse(error); }
}
