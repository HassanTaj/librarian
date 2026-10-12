// All identities, titles and content in these fixtures are synthetic.
export const catalogs = [
  { _id: '00000000-0000-4000-8000-000000000001', slug: 'public-project', visibility: 'public', title: 'Public Project' },
  { _id: '00000000-0000-4000-8000-000000000002', slug: 'private-one', visibility: 'private', title: 'Restricted One' },
  { _id: '00000000-0000-4000-8000-000000000003', slug: 'private-two', visibility: 'private', title: 'Restricted Two' },
].map((catalog, index) => ({
  ...catalog,
  github: { repositoryId: index + 1, installationId: 456, owner: 'synthetic', name: catalog.slug, branch: 'main', docsPath: 'docs' },
  publicDescription: 'Configured synthetic directory description.',
  readerRole: `docs:${catalog.slug}:reader`, enabled: true, accessState: 'ready',
  configRevision: 1, authEpoch: 1, published: null, publicationRevision: 0,
  retained: [], lease: null, leaseFence: 0, readPins: [], admissionReservations: 0,
  rateWindow: { window: new Date('2026-01-01T00:00:00Z'), count: 0 },
  approvalRef: catalog.visibility === 'public' ? 'synthetic-owner-approval' : null,
  lastSuccess: null, lastFailure: null,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
}));

export const privateSentinels = ['SYNTHETIC_PRIVATE_ONE_BODY', 'SYNTHETIC_PRIVATE_TWO_BODY'];
export const tokenSentinel = 'SYNTHETIC_TOKEN_NEVER_PUBLIC';
export const syntaxCases = {
  executableMdx: 'import Unsafe from "./unsafe.js";\n\n<Unsafe />',
  expression: '{globalThis.syntheticExecuted = true}',
  html: '<script>globalThis.syntheticExecuted = true</script>',
  yamlAlias: '---\ntitle: &title Synthetic\ndescription: *title\n---\n# Synthetic',
  yamlTag: '---\ntitle: !!js/function function() {}\n---\n# Synthetic',
  escapedBraces: 'Escaped \\{literal\\} braces and `inline {code}`.\n\n```js\nimport example from "synthetic";\n```',
  markdownBytes: (bytes: number) => 'x'.repeat(bytes),
};
