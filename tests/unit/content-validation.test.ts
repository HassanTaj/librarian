import { expect, it } from 'vitest';
import { syntaxCases } from '../fixtures/catalogs';
import { validateMarkdown, validateMeta, validateCandidate, validateAsset } from '../../lib/content/validate';
import { readFileSync } from 'node:fs';
import { LIMITS } from '../../lib/limits';

const file = (path: string, content: string | Buffer, mode = '100644') => ({ path, mode, content: Buffer.isBuffer(content) ? content : Buffer.from(content) });

it('preserves GFM, autolinks, code and escaped braces without executing source', () => {
  const body = '# Synthetic title\n\n| Column | Value |\n| --- | --- |\n| One | Two |\n\n- [x] Task\n\n<https://synthetic.invalid>\n\n' + syntaxCases.escapedBraces;
  const parsed = validateMarkdown('guide.md', Buffer.from(body));
  expect(parsed.body).toBe(body);
  expect(parsed.title).toBe('Synthetic title');
  expect(Reflect.get(globalThis, 'syntheticExecuted')).toBeUndefined();
});

it('records Fumadocs heading IDs and resolved reference links for the manifest', () => {
  const parsed = validateMarkdown('index.md', Buffer.from('# Guide\n\n## Step\n\n## Step\n\n[Setup][setup]\n\n![Pixel][pixel]\n\n[setup]: guide.md#first\n[pixel]: pixel.png'));
  expect(parsed.headings.map(({ id, depth }) => [id, depth])).toEqual([['guide', 1], ['step', 2], ['step-1', 2]]);
  expect(parsed.links).toEqual([
    { href: 'guide.md#first', image: false }, { href: 'pixel.png', image: true },
  ]);
});

it.each([
  syntaxCases.executableMdx, syntaxCases.expression, syntaxCases.html,
  '<Component value="synthetic" />', '<>fragment</>', 'export const value = 1;',
  '\\\\{globalThis.syntheticExecuted = true}', '<!-- raw HTML is not an executable-content exception -->',
])('rejects executable candidates and raw HTML without executing them (%s)', body => {
  expect(() => validateMarkdown('guide.md', Buffer.from(body))).toThrow();
  expect(Reflect.get(globalThis, 'syntheticExecuted')).toBeUndefined();
});

it('validates and normalizes optional frontmatter and fallback titles', () => {
  const parsed = validateMarkdown('nested/guide.md', Buffer.from('---\r\ntitle: Configured title\r\ndescription: Safe description\r\nfull: true\r\n---\r\n# Body title\r\n'));
  expect(parsed.frontmatter).toEqual({ title: 'Configured title', description: 'Safe description', full: true });
  expect(parsed.title).toBe('Configured title');
  expect(parsed.body).toBe('# Body title\n');
  const fallback = validateMarkdown('nested/guide.md', Buffer.from('Safe content'));
  expect(fallback.title).toBe('guide');
  expect(fallback.markdown).toContain('{"title":"guide"}');
});

it.each([
  syntaxCases.yamlAlias, syntaxCases.yamlTag,
  '---\ntitle: !!str Explicit tag\n---\n# Synthetic',
  '---\ntitle: First\ntitle: Duplicate\n---\n# Synthetic',
  '---\nunknown: value\n---\n# Synthetic',
  '---\nfull: not-a-boolean\n---\n# Synthetic',
  '---\n"<<": { title: Merged }\n---\n# Synthetic',
])('rejects unsupported YAML or schema features (%s)', markdown => {
  expect(() => validateMarkdown('guide.md', Buffer.from(markdown))).toThrow();
});

it('rejects malformed UTF-8, empty documents and finite input/AST bounds', () => {
  for (const body of [Buffer.from([0xff]), Buffer.from('  \n'), Buffer.from('x'.repeat(256 * 1024 + 1)), Buffer.from('---\ntitle: ' + 'x'.repeat(16 * 1024) + '\n---\nBody'), Buffer.from('- [x] **node** and *second*\n'.repeat(7000))]) {
    expect(() => validateMarkdown('guide.md', body)).toThrow();
  }
});

