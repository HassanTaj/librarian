import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import Loading from '../../app/loading';

afterEach(() => vi.restoreAllMocks());

it('announces directory loading and hides skeleton decoration from assistive technology', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.9);
  const html = renderToStaticMarkup(createElement(Loading));

  expect(html).toContain('role="status" aria-label="Loading documentation directory" aria-busy="true"');
  expect(html).toContain('Loading documentation directory…');
  expect(html).toContain('<ul aria-hidden="true"');
  expect(html.match(/<li>/g)).toHaveLength(3);
});
