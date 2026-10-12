import { posix } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import { remarkHeading } from 'fumadocs-core/mdx-plugins/remark-heading';
import { parseDocument, isAlias, isMap, isSeq, isScalar, type Node as YamlNode } from 'yaml';
import { z } from 'zod';
import { LIMITS } from '../limits';
import { canonicalPath, documentRoute, resolveLinkTarget } from './paths';

const invalid = (): never => { throw new Error('invalid_content'); };
const markdown = unified().use(remarkParse);
const mdx = unified().use(remarkParse).use(remarkMdx);
const label = (max: number) => z.string().refine(value => [...value].length <= max && !/\p{Cc}/u.test(value));
const titleSchema = label(120).refine(value => value.trim().length > 0);
const frontmatterSchema = z.object({ title: titleSchema.optional(), description: label(500).optional(), full: z.boolean().optional() }).strict();
const metaSchema = z.object({ title: label(120).optional(), description: label(500).optional(),
  pages: z.array(z.string()).max(LIMITS.maxPages).optional(), root: z.boolean().optional(), defaultOpen: z.boolean().optional() }).strict();

function text(bytes: Buffer, maximum: number) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximum) return invalid();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n'); }
  catch { return invalid(); }
}

function yamlMetadata(input: string) {
  if (Buffer.byteLength(input) > LIMITS.maxMetadataBytes) return invalid();
  const document = parseDocument(input, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true });
  if (document.errors.length || document.warnings.length || document.directives?.yaml.version !== '1.2') return invalid();
  const stack: Array<{ node: YamlNode | null; depth: number }> = [{ node: document.contents, depth: 1 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > LIMITS.maxMetadataDepth || isAlias(node)) return invalid();
    if (!node) continue;
    if (node.anchor || node.tag) return invalid();
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<') return invalid();
      stack.push({ node: pair.key, depth: depth + 1 }, { node: pair.value as YamlNode | null, depth: depth + 1 });
    }
    if (isSeq(node)) for (const item of node.items) stack.push({ node: item as YamlNode | null, depth: depth + 1 });
  }
  return frontmatterSchema.parse(document.toJS({ maxAliasCount: 0 }) ?? {});
}

type SyntaxNode = { type: string; value?: string; children?: SyntaxNode[]; depth?: number; url?: string; identifier?: string;
  position?: { start: { offset?: number }; end: { offset?: number } } };
function walk(root: SyntaxNode, visit: (node: SyntaxNode) => void) {
  const stack = [root]; let count = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (++count > LIMITS.maxAstNodes) return invalid();
    visit(node);
    if (node.children) stack.push(...node.children.toReversed());
  }
}

export function validateMarkdown(path: string, bytes: Buffer) {
  canonicalPath(path);
  if (!path.endsWith('.md')) return invalid();
  let body = text(bytes, LIMITS.maxMarkdownBytes);
  let frontmatter: z.infer<typeof frontmatterSchema> = {};
  if (body.startsWith('---\n')) {
    const end = /\n---(?:\n|$)/.exec(body.slice(4));
    if (!end) return invalid();
    frontmatter = yamlMetadata(body.slice(4, 4 + end.index));
    body = body.slice(4 + end.index + end[0].length);
  }
  if (!body.trim()) return invalid();
  const tree = markdown.parse(body);
  const definitions = new Map<string, string>();
  walk(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier!)) definitions.set(node.identifier!, node.url!); });
  const headingFile = { data: {} } as Parameters<ReturnType<typeof remarkHeading>>[1];
  remarkHeading()(tree, headingFile, () => undefined);
  const headings = (headingFile.data.toc as Array<{ title: string; url: string; depth: number }> | undefined ?? [])
    .map(item => ({ id: item.url.slice(1), title: item.title, depth: item.depth }));
  const links: Array<{ href: string; image: boolean }> = [];
  const masked = body.split('');
  let heading = '';
  walk(tree, node => {
    if (node.type === 'html') return invalid();
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      resolveLinkTarget(path, node.url!, node.type === 'image');
      if (node.type !== 'definition') links.push({ href: node.url!, image: node.type === 'image' });
    }
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const href = definitions.get(node.identifier!);
      if (!href) return invalid();
      resolveLinkTarget(path, href, node.type === 'imageReference');
      links.push({ href, image: node.type === 'imageReference' });
    }
    if (node.type === 'heading' && node.depth === 1 && !heading) walk(node, child => { if (child.value) heading += child.value; });
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (['code', 'inlineCode'].includes(node.type) || (node.type === 'link' && body[start] === '<')) {
      for (let index = start; index < end; index++) if (masked[index] !== '\n') masked[index] = ' ';
    }
  });
  const candidate = masked.join('');
  let slashes = 0; let expression = false;
  for (const character of candidate) {
    if (character === '{' && slashes % 2 === 0) expression = true;
    slashes = character === '\\' ? slashes + 1 : 0;
  }
  if (expression || /^(?:import|export)\s/m.test(candidate) || /<>|<\//.test(candidate)) {
    // Parse only: source imports, JSX and expressions are never compiled or evaluated here.
    const executable = mdx.parse(candidate);
    walk(executable, node => { if (node.type.startsWith('mdx')) return invalid(); });
  }
  const title = titleSchema.parse(frontmatter.title ?? (heading || posix.basename(path, '.md')));
  const normalized = `---\n${JSON.stringify({ ...frontmatter, title })}\n---\n${body}`;
  return { body, frontmatter, title, markdown: normalized, headings, links };
}

