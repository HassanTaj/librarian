import { defineDocs } from 'fumadocs-mdx/macro';
import { loader } from 'fumadocs-core/source';

const docs = defineDocs({
  dir: '.',
  docs: {
    files: ['**/*.mdx', '!node_modules/**', '!.next/**', '!app/**'],
  },
  meta: {
    files: ['**/meta.json'],
  },
});

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
});
