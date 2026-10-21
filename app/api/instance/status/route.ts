import { randomBytes } from 'node:crypto';
import { readInstanceSetupStatus } from '@/lib/instance/bootstrap';
import { instancePreSessionCsrfCookie } from '@/lib/instance/access';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET() {
  const status = await readInstanceSetupStatus();
  const responseHeaders = new Headers({ 'Cache-Control': 'private, no-store' });
  responseHeaders.append('Set-Cookie', `${instancePreSessionCsrfCookie}=${randomBytes(32).toString('base64url')}; Path=/; Max-Age=300; Secure; SameSite=Strict`);
  return Response.json({ version: '2', state: status.state, prerequisitesAvailable: status.prerequisitesAvailable }, { headers: responseHeaders });
}