function checkMetadataDepth(input: unknown) {
  const stack = [{ value: input, depth: 1 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > LIMITS.maxMetadataDepth) return invalid();
    if (value && typeof value === 'object') for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
}

export function validateMeta(path: string, bytes: Buffer, pages: string[]) {
  canonicalPath(path);
  const input: unknown = JSON.parse(text(bytes, LIMITS.maxMetadataBytes));
  checkMetadataDepth(input);
  const meta = metaSchema.parse(input);
  const directory = posix.dirname(path);
  for (const entry of meta.pages ?? []) {
    if (entry === '...') continue;
    const target = canonicalPath(posix.join(directory, canonicalPath(entry)));
    if (!pages.some(page => page === `${target}.md` || page === `${target}/index.md` || page.startsWith(`${target}/`))) return invalid();
  }
  return meta;
}

export function validateAsset(path: string, bytes: Buffer) {
  canonicalPath(path);
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.maxAssetBytes) return invalid();
  const extension = posix.extname(path).toLowerCase();
  const rasters: Record<string, { mime: string; valid: boolean }> = {
    '.png': { mime: 'image/png', valid: bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' },
    '.jpg': { mime: 'image/jpeg', valid: bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217 },
    '.gif': { mime: 'image/gif', valid: bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) },
    '.webp': { mime: 'image/webp', valid: bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' },
  };
  const raster = rasters[extension === '.jpeg' ? '.jpg' : extension];
  if (raster) { if (!raster.valid) return invalid(); return { mime: raster.mime, inline: true, content: bytes }; }
  const attachments: Record<string, string> = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json' };
  const mime = attachments[extension];
  if (!mime) return invalid();
  if (extension === '.pdf') {
    if (!/^%PDF-\d\.\d/.test(bytes.toString('ascii', 0, 8)) || !bytes.subarray(-1024).includes(Buffer.from('%%EOF'))) return invalid();
    return { mime, inline: false, content: bytes };
  }
  const decoded = text(bytes, LIMITS.maxAssetBytes);
  if (extension === '.json') JSON.parse(decoded);
  return { mime, inline: false, content: Buffer.from(decoded) };
}

export type CandidateFile = { path: string; mode: string; content: Buffer };
export function validateCandidate(files: CandidateFile[]) {
  if (!Array.isArray(files) || files.length > LIMITS.maxFiles) return invalid();
  const documents: Array<ReturnType<typeof validateMarkdown> & { path: string; route: string }> = [];
  const assets: Array<ReturnType<typeof validateAsset> & { path: string }> = [];
  const metadata: Array<{ path: string; content: Buffer }> = [];
  const paths = new Set<string>(); const routes = new Set<string>(); let bytes = 0;
  for (const file of files) {
    const path = canonicalPath(file.path);
    if (path === 'manifest.json' || file.mode !== '100644' || paths.has(path)) return invalid();
    paths.add(path);
    if (path.endsWith('.md')) {
      if (documents.length >= LIMITS.maxPages) return invalid();
      const route = documentRoute(path);
      if (routes.has(route)) return invalid();
      routes.add(route);
      const document = validateMarkdown(path, file.content);
      documents.push({ ...document, path, route }); bytes += Buffer.byteLength(document.markdown);
    } else if (posix.basename(path) === 'meta.json') {
      metadata.push({ path, content: file.content });
    } else {
      const asset = validateAsset(path, file.content);
      assets.push({ ...asset, path }); bytes += asset.content.length;
    }
    if (bytes > LIMITS.maxSnapshotBytes) return invalid();
  }
  if (!documents.length) return invalid();
  const normalizedMetadata = metadata.map(file => {
    const content = Buffer.from(JSON.stringify(validateMeta(file.path, file.content, documents.map(document => document.path))));
    bytes += content.length;
    if (bytes > LIMITS.maxSnapshotBytes) return invalid();
    return { path: file.path, content };
  });
  // The publisher adds manifest bytes and rechecks this same total before completing a generation.
  return { documents, assets, metadata: normalizedMetadata, bytes };
}
