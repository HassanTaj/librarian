import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getMongo } from '@/lib/mongo';
import { readAsset } from '@/lib/content/assets';
import { canonicalPath } from '@/lib/content/paths';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function responseError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const status = code === 'invalid_path' ? 400 : code === 'reload_required' ? 409 : code === 'not_found' || code === 'unauthorized' ? 404 : 503;
  const safeCode = status === 400 ? 'invalid_path' : status === 409 ? 'reload_required' : status === 404 ? 'not_found' : 'content_unavailable';
  return Response.json({ error: { code: safeCode, message: status === 409 ? 'Reload this page to continue.' : 'The requested file is unavailable.' }, requestId: randomUUID() },
    { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function generation(url: URL) {
  const values = url.searchParams.getAll('g');
  if (values.length > 1 || (values[0] && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(values[0]))) throw new Error('invalid_path');
  return values[0];
}

function headers(asset: { mime: string; inline: boolean; sha256: string; filename: string; bytes: Buffer }) {
  const fallback = asset.filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
  const encoded = encodeURIComponent(asset.filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const disposition = asset.inline ? 'inline' : 'attachment';
  return new Headers({
    'Cache-Control': 'private, no-store', 'Content-Type': asset.mime,
    'Content-Disposition': `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'Content-Length': String(asset.bytes.length), 'ETag': `"${asset.sha256}"`, 'X-Content-Type-Options': 'nosniff',
    ...(asset.inline ? {} : { 'Content-Security-Policy': 'sandbox' }),
  });
}

async function deliver(request: NextRequest, params: Promise<{ repoSlug: string; path: string[] }>, head: boolean) {
  try {
    const { repoSlug, path } = await params;
    const assetPath = canonicalPath(path.join('/'));
    const { db, contentRoot } = await getMongo();
    if (!contentRoot) throw new Error('storage_unavailable');
    const asset = await readAsset(db, contentRoot, repoSlug, generation(new URL(request.url)), assetPath, request.signal);
    const responseHeaders = headers(asset);
    const etag = `"${asset.sha256}"`;
    const match = request.headers.get('if-none-match')?.split(',').some(value => ['*', etag, `W/${etag}`].includes(value.trim()));
    if (match) { responseHeaders.delete('Content-Length'); return new Response(null, { status: 304, headers: responseHeaders }); }
    return new Response(head ? null : new Uint8Array(asset.bytes), { headers: responseHeaders });
  } catch (caught) { return responseError(caught); }
}

type RouteContext = { params: Promise<{ repoSlug: string; path: string[] }> };
export function GET(request: NextRequest, { params }: RouteContext) { return deliver(request, params, false); }
export function HEAD(request: NextRequest, { params }: RouteContext) { return deliver(request, params, true); }