it.each(['![remote](https://synthetic.invalid/image.png)', '![not-raster](notes.pdf)', '[unsafe](javascript:alert)', '[escaped](../../../outside.md)', '[encoded](%252e%252e/outside.md)'])('rejects unsafe links and remote images (%s)', body => {
  expect(() => validateMarkdown('nested/page.md', Buffer.from(body))).toThrow();
});

it('allows bounded navigation for existing pages and rejects unsafe metadata', () => {
  expect(validateMeta('meta.json', Buffer.from('{"title":"Synthetic navigation","pages":["index","guide"]}'), ['index.md', 'guide.md'])).toEqual({ title: 'Synthetic navigation', pages: ['index', 'guide'] });
  expect(validateMeta('meta.json', Buffer.from('{"pages":["guide.mdx"]}'), ['guide.mdx'])).toEqual({ pages: ['guide.mdx'] });
  for (const json of ['{"pages":["missing"]}', '{"pages":["../outside"]}', '{"pages":["https://synthetic.invalid"]}', '{"unknown":true}', '{"title":3}', 'not JSON', JSON.stringify({ title: 'x'.repeat(16 * 1024) })]) {
    expect(() => validateMeta('meta.json', Buffer.from(json), ['index.md'])).toThrow();
  }
});

it('accepts safe static Fumadocs MDX components and rejects executable or unknown syntax', () => {
  const page = validateMarkdown('guides/quickstart.mdx', Buffer.from('---\ntitle: Quickstart\n---\n# Quickstart\n\nA **safe** MDX page.'));
  expect(page.title).toBe('Quickstart');
  expect(validateCandidate([file('index.mdx', '# Home'), file('guide.mdx', '# Guide')]).documents.map(item => item.path))
    .toEqual(['index.mdx', 'guide.mdx']);
  const components = '<Info>Details</Info>\n\n<Columns cols={2}><Card title="Guide" icon="book" href="/guides/setup">Open</Card></Columns>\n\n<Steps><Step title="One">Start here.</Step></Steps>';
  expect(validateMarkdown('guide.mdx', Buffer.from(components)).links).toEqual([]);
  for (const source of [
    'import Example from "./example";\n# Page',
    'export const value = 1;\n# Page',
    '# Page\n\n{process.env.SECRET}',
    '<Callout>Unknown component</Callout>',
    '<Info onClick="run">Unknown prop</Info>',
    '<Columns cols={process.env.COLS}>Dynamic value</Columns>',
    '<Card title="Unsafe" href="javascript:alert(1)">Bad link</Card>',
    '<Card title="Unsafe" href={location.href}>Dynamic link</Card>',
    '<script>unsafe HTML</script>',
  ]) expect(() => validateMarkdown('guide.mdx', Buffer.from(source))).toThrow();
});

it('rejects unsupported document extensions and Card links to attachment files', () => {
  expect(() => validateMarkdown('notes.txt', Buffer.from('# Not a document'))).toThrow('invalid_content');
  expect(() => validateMarkdown('guide.mdx', Buffer.from('<Card title="Download" href="attachment.pdf">Open</Card>')))
    .toThrow('invalid_content');
});

it('accepts attachments only as safe MIME types and rejects executable or mislabeled assets', () => {
  expect(validateAsset('notes.txt', Buffer.from('Synthetic attachment'))).toMatchObject({ mime: 'text/plain', inline: false });
  expect(validateAsset('data.csv', Buffer.from('name,value\nsynthetic,1'))).toMatchObject({ mime: 'text/csv', inline: false });
  expect(validateAsset('data.json', Buffer.from('{"synthetic":true}'))).toMatchObject({ mime: 'application/json', inline: false });
  expect(validateAsset('notes.pdf', Buffer.from('%PDF-1.7\nSynthetic test fixture\n%%EOF'))).toMatchObject({ mime: 'application/pdf', inline: false });
  for (const path of ['script.js', 'image.svg', 'page.html', 'component.mdx', 'image.png']) expect(() => validateAsset(path, Buffer.from('<script>synthetic</script>'))).toThrow();
  expect(() => validateAsset('notes.txt', Buffer.alloc(5 * 1024 * 1024 + 1))).toThrow();
});

