import { withAdminRuntime } from '@/lib/auth/admin';
import { requireAdmin, adminErrorResponse } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function handleGET(request: Request) {
  try {
    const { csrfToken } = await requireAdmin(request);
    return Response.json({ csrfToken }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return adminErrorResponse(error); }
}

export async function GET(request: Request) { return withAdminRuntime(() => handleGET(request)); }
