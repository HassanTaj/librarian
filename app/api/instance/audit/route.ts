import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { requireInstanceAdmin, instanceErrorResponse } from '@/lib/instance/access';
import { drainInstanceAudit } from '@/lib/instance/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const cursorSchema = z.strictObject({ at: z.iso.datetime(), id: z.uuid() });
export async function GET(request: Request) {
  try {
    const { db, host } = await requireInstanceAdmin(request);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => !['limit', 'cursor'].includes(key)) || query.getAll('limit').length > 1 || query.getAll('cursor').length > 1) throw new Error('instance_invalid');
    const rawLimit = query.get('limit') ?? '20';
    if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) throw new Error('instance_invalid');
    const limit = Number(rawLimit);
    const sign = (payload: string) => createHmac('sha256', host.config.authSecret).update(`instance-audit\0${host.instanceId}\0${payload}`).digest('base64url');
    let cursor: z.infer<typeof cursorSchema> | null = null;
    const encoded = query.get('cursor');
    if (encoded !== null) {
      if (encoded.length > 512) throw new Error('instance_invalid');
      const [payload, signature, extra] = encoded.split('.');
      const expected = Buffer.from(sign(payload ?? ''));
      const supplied = Buffer.from(signature ?? '');
      if (!payload || extra !== undefined || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('instance_invalid');
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))); }
      catch { throw new Error('instance_invalid'); }
    }
    await drainInstanceAudit(db, host.instanceId);
    const filter = { instanceId: host.instanceId, at: { $gt: new Date(Date.now() - 90 * 86400_000) }, ...(cursor ? {
      $or: [{ at: { $lt: new Date(cursor.at) } }, { at: new Date(cursor.at), _id: { $lt: cursor.id } }],
    } : {}) };
    const rows = await db.collection<{ _id: string; instanceId: string; at: Date; actor: string; operation: string; fromVersion: number | null; toVersion: number | null; resultCode: string; requestId: string }>('instance_audit_events')
      .find(filter).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray();
    const events = rows.slice(0, limit).map(({ _id, at, actor, operation, fromVersion, toVersion, resultCode, requestId }) => ({ id: _id, at, actor, operation, fromVersion, toVersion, resultCode, requestId }));
    const last = events.at(-1);
    const payload = last && rows.length > limit ? Buffer.from(JSON.stringify({ at: last.at.toISOString(), id: last.id })).toString('base64url') : null;
    return Response.json({ events, nextCursor: payload ? `${payload}.${sign(payload)}` : null }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return instanceErrorResponse(error); }
}