it('rejects unsafe Git modes, escaping paths, route collisions and empty candidates', () => {
  for (const files of [[], [file('notes.txt', 'No Markdown')], [file('../outside.md', '# Unsafe')], [file('link.md', '# Unsafe', '120000')], [file('submodule.md', '# Unsafe', '160000')], [file('executable.md', '# Unsafe', '100755')], [file('guide.md', '# One'), file('guide/index.md', '# Two')], [file('same.md', '# One'), file('same.md', '# Two')], [file('index.md', '# Page'), file('manifest.json', '{}')]]) {
    expect(() => validateCandidate(files)).toThrow();
  }
  const candidate = validateCandidate([file('index.md', '# Synthetic'), file('meta.json', '{"pages":["index"]}'), file('notes.txt', 'Synthetic')]);
  expect(candidate.documents).toHaveLength(1);
  expect(candidate.assets).toHaveLength(1);
  expect(candidate.documents[0].route).toBe('');
});

it('enforces finite page/file limits before accepting a candidate', () => {
  expect(() => validateCandidate(Array.from({ length: 501 }, (_, index) => file(`page-${index}.md`, '# Synthetic')))).toThrow();
  expect(() => validateCandidate([file('index.md', '# Synthetic'), ...Array.from({ length: 1000 }, (_, index) => file(`file-${index}.txt`, 'Synthetic'))])).toThrow();
});

it('keeps heading text in source order and bounds fallback titles', () => {
  expect(validateMarkdown('guide.md', Buffer.from('# First **second** third')).title).toBe('First second third');
  expect(() => validateMarkdown('guide.md', Buffer.from('# ' + 'x'.repeat(121)))).toThrow();
  expect(() => validateMarkdown('guide.md', Buffer.from('---\ntitle: ""\n---\n# Valid'))).toThrow();
});

it('rejects remote and non-raster reference images, including normalized reference labels', () => {
  for (const source of [
    '![image][REMOTE]\n\n[remote]: https://synthetic.invalid/pixel.png',
    '![remote]\n\n[remote]: https://synthetic.invalid/pixel.png',
    '![image][attachment]\n\n[attachment]: notes.pdf',
  ]) expect(() => validateMarkdown('guide.md', Buffer.from(source))).toThrow();
  expect(validateMarkdown('guide.md', Buffer.from('![image][local]\n\n[local]: pixel.png')).body).toContain('pixel.png');
});

it('rejects warning-bearing YAML directives and keeps literal scalar braces safe', () => {
  expect(() => validateMarkdown('guide.md', Buffer.from('---\n%YAML 1.1\n---\ntitle: Synthetic\n---\n# Safe'))).toThrow();
  expect(validateMarkdown('guide.md', Buffer.from('---\ntitle: "Literal {braces}"\n---\n# Safe')).title).toBe('Literal {braces}');
});

it('accepts each supported raster signature and rejects malformed raster and PDF bytes', () => {
  const png = readFileSync('tests/fixtures/content/public-project/pixel.png');
  const gif = Buffer.from('GIF89a' + '\0'.repeat(7));
  const webp = Buffer.from('RIFF' + '\0'.repeat(4) + 'WEBP');
  const jpeg = Buffer.from([255, 216, 255, 217]);
  for (const [path, bytes, mime] of [
    ['pixel.png', png, 'image/png'], ['pixel.gif', gif, 'image/gif'],
    ['pixel.webp', webp, 'image/webp'], ['pixel.jpeg', jpeg, 'image/jpeg'],
  ] as const) expect(validateAsset(path, bytes)).toEqual({ mime, inline: true, content: bytes });
  for (const [path, bytes] of [
    ['pixel.png', Buffer.concat([png.subarray(0, 12), Buffer.from('NOPE'), png.subarray(16)])],
    ['pixel.jpg', Buffer.from([255, 216, 0, 0])], ['pixel.jpg', Buffer.from([0, 0, 255, 217])],
    ['pixel.gif', Buffer.from('invalid' + '\0'.repeat(7))], ['pixel.webp', Buffer.from('RIFFxxxxNOPE')],
    ['notes.pdf', Buffer.from('%PDF-1.7 missing ending')], ['notes.pdf', Buffer.from('invalid %%EOF')],
    ['data.json', Buffer.from('not JSON')], ['notes.txt', Buffer.from([255])],
  ] as const) expect(() => validateAsset(path, bytes)).toThrow();
});

