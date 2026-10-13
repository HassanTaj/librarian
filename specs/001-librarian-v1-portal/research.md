# Research: Librarian v1

**Date**: 2026-10-11
**Status**: Planning decisions resolved; executable/live evidence is distinguished below.
**Inputs**: [specification](spec.md), [plan](plan.md), adopted constitution and agreed brief.
Research agents investigated runtime dependencies and authentication as required by the planning
skill; the primary agent inspected the copied scaffold and designed persistence/publication.

## Existing State and Migration Decision

**Decision**: Reuse the copied reader shell; replace its content and security paths together.
**Rationale**: lib/source.ts uses root-wide defineDocs MDX, its callers render a global tree and
static pages/metadata, and /api/search exposes a global source. At planning time Dockerfile copied
the repository and documentation assets into a public build. Those paths cannot serve private runtime catalogs safely.
**Alternatives considered**: Building every source into the app image conflicts with runtime
updates/private isolation; copying legacy infrastructure docs into fixtures exposes real content.

The actual sibling ../contabo/docs exists but contains documentation rather than the referenced
package/source app. Source preparation and real application-checkout provenance must be inspected
later. Local app files, package/lockfile, and container patterns were read directly and preserved.
No node_modules existed before planning. The planning command changed only planning files.

After planning, the owner requested removal of copied infrastructure MDX/navigation and Mintlify
configuration/assets. They have been removed; the Dockerfile no longer copies their image/logo folders,
and mdx-components.tsx retains standard Fumadocs components without the Mintlify compatibility wrappers.
The remaining empty static reader is scaffold only. Runtime loading and authorization remain planned;
cleanup does not implement dynamic documentation or complete a feature task.

Cleanup validation used an isolated temporary copy with the unchanged npm lockfile. Its production
build and Next TypeScript checks passed. The standalone server returned 404 for / and the removed
runtime/operations/state routes; scoped-to-the-empty-source search returned zero results. This proves
the empty copied scaffold still builds, not the planned runtime loader, private boundary or resource
budget. Temporary validation files were removed; concurrent local DEV-generated files were preserved.

## Dependency Decision

**Decision**: Keep compatible copied framework pins; add only runtime ingestion/auth/validation and
required testing tools. Package manifests were read from the official public npm registry on the
research date. Lockfile values match the existing six framework pins. No range or latest tag is
the intended application lock policy.

| Purpose | Exact planned pin | Evidence / reason |
|---|---|---|
| Framework | next 16.4.0; react/react-dom 19.3.0 | Existing lock; Next peer supports React 19; DOM requires matching React |
| Reader | fumadocs-core/ui 16.15.18 | UI requires that exact core; Next 16 and React >=19.2 |
| Runtime content | @fumadocs/local-md 0.3.5 | Core peers and transitive local-content fit 16.15.18 |
| Highlight/schema | shiki 4.5.0; zod 4.3.6 | Runtime highlighter and Fumadocs schema peer; no unnecessary version upgrade |
| Authentication | next-auth 5.0.0-beta.32; @auth/mongodb-adapter 3.11.3 | Same @auth/core 0.41.3; Next16/React19 peers; Mongo adapter requires driver 6 |
| Persistence | mongodb 6.21.0 | Official driver and adapter-compatible major; avoid incompatible driver 7 |
| Safe parsing | unified 11.0.5; remark-parse 11.0.0; remark-mdx 3.1.1; yaml 2.9.1 | Parse-only syntax recognition, strict bounded YAML, no repository compilation |
| Types/styles | typescript 5.9.3; tailwindcss/@tailwindcss/postcss 4.3.3 | Existing copied pins retained; existing @types pins retained unless a compile check requires change |
| Test/coverage | vitest/@vitest/coverage-v8 5.0.3; vite 8.3.4 | Matching versions; Node22.17 meets manifest engines |
| Source remap/merge | ast-v8-to-istanbul 1.0.5; @vitest/istanbul-lib-coverage 1.0.2 | Already provider-compatible dependencies; exact pins make the coverage pipeline reproducible |
| Client coverage | @vitest/browser-playwright 5.0.3; @vitest/browser 5.0.3 | Matching Vitest provider; actual browser code instrumentation, not fictitious SSR coverage |
| End-to-end | @playwright/test 1.64.0 | Required real browser journeys; provider uses matching Playwright via installed dependency |
| Lint | eslint 9.39.5; eslint-config-next 16.4.0 | Compatible with existing React lint plugin peers; avoid latest ESLint10 upgrade |

