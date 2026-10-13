import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { LIMITS } from '../limits';

const invalid = () => { throw new Error('invalid_path'); };

export function canonicalPath(input: unknown, decode = false): string {
  if (typeof input !== 'string' || input.length === 0 || Buffer.byteLength(input) > LIMITS.maxPathBytes * (decode ? 3 : 1)) return invalid();
  const raw = input.split('/');
  if (raw.length > LIMITS.maxPathSegments) return invalid();
  const parts = raw.map(segment => {
    let part = segment;
    if (decode) {
      try { part = decodeURIComponent(segment); } catch { return invalid(); }
    }
    // Use portable filenames so Windows cannot reinterpret a snapshot as an alias or data stream.
    if (!part || part === '.' || part === '..' || /[\\/:*?\[\]{}!()@+\p{Cc}]/u.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /%[a-f0-9]{2}/i.test(part)) return invalid();
    return part;
  });
  const path = parts.join('/');
  if (Buffer.byteLength(path) > LIMITS.maxPathBytes) return invalid();
  return path;
}

export function isDocumentPath(path: string) {
  return path.endsWith('.md') || path.endsWith('.mdx');
}

export function documentRoute(path: string) {
  const canonical = canonicalPath(path);
  if (!isDocumentPath(canonical)) return invalid();
  return canonical.slice(0, -posix.extname(canonical).length).replace(/(?:^|\/)index$/, '');
}

export function generationRoot(root: string, catalogId: string, generationId: string) {
  z.uuidv4().parse(catalogId); z.uuidv4().parse(generationId);
  if (!isAbsolute(root)) return invalid();
  return join(root, catalogId, 'generations', generationId);
}

export function resolveLinkTarget(sourcePath: string, href: string, image = false) {
  canonicalPath(sourcePath);
  if (/\p{Cc}/u.test(href) || href.startsWith('//')) return invalid();
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    const url = new URL(href);
    if (image || !['https:', 'mailto:'].includes(url.protocol) || url.username || url.password) return invalid();
    return { kind: 'external' as const, url: url.href };
  }
  const [withoutAnchor, ...anchors] = href.split('#');
  if (anchors.length > 1 || withoutAnchor.includes('?')) return invalid();
  let anchor = '';
  if (anchors.length) {
    let decodedAnchor;
    try { decodedAnchor = decodeURIComponent(anchors[0]); } catch { return invalid(); }
    if (/\p{Cc}/u.test(decodedAnchor) || /%[a-f0-9]{2}/i.test(decodedAnchor) || Buffer.byteLength(decodedAnchor) > LIMITS.maxPathBytes) return invalid();
    anchor = `#${encodeURIComponent(decodedAnchor)}`;
  }
  const decoded = withoutAnchor.split('/').map(segment => {
    let part;
    try { part = decodeURIComponent(segment); } catch { return invalid(); }
    if (/[\\/\p{Cc}]/u.test(part) || /%[a-f0-9]{2}/i.test(part)) return invalid();
    return part;
  }).join('/');
  const absolute = decoded.startsWith('/');
  const target = decoded ? canonicalPath(absolute ? decoded.slice(1) || 'index' : posix.join(posix.dirname(sourcePath), decoded)) : sourcePath;
  if (!image && (isDocumentPath(target) || !posix.extname(target))) {
    return { kind: 'document' as const, path: target, anchor };
  }
  if (!decoded || anchor) return invalid();
  if (image && !/\.(?:png|jpe?g|gif|webp)$/i.test(target)) return invalid();
  return { kind: 'asset' as const, path: target };
}

export function resolveContentLink(slug: string, generation: string, sourcePath: string, href: string, image = false) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(slug)) return invalid();
  z.uuidv4().parse(generation);
  const target = resolveLinkTarget(sourcePath, href, image);
  if (target.kind === 'external') return target.url;
  const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');
  if (target.kind === 'document') {
    const route = isDocumentPath(target.path) ? documentRoute(target.path) : target.path.replace(/(?:^|\/)index$/, '');
    return `/${slug}${route ? `/${encode(route)}` : ''}?g=${generation}${target.anchor}`;
  }
  return `/api/assets/${slug}/${encode(target.path)}?g=${generation}`;
}

function contained(root: string, path: string) {
  const fromRoot = relative(root, path);
  return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

export async function openSafeFile(root: string, path: string) {
  const canonical = canonicalPath(path);
  const actualRoot = await realpath(root);
  const target = resolve(actualRoot, canonical);
  if (!contained(actualRoot, target)) return invalid();
  let cursor = actualRoot;
  const parts = canonical.split('/');
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return invalid();
  }
  const original = await lstat(target);
  if (!contained(actualRoot, await realpath(target))) return invalid();
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== original.dev || opened.ino !== original.ino || !contained(actualRoot, await realpath(target))) return invalid();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
