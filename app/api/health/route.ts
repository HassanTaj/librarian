import { getMongo } from '@/lib/mongo';
import { checkHealth } from '@/lib/operations/health';
import { hasHealthySyncWorker } from '@/lib/sync/worker';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET() {
  try {
    const { db, contentRoot } = await getMongo();
    const storage = contentRoot ? await checkHealth(db, contentRoot) : { status: 'unavailable' as const };
    const ready = storage.status === 'ok' && await hasHealthySyncWorker(db);
    return Response.json({ status: ready ? 'ok' : 'not_ready' }, {
      status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ status: 'not_ready' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
