import { expect, it } from 'vitest';
import { canonicalPath, documentRoute, resolveContentLink, resolveLinkTarget, generationRoot } from '../../lib/content/paths';
import { join, resolve } from 'node:path';

it('keeps bounded canonical POSIX paths and maps Markdown index pages consistently', () => {
  expect(canonicalPath('nested/guide.md')).toBe('nested/guide.md');
  expect(canonicalPath('guide%20name.md', true)).toBe('guide name.md');
  expect(documentRoute('index.md')).toBe('');
  expect(documentRoute('nested/index.md')).toBe('nested');
  expect(documentRoute('nested/guide.md')).toBe('nested/guide');
});

it.each(['../outside', '/absolute', 'a/../outside', 'a/./b', 'a//b', 'a\\b', 'a\u0000b', '%2e%2e/outside', '%252e%252e/outside', 'a%2fb', 'a%5cb', 'x'.repeat(1025), Array(33).fill('a').join('/')])('rejects decoded escapes and invalid paths (%s)', path => {
  expect(() => canonicalPath(path, true)).toThrow();
});

it('resolves local Markdown and asset links inside the selected repository and generation', () => {
  const generation = '00000000-0000-4000-8000-000000000004';
  expect(resolveContentLink('project', generation, 'nested/page.md', '../guide.md#heading')).toBe(`/project/guide?g=${generation}#heading`);
  expect(resolveContentLink('project', generation, 'nested/page.md', 'image.png')).toBe(`/api/assets/project/nested/image.png?g=${generation}`);
  expect(resolveContentLink('project', generation, 'index.md', '#heading')).toBe(`/project?g=${generation}#heading`);
  expect(resolveContentLink('project', generation, 'page.md', 'https://synthetic.invalid/path')).toBe('https://synthetic.invalid/path');
  expect(resolveContentLink('project', generation, 'page.md', 'mailto:synthetic@example.invalid')).toBe('mailto:synthetic@example.invalid');
});

it.each(['javascript:alert(1)', 'data:text/html,synthetic', 'file:///outside', '//synthetic.invalid', '../../../outside.md', '../%252e%252e/outside.md'])('rejects unsafe schemes and escaping document links (%s)', link => {
  expect(() => resolveContentLink('project', '00000000-0000-4000-8000-000000000004', 'nested/page.md', link)).toThrow();
});

it.each(['guide.md:private', 'C:outside.md', 'nested/name.', 'nested/name ', 'NUL.md', 'nested/CON', 'nested/aux.txt'])('rejects filesystem aliases and alternate data streams (%s)', path => {
  expect(() => canonicalPath(path)).toThrow('invalid_path');
});

it.each(['a*.md', 'a?.md', 'a[1].md', 'a{draft}.md', 'a!.md', 'a@(draft).md', 'a+(draft).md'])('rejects glob metacharacters in manifest paths (%s)', path => {
  expect(() => canonicalPath(path)).toThrow('invalid_path');
});

it.each(['#%00', '#%252e', '#%zz'])('rejects malformed or doubly encoded heading anchors (%s)', href => {
  expect(() => resolveContentLink('project', '00000000-0000-4000-8000-000000000004', 'page.md', href)).toThrow();
});

it('uses opaque server identities for filesystem generation roots and rejects invalid inputs', () => {
  const id = '00000000-0000-4000-8000-000000000004';
  expect(generationRoot(resolve('.local/content'), id, id)).toBe(join(resolve('.local/content'), id, 'generations', id));
  expect(() => generationRoot('relative', id, id)).toThrow();
  expect(() => generationRoot(resolve('.local/content'), 'slug', id)).toThrow();
  for (const path of [null, '', 'x'.repeat(3073)]) expect(() => canonicalPath(path, true)).toThrow();
  expect(() => documentRoute('notes.txt')).toThrow();
  expect(() => resolveContentLink('Invalid', id, 'page.md', '#safe')).toThrow();
});

it('enforces decoded byte/segment and anchor bounds without losing ordinary Unicode', () => {
  for (const bytes of [1023, 1024]) expect(Buffer.byteLength(canonicalPath('a'.repeat(bytes)))).toBe(bytes);
  for (const count of [31, 32]) expect(canonicalPath(Array(count).fill('a').join('/')).split('/')).toHaveLength(count);
  expect(() => canonicalPath('%E2%82%AC'.repeat(342), true)).toThrow();
  expect(() => canonicalPath('%zz', true)).toThrow();
  expect(resolveLinkTarget('page.md', '#déjà')).toMatchObject({ anchor: '#d%C3%A9j%C3%A0' });
  for (const href of ['/escape.md', 'a%2fb.md', '%zz.md', 'a.md#one#two', 'a.md?query=1', 'a\0.md', '#'+ 'x'.repeat(1025), 'https://user:password@synthetic.invalid']) expect(() => resolveLinkTarget('page.md', href)).toThrow();
});
