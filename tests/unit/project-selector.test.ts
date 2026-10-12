import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ProjectSelector } from '../../components/project-selector';

it('renders safe project links and marks restricted entries', () => {
  const projects = [
    { slug: 'librarian', title: 'Librarian', publicDescription: '', visibility: 'public' as const, url: '/librarian' },
    { slug: 'another', title: 'Another project', publicDescription: '', visibility: 'private' as const, url: '/another' },
  ];
  const html = renderToStaticMarkup(createElement(ProjectSelector, { projects, current: 'librarian' }));

  expect(html).toContain('<summary aria-label="Select project. Current: Librarian"');
  expect(html).toContain('href="/librarian" aria-current="page"');
  expect(html).toContain('href="/another"');
  expect(html).toContain('Restricted');
});

it('falls back to a generic selector label when the selected catalog is unavailable', () => {
  const projects = [{ slug: 'another', title: 'Another project', publicDescription: '', visibility: 'public' as const, url: '/another' }];
  const html = renderToStaticMarkup(createElement(ProjectSelector, { projects, current: 'missing-project' }));
  expect(html).toContain('aria-label="Select project. Current: missing-project"');
  expect(html).toContain('>Select project</summary>');
});
