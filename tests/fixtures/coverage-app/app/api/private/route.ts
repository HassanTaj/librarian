import { access } from '../../../lib/access';

export async function GET(request: Request) {
  const role = new URL(request.url).searchParams.get('role') ?? '';
  if (!access(role)) return Response.json({ status: 'denied' }, { status: 403 });
  return Response.json({ status: 'allowed' });
}
