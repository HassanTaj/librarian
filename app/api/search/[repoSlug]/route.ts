import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getMongo } from '@/lib/mongo';
import { withRuntimeContent } from '@/lib/content/source';
import { searchContent } from '@/lib/content/search';
import { LIMITS } from '@/lib/limits';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function error(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'invalid_path' || code === 'invalid_query') return json({ error: { code, message: 'The request is invalid.' }, requestId: randomUUID() }, 400);
  if (code === 'unauthorized' || code === 'not_found' || code === 'content_unavailable') return json({ error: { code: 'not_found', message: 'The requested content is unavailable.' }, requestId: randomUUID() }, 404);
  if (code === 'reload_required') return json({ error: { code, message: 'Reload this page to continue.' }, requestId: randomUUID() }, 409);
  return json({ error: { code: 'content_unavailable', message: 'Search is temporarily unavailable.' }, requestId: randomUUID() }, 503);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ repoSlug: string }> }) {
  const { repoSlug } = await params;
  const url = new URL(request.url);
  const values = url.searchParams.getAll('query');
  const generations = url.searchParams.getAll('g');
  if (values.length > 1 || generations.length > 1 || (generations[0] && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generations[0]))) {
    return json({ error: { code: 'invalid_query', message: 'The request is invalid.' }, requestId: randomUUID() }, 400);
  }
  const query = values[0] ?? '';
  if (Buffer.byteLength(query, 'utf8') > LIMITS.maxSearchQueryBytes) {
    return json({ error: { code: 'invalid_query', message: 'The request is invalid.' }, requestId: randomUUID() }, 400);
  }
  try {
    const { db, contentRoot } = await getMongo();
    if (!contentRoot) throw new Error('storage_unavailable');
    const results = await withRuntimeContent(db, contentRoot, repoSlug, generations[0], content => searchContent(content, query));
    return json(results);
  } catch (caught) { return error(caught); }
}