Official manifests: [Next](https://registry.npmjs.org/next/16.4.0),
[React DOM](https://registry.npmjs.org/react-dom/19.3.0),
[Fumadocs core](https://registry.npmjs.org/fumadocs-core/16.15.18),
[Fumadocs UI](https://registry.npmjs.org/fumadocs-ui/16.15.18),
[local-md](https://registry.npmjs.org/@fumadocs/local-md/0.3.5),
[Shiki](https://registry.npmjs.org/shiki/4.5.0),
[Zod](https://registry.npmjs.org/zod/4.3.6),
[Auth.js](https://registry.npmjs.org/next-auth/5.0.0-beta.32),
[adapter](https://registry.npmjs.org/@auth/mongodb-adapter/3.11.3),
[Mongo](https://registry.npmjs.org/mongodb/6.21.0),
[Vitest](https://registry.npmjs.org/vitest/5.0.3),
[coverage](https://registry.npmjs.org/@vitest/coverage-v8/5.0.3),
[Vite](https://registry.npmjs.org/vite/8.3.4),
[converter](https://registry.npmjs.org/ast-v8-to-istanbul/1.0.5),
[merger](https://registry.npmjs.org/@vitest/istanbul-lib-coverage/1.0.2),
[browser provider](https://registry.npmjs.org/@vitest/browser-playwright/5.0.3),
[Playwright](https://registry.npmjs.org/@playwright/test/1.64.0),
[ESLint](https://registry.npmjs.org/eslint/9.39.5),
[Next lint](https://registry.npmjs.org/eslint-config-next/16.4.0).
Node22.23.3 LTS appears in the [official release index](https://nodejs.org/dist/index.json);
production image tag/digest and package advisories must be rechecked at implementation time.

**Alternatives considered**: Latest framework/TypeScript/ESLint/Mongo majors add no requested value.
Stable Auth.js v4 supports the framework peers but requires a different integration; choose documented
v5 APIs with an exact prerelease pin and explicit build/login proof. Do not hide that prerelease risk.

## Runtime Markdown and Search

**Decision**: Authorized immutable directory -> localMd with include restricted to Markdown and
approved meta.json -> dynamicLoader with repository base URL -> await loader.get(). Renderer API is
page.data.load(), then renderer.render(allowlistedComponents), then render returned body ReactNode.
Configure trusted AST transforms through mdOptions.remarkPlugins/rehypePlugins; preserve a bounded
cache by repository/generation. Standard Fumadocs tree/page/search components remain.
**Rationale**: Bundleless runtime loading fits the agreed architecture. The published default also
accepts MDX and other JSON; explicitly overriding it and validating ingestion are mandatory.
**Alternatives considered**: Build-time fumadocs-mdx, native executable MDX runtime, static exported
search, or hosted search conflict with requirements or add unnecessary services.
[Runtime integration](https://www.fumadocs.dev/docs/integrations/content/local-md),
[published declarations](https://unpkg.com/@fumadocs/local-md@0.3.5/dist/index.d.ts).

Use createFromSource behind the authorization boundary, with a generation-scoped source function
and live GET only. Never export its static index for private data. Search display filters cannot
grant access. The synthetic probe exercised the exact pinned GET interface.
[Search API](https://www.fumadocs.dev/docs/headless/search/orama).

## Content Validation

**Decision**: Validate before local-md sees a candidate. `.md` and `.mdx` are accepted; `.mdx` is
parsed as an MDX AST and permits Markdown/GFM plus only static `Info`, `Note`, `Warning`, `Columns`,
`Card`, `Steps`, and `Step` nodes. Component attributes must be literal strings, except literal
`Columns cols={1..4}`. Reject imports, exports, other expressions, unknown components/attributes,
all raw HTML, unsafe URL schemes, symlinks/submodules, and escaping/encoded paths. Preserve ordinary
GFM/autolinks, escaped literal braces and fenced/inline code in conformance tests. Ambiguous or unsafe
syntax is rejected, never compiled to discover its behavior.

Validate bounded YAML using parseDocument with strict/stringKeys/uniqueKeys, YAML1.2 core, no
custom/known tags or merges. Reject errors/warnings, explicit tags, anchors/aliases before conversion;
use maxAliasCount:0, depth/node/string bounds, allowlisted frontmatter keys, then emit canonical safe
frontmatter. The pinned Fumadocs reader uses yaml.parse, not gray-matter/JS engines. Metadata is bounded
JSON with validated existing page references/groups; no executable icons/modules. Missing title uses
first heading/filename fallback; optional frontmatter schema avoids rejecting plain Markdown.

Trusted remark transforms resolve document/link-definition/image paths to guarded routes, preserving
generation and anchors. External https/mailto links may be followed without server fetch; local images
only. No rehype-raw; supported raster/PDF/text types and explicit attachment disposition are in the plan.
**Rationale**: AST rendering does not itself provide a trust boundary, and a pure MDX grammar can
incorrectly reject legitimate Markdown. Required conformance/security fixtures prove the validator.
**Alternatives considered**: Regex-only filtering, arbitrary component imports, raw HTML sanitization
and remote image fetching are unnecessary for the agreed safe-content product.

**Phase 3 update (2026-10-13)**: The original Markdown-only `.mdx` policy rejected static Fumadocs
components present in the source docs. `.mdx` now passes AST validation before runtime loading and
allows only the static `Info`, `Note`, `Warning`, `Columns`, `Card`, `Steps`, and `Step` components.
Unknown components/attributes, imports, exports, nonliteral expressions (except `Columns cols={1..4}`),
and raw HTML remain rejected. Local wrappers map the components to trusted Fumadocs UI; Card links are
rewritten through the selected catalog/generation route. This does not approve arbitrary MDX execution.
[Parse-only MDX package](https://mdxjs.com/packages/remark-mdx/),
[YAML controls](https://eemeli.org/yaml/),
[pinned frontmatter reader](https://unpkg.com/fumadocs-core@16.15.18/dist/content/md/frontmatter.js).

## Sessions and Current Roles

**Decision**: Official Mongo adapter with database sessions; a small adapter token-storage boundary
encrypts OAuth tokens server-side. Cookies contain only the official opaque session token; session
callback allowlists safe identity fields and does not expose tokens, raw claims or role lists.
Store issuer/subject/project-bound current roles and verifiedAt separately from session expiry.

At verifiedAt age >=900 s, synchronously query current active assignments for the authenticated
subject/configured project using ZITADEL ListAuthorizations, bounded complete pagination, the user's
server-held token, and the documented API audience. Renew expired OAuth tokens under a Mongo lease;
request offline_access, preserve rotation atomically, and deny on errors/incomplete results. An
unchanged signed token is not fresh proof of current grants. Use the same boundary for admin role
verification; librarian-admin never grants repository reading.
**Rationale**: Official sessions supply local revocation, and current assignment lookup can prove
role removal rather than recycling stale claims.
**Alternatives considered**: JWT session plus a custom vault duplicates session management; client
roles/layout-only checks and stale claim rereads violate the freshness/private boundary.
[Mongo adapter](https://authjs.dev/getting-started/adapters/mongodb),
[current assignments](https://zitadel.com/docs/reference/api/authorization/zitadel.authorization.v2.AuthorizationService.ListAuthorizations),
[API audience](https://zitadel.com/docs/guides/integrate/zitadel-apis/access-zitadel-apis),
[refresh rotation](https://authjs.dev/guides/refresh-token-rotation).

Validate actual deployed ZITADEL endpoint/audience/own-assignment support and role-removal semantics
in DEV before private release. If unsupported, stop for an explicit compatible architecture decision;
do not fall back silently to stale claims or add a service account.

## Browser Privacy and Logout

**Decision**: Server guard for every entry point before private cache access; no-store all
catalog-dependent responses, private prefetch disabled, hard document links for private reading,
and a trusted private-subtree lifecycle fence. Hide/scrub on pagehide/backgrounding and verification
deadline; restored documents reload/recheck before revealing; logout revokes local database session,
broadcasts and hard-replaces before browser provider end-session. Handle no-JS safely by leaving
protected subtree hidden and offering a safe explanation.
**Rationale**: Layout checks do not guard child payloads, and no-store alone does not defeat bfcache.
**Alternatives considered**: Relying only on HTTP headers, layout guards, router.refresh, or browser
cookie events leaves restoration paths unproven.
[Next authentication boundaries](https://nextjs.org/docs/app/guides/authentication),
[Chrome no-store bfcache behavior](https://developer.chrome.com/docs/web-platform/bfcache-ccns),
[provider logout endpoints](https://zitadel.com/docs/apis/openidoauth/endpoints).

Browser fence design remains a release test obligation; it has not passed three-browser proof here.

## Jobs, Leases and Publication

**Decision**: Durable unique job/receipt record before acknowledgement; single-catalog lease/fence
and publication pointer in the same Mongo document; immutable files renamed before pointer CAS.
Jobs always resolve current branch head, so late push notifications cannot replay an older commit.
Receipt tombstones preserve deduplication across restarts without retaining body/error payloads.
Finite admission quota prevents unbounded tombstone growth; no silent expiry/reacceptance.
**Rationale**: Mongo single-document conditional updates support atomic authoritative transitions
without assuming replica-set transactions. Job status can reconcile after a pointer-update crash.
**Alternatives considered**: Transactional cross-collection orchestration needs unverified topology;
process-local locks, separate lease/publication authority and blind pointer updates allow stale writes;
Git SHA lexical comparison cannot order commits.
This protocol is a project design inference, not a claim that Mongo supplies filesystem transactions.
[Mongo atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/).

GitHub signatures use original bytes and constant-time comparison. Fetch selected Git trees/blobs
read-only and fail truncated/incomplete traversal rather than publishing an incomplete snapshot.
Confirmed App access removal blocks serving; transport/rate-limit errors retain last-good content.
[Webhook signatures](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[Git trees](https://docs.github.com/en/rest/git/trees),
[Git blobs](https://docs.github.com/en/rest/git/blobs).

## Worker, Bounds and Measurement

**Decision**: Node instrumentation starts the worker once per server process with build/edge/test
exclusion and shutdown cancellation; catalog Mongo leases protect overlap. Native APIs and the
official driver suffice. All numeric policies and corpus/load pass criteria are fixed in the plan.
**Rationale**: Same-container operation and bounded memory/disk are requirements; measure before
raising them. The copied infrastructure image tag is not evidence of deployed Mongo compatibility.
**Alternatives considered**: A new queue service, dedicated worker, unlimited retries/caches or
unmeasured capacity increase are outside v1.
[Next instrumentation lifecycle](https://nextjs.org/docs/app/guides/instrumentation).

## Testing and Coverage

**Decision**: Vitest Node tests for logic and storage integration, instrumented Vitest browser tests
for client code, actual Next HTTP tests for async Server Components/metadata/handlers, and separate
Playwright full journeys across three engines. Explicit source inventory includes unexecuted files.
Generate one canonical coverage map, then global and C1-C6 raw-count totals for four independent gates.
**Rationale**: Vitest cannot directly render async Server Components; omitting them would violate
the constitution. Aggregate percentages cannot prove feature or security/recovery coverage.
**Alternatives considered**: Imported-files-only coverage, generated-bundle percentages, averaged
reports, exclusions or provider fixtures presented as live proof are unacceptable.
[Next Vitest limits](https://nextjs.org/docs/app/guides/testing/vitest),
[coverage inclusion](https://vitest.dev/guide/coverage.html),
[browser provider](https://vitest.dev/config/browser/playwright).

Try documented coverage.autoAttachSubprocess first. The pinned provider filters scripts before
remapping: admit local coverage-build .next server chunks as intermediate inputs, then filter after
remap to original first-party paths. Never accept .next as the final denominator.
[Subprocess option](https://vitest.dev/config/coverage.html#coverage-autoattachsubprocess),
[pinned provider](https://unpkg.com/@vitest/coverage-v8@5.0.3/dist/provider.js).

If that spike cannot preserve Next maps/offsets, collect the actual server with NODE_V8_COVERAGE.
Enable experimental.serverSourceMaps in the coverage-only local build. Production browser maps,
if needed for real browser collection, are also coverage-only and never published/served publicly.
Await graceful server shutdown and verify all process artifacts. v8.takeCoverage resets counters,
so merge every capture rather than retaining only the final one.
[Pinned Next types](https://unpkg.com/next@16.4.0/dist/server/config-shared.d.ts),
[browser maps](https://nextjs.org/docs/app/api-reference/config/next-config-js/productionBrowserSourceMaps),
[Node coverage](https://nodejs.org/docs/latest-v22.x/api/cli.html#node_v8_coveragedir),
[capture lifecycle](https://nodejs.org/docs/latest-v22.x/api/v8.html#v8takecoverage).

The fallback converter's published API takes exact executed JavaScript, parseAstAsync(code) from Vite,
coverage {url, functions}, sourceMap and verified wrapperLength; returns CoverageMapData.
Disk-loaded unwrapped scripts use offset zero; eval/wrapped code requires explicit offset verification.
Canonicalize original source paths and hashes, require compatible statement/branch maps, and use
createCoverageMap(...).merge(...) to combine Node/server/browser hit maps. Construct a map containing
each scope's canonical files and getCoverageSummary for that scope. Never sum report denominators.
[Converter API/limits](https://github.com/AriPerkkio/ast-v8-to-istanbul),
[converter declarations](https://unpkg.com/ast-v8-to-istanbul@1.0.5/dist/index.d.mts),
[merger API](https://unpkg.com/@vitest/istanbul-lib-coverage@1.0.2/dist/index.d.mts).

Stage 1's mandatory executable spike must prove:
- Async page, route handler, metadata and client guard map to actual original TS/TSX.
- Untaken branch, uncalled function and entirely untouched file remain uncovered.
- Real denied/private/admin paths contribute negative-path hits.
- One source loaded in Vitest and Next merges once, with identical source hash and compatible maps.
- Missing maps/process output, parsing failure, generated-only application identities or missing scope
  files fail; exact covered * 100 >= total * 95 determines the gate, before rounding.

Initial planning had not executed faithful mapping/merging. A failure requires correcting collection or
using compatible instrumented collection for affected paths; it cannot weaken coverage requirements.
V8's default-argument/post-throw limits also require behavioral assertions, not reliance on percentages.
Playwright Chromium V8 coverage may supplement client measurements, captured per navigation;
Firefox/WebKit still supply behavior tests. Do not assume coverage survives navigation.
[Playwright coverage](https://playwright.dev/docs/api/class-coverage).

### Implementation collection decision (2026-10-12)

The raw-V8 converter preserves original-source hits but produces incompatible function ranges
between Vitest, Next server and browser output. The strict merge rejected those reports.
The compatible instrumentation fallback uses @vitest/coverage-istanbul5.0.3,
@vitest/istanbul-lib-instrument1.0.0's public programVisitor, Babel core7.29.7 and
@jridgewell/remapping2.3.5. These are exact development pins, not production runtime dependencies.

The shared instrumenter runs before either compiler. Macro initializer counters are moved
immediately before the original declaration without removing hits. A coverage-only adapter
composes Fumadocs' macro map with the incoming instrumentation map; the installed macro loader
otherwise discards that incoming map. Original embedded content, SHA256 hashes and exact
statement/function/branch maps remain mandatory. Full file URLs preserve Windows source identity.
Coverage ignore comments fail instead of silently excluding runtime code.

The synthetic real-Next/Chromium/Node conformance test verifies async metadata, denied/admin
responses, browser interaction, uncalled/untaken/untouched code and a strict single-denominator merge.
It validates collection, not Librarian authentication. The inherited scaffold additionally retains
the raw-V8 original-source spike and verifies the compatible instrumented counters.
Explicit zero-hit inventory maps preserve files omitted by Vitest. A separate real instrumented
Node process tests executable configuration that Vitest itself excludes. All captures stay ignored.

The instrumenter's transitive Babel8 packages require Node22.18 or Node24.11. The current
system Node22.17 was left unchanged; an official Node22.18 Windows archive was checksum-verified
and extracted under ignored .local for validation. The declared engines now reflect the minimum.
Collection proof does not imply that global or C1-C6 coverage has passed; tasks.md records results.

## Executable Research Evidence and Remaining Gates

A disposable temporary npm project installed the 15 selected runtime packages with exact versions,
lifecycle scripts disabled, and no project edits. An assert-based Node probe passed:
- Markdown/GFM rendering through localMd and dynamicLoader.
- Scoped live search using createFromSource.
- A second immutable source generation changes rendering/search without rebuilding.
- Historical initial-probe behavior explicitly excluded MDX; the Phase 3 update above supersedes that
  policy with validated `.mdx` and the static Fumadocs component allowlist, while executable syntax remains rejected.
- Parse-only recognition of ESM/expression/JSX and preservation of fenced code examples.
- YAML aliases/anchors detected before conversion.

It used synthetic files only, no GitHub/Zitadel/Mongo credentials, and no real documentation bodies.
Dev-tool manifests were checked; dev tools were not installed in the application.
Full Next standalone build/externalization, actual-server coverage/remapping/merge, complete parser/link conformance, browser-cache privacy,
real Mongo fault tests, current-role API compatibility, performance, live DEV and rollback remain
implementation/release gates. No unexplained design decision remains; no live readiness is asserted.
