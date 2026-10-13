import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { getMDXComponents } from '../../mdx-components';

it('renders every supported static Columns layout', () => {
  const Columns = getMDXComponents().Columns;
  const expected = [
    'grid-cols-1',
    'grid-cols-1 sm:grid-cols-2',
    'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
  ];

  expected.forEach((classes, index) => {
    const html = renderToStaticMarkup(createElement(Columns, { cols: index + 1 }, 'Column content'));
    expect(html).toContain(classes);
  });
});
