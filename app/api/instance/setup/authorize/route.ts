import { z } from 'zod';
import { connectMongo } from '@/lib/mongo';
import { readInstanceHost } from '@/lib/instance/bootstrap';
import { authorizeInstanceSetup, instanceErrorResponse, readInstanceJson, verifyInstancePreSessionMutation } from '@/lib/instance/access';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const inputSchema = z.strictObject({ credential: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/) });

export async function POST(request: Request) {
  try {
    const host = await readInstanceHost();
    verifyInstancePreSessionMutation(request, host.setupOrigin);
    if (!['bootstrap', 'recover'].includes(host.operator.purpose) || Date.parse(host.operator.expiresAt) <= Date.now()) throw new Error('instance_setup_unauthorized');
    const parsed = inputSchema.safeParse(await readInstanceJson(request));
    if (!parsed.success) throw new Error('instance_invalid');
    const input = parsed.data;
    const storage = await connectMongo(host.config, { initializeLegacy: false });
    try {
      const session = await authorizeInstanceSetup(storage.db, host.instanceId, input.credential, new Date(), host.operator.purpose === 'recover' ? 'recovery' : 'bootstrap');
      const maxAge = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
      if (maxAge <= 0) throw new Error('instance_setup_unauthorized');
      const headers = new Headers({ 'Cache-Control': 'private, no-store' });
      headers.append('Set-Cookie', `__Host-librarian_setup=${session.token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`);
      headers.append('Set-Cookie', `__Host-librarian_setup_csrf=${session.csrfToken}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`);
      headers.append('Set-Cookie', '__Host-librarian_pre_csrf=; Path=/; Max-Age=0; Secure; SameSite=Strict');
      return Response.json({ expiresAt: session.expiresAt, csrfToken: session.csrfToken, purpose: host.operator.purpose === 'recover' ? 'recovery' : 'bootstrap' }, { headers });
    } finally { await storage.client.close(); }
  } catch (error) { return instanceErrorResponse(error); }
}
