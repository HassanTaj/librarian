import { requireAdmin, adminErrorResponse } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const { csrfToken } = await requireAdmin(request);
    return Response.json({ csrfToken }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return adminErrorResponse(error); }
}