it('checks individual byte limits at limit minus one, the limit, and limit plus one', () => {
  for (const size of [LIMITS.maxMarkdownBytes - 1, LIMITS.maxMarkdownBytes]) expect(validateMarkdown('guide.md', Buffer.alloc(size, 'x')).body.length).toBe(size);
  expect(() => validateMarkdown('guide.md', Buffer.alloc(LIMITS.maxMarkdownBytes + 1, 'x'))).toThrow();
  for (const size of [LIMITS.maxAssetBytes - 1, LIMITS.maxAssetBytes]) expect(validateAsset('notes.txt', Buffer.alloc(size, 'x')).content.length).toBe(size);
  expect(() => validateAsset('notes.txt', Buffer.alloc(LIMITS.maxAssetBytes + 1, 'x'))).toThrow();
  for (const size of [LIMITS.maxMetadataBytes - 1, LIMITS.maxMetadataBytes]) {
    expect(validateMeta('meta.json', Buffer.from('{}' + ' '.repeat(size - 2)), [])).toEqual({});
    expect(validateMarkdown('guide.md', Buffer.from('---\n' + ' '.repeat(size) + '\n---\nBody')).body).toBe('Body');
  }
  expect(() => validateMeta('meta.json', Buffer.alloc(LIMITS.maxMetadataBytes + 1, 'x'), [])).toThrow();
  for (const source of ['', '---\ntitle: Incomplete', '---\ntitle:\n---\nBody', '---\nfull: [a, b]\n---\nBody', '---\n? [a, b]\n: value\n---\nBody']) expect(() => validateMarkdown('guide.md', Buffer.from(source))).toThrow();
  expect(validateMarkdown('guide.mdx', Buffer.from('x'.repeat(LIMITS.maxMarkdownBytes))).body.length).toBe(LIMITS.maxMarkdownBytes);
  expect(() => validateMarkdown('guide.mdx', Buffer.alloc(LIMITS.maxMarkdownBytes + 1, 'x'))).toThrow();
});

it('validates derived and grouped navigation, wildcards and bounded metadata structure', () => {
  const pages = ['guide/index.md', 'nested/page.md'];
  expect(validateMeta('meta.json', Buffer.from('{"pages":["...","guide","nested"]}'), pages).pages).toEqual(['...', 'guide', 'nested']);
  expect(validateMeta('meta.json', Buffer.from('{"title":"Derived"}'), pages).title).toBe('Derived');
  const deep = '{"unknown":'.repeat(9) + 'null' + '}'.repeat(9);
  expect(() => validateMeta('meta.json', Buffer.from(deep), pages)).toThrow('invalid_content');
  expect(() => validateMarkdown('guide.md', Buffer.from('---\nunknown: ' + '[ '.repeat(9) + 'null' + ' ]'.repeat(9) + '\n---\nBody'))).toThrow();
});

it('accepts exact file/page caps and includes normalized metadata in aggregate bytes', () => {
  for (const count of [LIMITS.maxPages - 1, LIMITS.maxPages]) expect(validateCandidate(Array.from({ length: count }, (_, i) => file(`page-${i}.md`, 'Body'))).documents).toHaveLength(count);
  for (const count of [LIMITS.maxFiles - 1, LIMITS.maxFiles]) expect(validateCandidate([file('index.md', 'Body'), ...Array.from({ length: count - 1 }, (_, i) => file(`note-${i}.txt`, ''))]).assets).toHaveLength(count - 1);
  const block = Buffer.alloc(LIMITS.maxAssetBytes, 'x');
  const documentBytes = Buffer.byteLength(validateMarkdown('index.md', Buffer.from('B')).markdown);
  const lastAssetBytes = LIMITS.maxSnapshotBytes - 9 * LIMITS.maxAssetBytes - documentBytes;
  const candidate = [file('index.md', 'B'), ...Array.from({ length: 9 }, (_, i) => file(`note-${i}.txt`, block)), file('last.txt', Buffer.alloc(lastAssetBytes, 'x'))];
  expect(validateCandidate(candidate).bytes).toBe(LIMITS.maxSnapshotBytes);
  expect(() => validateCandidate([...candidate, file('extra.txt', 'x')])).toThrow('invalid_content');
  expect(() => validateCandidate([...candidate, file('meta.json', '{}')])).toThrow('invalid_content');
});
