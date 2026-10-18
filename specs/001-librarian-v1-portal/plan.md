# Implementation Plan: Librarian v1 Git-connected Documentation Portal

**Branch**: `main` (unchanged; Spec Kit feature identifier: `001-librarian-v1-portal`)
**Date**: 2026-10-11 | **Spec**: [spec.md](spec.md)
**Input**: Complete v1 specification; [AGENTS.md](../../AGENTS.md),
[constitution v2.0.0](../../.specify/memory/constitution.md),
[agreed brief](../../docs/requirements/v1-requirements.md).
**Status**: Phase 0 research and Phase 1 design are complete. The 2026-10-13 Phase 3 update accepts
Markdown/GFM plus a static Fumadocs MDX component allowlist and fetches supported blobs only from the
configured docs subtree. Source provenance is verified: the clean local `contabo` checkout and
`origin/main` match the previously recorded DEV publication SHA `d82a7d26487af66f37d91cdea8e828f133564806`;
the `docs/` tree contains 90 regular, non-executable files (74 `.mdx`, 16 `meta.json`) within current
limits. The tree-metadata review did not reread document bodies or recheck live DEV. Current local gates
pass: 638 unit/integration/client tests, all global/C1-C6 four-metric coverage thresholds, 72/72
three-engine browser tests, typecheck, lint, artifact validation, production build, and local container
acceptance. T050, T079, T082, and T092 are complete. T086-T091 remain open for measured workload,
infrastructure revalidation, live DEV/recovery, and separately approved publication/deployment. No
production operation is claimed.

## Summary

Deliver the complete five-story portal in the six agreed stages. Retain the copied Next.js/Fumadocs
shell and standard reader components, but replace build-time repository-wide MDX compilation and
global search with authorized per-repository immutable runtime generations. MongoDB stores catalogs, durable jobs,
leases, and server identity/session state. A worker in the application container performs bounded
read-only GitHub ingestion. No additional queue/search service or dedicated worker deployment.

The design artifacts define the implementation tracked in [tasks.md](tasks.md). Local application and
test files have since been implemented and validated; no branch, commit, image publication,
credential provisioning, sibling-repository edit, or deployment is included in that local evidence.

## Technical Context

**Language/Version**: TypeScript 5.9.3; planned Node 22.23.3 LTS production baseline. Local research
probe used the available Node 22.17.0 / npm 10.9.2; it did not upgrade the machine.

**Primary Dependencies**: Retain Next 16.4.0, React/React DOM 19.3.0, Fumadocs core/UI 16.15.18.
Add local-md 0.3.5, Auth.js 5.0.0-beta.32, Mongo adapter 3.11.3 and Mongo driver 6.21.0.
Exact parser, styling, and test pins and peer constraints are in [research.md](research.md#dependency-decision).
Remove build-time fumadocs-mdx only during implementation after its callers are replaced.

**Storage**: Existing MongoDB, dedicated database/scoped user, primary acknowledged journaled writes;
immutable validated files on a persistent volume outside public. Single-document conditional
updates carry authoritative publication and lease state; no replica-set transactions assumed.
Existing infrastructure manifest uses mongo:latest, so deployed version/topology remains a live
revalidation prerequisite. Selected query features require server >=5.0 and driver-supported version.

**Testing**: Vitest 5.0.3 + coverage-istanbul 5.0.3, shared original-source instrumentation
through @vitest/istanbul-lib-instrument 1.0.0 and Babel core 7.29.7; Vite 8.3.4.
Coverage-v8 5.0.3 and the raw-V8 converter remain for the retained mapping spike.
The instrumenter's Babel 8 dependency raises local test minimums to Node22.18 / Node24.11;
an ignored, checksum-verified portable Node22.18 runtime was used without upgrading system Node.
Playwright 1.64.0 across Chromium,
Firefox, WebKit; actual isolated MongoDB and filesystem integration tests. DOM tests use the
browser provider specified in research. Provider fixtures in CI plus separately recorded live DEV proof.

**Target Platform**: Linux standalone Next server and worker in one container; local Windows DEV
supported; one Swarm replica on the persistent-volume node, initial 0.5 CPU / 512 MB.

**Project Type**: Separate application repository, retaining root app/ and lib/ convention.

**Performance Goals**: Under the corpus/load below, warm directory/article p95 <=2 s, scoped
search p95 <=1 s, durable webhook acknowledgement p95 <=2 s with a deliberately blocked worker;
valid 500-page update published <=120 s with healthy fixture upstream. These are acceptance targets,
not measured production claims. Cold first read <=5 s; no correctness or security errors.

**Constraints**: Exact >=900-second role deadline; authorization before private cache access;
bounded policies below; explicit public approval; no source execution or private image optimization.
Functional work and complete v1 meet all four independent 95% gates; isolated presentation-only
changes follow the Principle V exception.

**Scale/Scope**: Complete v1; initial maximum 20 catalogs. Representative performance corpus: three
catalogs (one public, two separately private), 500 pages + 100 assets each, 50 KiB average Markdown,
10 MiB aggregate assets per catalog, nested paths and identical cross-project terms. Ten simultaneous
readers at two requests/second each for 15 minutes, mixed article/search/assets, with one simultaneous
ingestion and a restart exercise. Maximum-bound corpus tests are separate from average-load tests.

## Constitution Check

Gate assessments apply to this design, not to the inherited scaffold or unexecuted release evidence.

| Principle | Before research | After design / required proof |
|---|---|---|
| I. Git is source of truth | PASS: no editor/source writes; full brief scope retained | PASS: GitHub read-only ingestion; runtime generations; six stages |
| II. Private authorization boundary | PASS: common server checks required for every path | PASS: identity/project/reader checks, exact freshness, cache/browser fence, owner approval; ST-01-04,10,13 required |
| III. Untrusted content | PASS: bounded parsing, no source-code execution | PASS: allowlisted static MDX AST plus YAML/path/type validation, original-byte signature, scoped tokens/secrets; ST-05-06,10-13 required |
| IV. Recoverable generations | PASS: immutable candidate, fenced conditional publication | PASS: durable jobs, per-catalog lease, current-ref resolution, restart reconciliation; ST-06-09,11 required |
| V. Tests and 95% | PASS: functional tests and all four full-v1 thresholds retained; presentation-only exception recorded | PASS: global and every functional capability scope, unexecuted files and anti-gaming rules; current global/C1-C6 gates pass |
| VI. Standard accessible reader | PASS: reuse copied Fumadocs layouts/components | PASS: standard tree/search/page controls plus only required catalog/auth adapters; three-browser and responsive proof pass locally |
| VII. Bounded/reversible operations | PASS: budget, scoped approvals and existing services | PASS: explicit limits/workload/retention and DEV/recovery/rollback gates; no live readiness asserted |
| Architecture/workflow | PASS: agreed stack and ownership unchanged | PASS: no added service, no silent alternative stack, infrastructure changes deferred to its repository |

The inherited build-time MDX/global search/image-copy paths do not satisfy v1. Runtime `.mdx` is
validated as an AST and permits Markdown/GFM plus the static `Info`, `Note`, `Warning`, `Columns`,
`Card`, `Steps`, and `Step` component allowlist. Only literal strings are accepted as component
attributes, except `Columns cols={1..4}`; imports, exports, dynamic expressions, unknown components
or attributes, and unsafe HTML remain rejected under the constitution. A failing executable spike or release check
blocks the affected stage; neither coverage exclusions nor a complexity table may waive it.

## Project Structure

### Documentation (this feature)

    specs/001-librarian-v1-portal/
      spec.md
      plan.md
      research.md
      data-model.md
      quickstart.md
      contracts/http.md
      checklists/requirements.md

tasks.md is deliberately absent; task generation follows this plan in a separate command.

### Source Code (repository root)

Planned files, not files created by this command:

    app/
      page.tsx
      layout.tsx
      [repoSlug]/[[...page]]/{page,layout,loading,error,not-found}.tsx
      api/search/[repoSlug]/route.ts
      api/assets/[repoSlug]/[...path]/route.ts
      api/webhooks/github/route.ts
      api/auth/[...nextauth]/route.ts
      api/admin/repos/route.ts
      api/admin/repos/[id]/route.ts
      api/admin/repos/[id]/sync/route.ts
      api/health/route.ts
      admin/{page,loading,error}.tsx
    components/{directory,project-selector,private-content-guard,catalog-form,sync-status}.tsx
    auth.ts
    lib/
      layout.shared.tsx
      catalog.ts
      mongo.ts
      limits.ts
      auth/{adapter,authorization,roles,tokens}.ts
      content/{source,validate,paths,generations,search,assets}.ts
      sync/{github,webhook,jobs,worker}.ts
      operations/{health,logging}.ts
    instrumentation.ts
    tests/{unit,integration,browser,fixtures}/
    scripts/{check-coverage,measure-workload,validate-artifacts}.mjs
    {vitest,playwright}.config.ts
    eslint.config.mjs
    lib/config.ts
    .env.example

**Structure Decision**: Keep the existing root app/lib layout and direct official Mongo driver.
No generic repository/service framework. Node instrumentation starts one bounded worker loop per
server process; Mongo catalog leases serialize overlapping instances. No worker during build,
static analysis, edge runtime, or tests unless explicitly enabled by the test harness.
At implementation time, centralize and validate the exact server runtime variables in lib/config.ts;
document placeholder names only in .env.example. Builds and fixture tests must not require live
credentials. Local secret files are ignored and excluded from Docker build context.

### Existing Files and Callers Affected Later

| Current path | Current behavior | Planned migration and callers |
|---|---|---|
| lib/source.ts | defineDocs scans root MDX with one global loader | Replace with guarded generation source in lib/content/source.ts; update page, layout, metadata and search together |
| app/[[...slug]]/page.tsx | Global MDX body and generateStaticParams | Replace catch-all with repoSlug route; remove static generation; guard page and metadata independently |
| app/[[...slug]]/layout.tsx | Global pageTree | Authorized selected-generation tree; safe selector is independent of private tree |
| app/api/search/route.ts | Unguarded createFromSource(global source) | Remove global handler; guarded per-repo live search only, no downloadable indexes |
| app/layout.tsx, lib/layout.shared.tsx, app/globals.css | Standard provider/layout/themes | Reuse; safe global branding, repository search endpoint and guarded private subtree |
| mdx-components.tsx | Standard Fumadocs components; copied Mintlify compatibility wrappers removed during cleanup | Add only static allowlisted presentation adapters; rewrite Card links through the selected generation route; no remote MDX execution |
| next.config.mjs | createMDX build plugin, standalone output | Retain standalone; remove MDX build plugin; verify runtime externalization for local-md/shiki |
| package.json, package-lock.json, tsconfig.json | Build/start only, no test/auth/job setup | Exact pins, test/lint/typecheck/coverage scripts; preserve strict types and aliases |
| Dockerfile, .dockerignore | COPY .; copied images/logo publication removed during cleanup | Explicit app build-context allowlist; trusted original branding only; no source documents/snapshots/fixtures/secrets in image |
| Copied root MDX, runtime/, operations/, state/, navigation metadata and Mintlify files/assets | Removed from this application at owner request after planning | Keep documentation in source repositories; never recreate copied material as fixtures or static portal content |
| .gitignore | Initial repository ignore rules now present | Extend for application-specific generated/private state before implementation; no secret values in examples |

The available sibling reference is under ../contabo/docs; no package/source app was found there.
The local copied app has been inspected directly. Do not invent a sibling Next.js checkout or copy
private infrastructure contents into tests; reusable application provenance is a later inspection item.

## Phase 0: Research Decisions

See [research.md](research.md) for decisions, alternatives, exact source manifests, and probe evidence.
Resolved: dependency selection, runtime loader API, session/role strategy, content parser, bounded
limits, single-document publication/fencing, queue deduplication, browser-cache strategy, and test scopes.

Verified during planning: exact runtime dependencies installed with lifecycle scripts disabled in
an isolated temporary directory; synthetic Markdown/GFM rendering, scoped search, generation switching
without build, initial MDX exclusion, parse-only expression/JSX/ESM recognition, and YAML alias detection
passed assertions. The Phase 3 update replaces MDX exclusion with validated AST support for the narrow
static component allowlist. This is not a private-boundary proof.

## Phase 1: Design

### Reader and Authorization Flow

Every page, overview, layout tree, metadata function, search handler, asset handler, and admin
operation invokes server authorization independently or uses memoization strictly within one request.
Never rely on layouts, proxy/middleware, browser role flags, or global cached authorization.

For each protected request:
1. Read current catalog and validate enabled/access state, requested path, configuration revision.
2. Resolve a valid opaque database session; verify configured issuer/subject/project and required role.
   Refresh current assignments when verifiedAt age >=900 seconds; refresh/token lease failure denies.
3. Select a published/retained generation valid for that configuration and atomically pin it while
   its slot remains selectable. Recheck authorization/configuration before first content bytes.
4. Only then obtain its cached loader/search or open the validated asset. Release the pin on completion.
   Role permission is never part of a shared public-content cache.

Send catalog-dependent HTML/RSC, search, metadata and assets with private, no-store.
Use hard document navigation for protected reader links and disable private prefetch; root branding
and code bundles contain no repository bodies. Private UI starts hidden until the trusted guard is
active, hides/scrubs on pagehide/backgrounding and role verification expiry, and reloads before revealing
a restored/foregrounded document. Logout deletes local session first, broadcasts to tabs, clears private
state, and hard-replaces the document; provider end-session failure cannot undo local logout.
Actual bfcache behavior and internal Fumadocs link overrides must pass three-browser tests.

### Ingestion and Publication Flow

Use native fetch/crypto and GitHub REST App tokens, not a Git checkout or repository execution.
Resolve the current configured branch head under a per-catalog lease rather than trusting the
chronological order of webhook commit hashes. Traverse only the selected documentation tree;
fetch immutable blobs by SHA and reject truncated/incomplete tree responses.

Insert a unique durable job before acknowledgement. Workers query pending work in bounded batches;
claim the catalog lease atomically, increment its monotonic fence, validate all files, and persist
a complete manifest before atomically renaming staging into the final immutable directory.
The catalog publication update matches owner, fence, nonexpired lease, config revision, enabled/access
state, and expected publication revision in one document. A stale worker cannot change that pointer.
Job terminal status follows publication and is reconciled from its published job/fence after crashes.
Late/duplicate notifications resolve current head and cannot regress a newer publication.

See [data-model.md](data-model.md) for state transitions, indexes, crash reconciliation, read pins,
quota reservations, and configuration/publication approval rules; [HTTP contracts](contracts/http.md)
define request/response behavior.

### Initial Finite Policies

These constants are declared in lib/limits.ts during implementation, tested at the boundary,
and changed only with documented workload evidence. No dynamic tuning UI is added.

| Policy | Initial bound and failure outcome |
|---|---|
| Catalogs | 20 configured catalogs; excess admin creation rejected |
| Snapshot payload | 1,000 supported files total; <=500 `.md`/`.mdx` pages; <=50 MiB normalized bytes including metadata/manifest |
| Individual inputs | `.md`/`.mdx` page <=256 KiB; frontmatter/meta.json <=16 KiB each; asset <=5 MiB; decoded path <=1,024 UTF-8 bytes and <=32 segments |
| Syntax structure | YAML/navigation nesting <=8; AST <=50,000 nodes/page; no aliases/anchors/tags; at most 16 allowlisted highlighted code languages, otherwise plain text |
| Content selection | Import `.md`/`.mdx` Markdown/GFM and allowlisted static component pages, `meta.json`, and supported assets only; omit unrelated regular file types. Reject imports/exports, dynamic expressions, unknown components/attributes, unsafe HTML, symlinks/submodules, and executable Git modes |
| Asset types | PNG/JPEG/GIF/WebP inline; PDF/TXT/CSV/JSON attachment only with safe MIME and nosniff. Reject SVG/HTML/JS and unsupported assets |
| Delivery inputs | Webhook <=1 MiB raw body; installation removal event <=1,000 repository references; admin JSON <=32 KiB; search query <=256 UTF-8 bytes, <=20 results; OAuth token response <=64 KiB and role page <=512 KiB; asset/read request timeout <=30 s |
| Work | One ingestion at a time per instance and one lease holder per catalog; GitHub fetch concurrency 2; recursive Git tree response <=7,000,000 bytes; upstream call timeout 15 s; complete attempt deadline 120 s |
| Lease/recovery | Catalog lease 30 s, heartbeat 10 s, server-time expiry and fence; queue discovery idle 5 s / active 1 s; crashed work recoverable <=45 s after last heartbeat with healthy storage |
| Retry | At most 5 attempts, delays 5/20/60/180 s; rate-limit Retry-After respected up to 1 h, otherwise terminal readable failure requiring manual resync |
| Durable receipt quota | <=100,000 admission reservations per catalog lifetime; unique job/receipt ID never evicted automatically. Terminal details compact after 14 days into replay tombstones; quota exhaustion rejects new work without purging dedupe evidence |
| Admission rate | <=60 valid work-admission attempts/minute/catalog; invalid signatures never consume durable jobs; duplicate IDs return their stored outcome |
| Snapshot retention | At most 3 committed snapshot slots + 1 staging slot/catalog. Keep active and up to two previous; previous grace 5 min and max age 24 h measured from server-set retiredAt; never remove pinned snapshots |
| Retention pressure | If no reclaimable slot, delay/retry then fail safely; never delete active/in-flight content or publish without a slot. Abandoned staging cleaned after fenced lease expiry |
| Read pins | <=64 concurrent request pins/catalog; pin lifetime 60 s; requests end within 30 s. New pin requires selectable current/retained generation and current config |
| Loader/search cache | Combined maximum 4 repository/generation entries, <=96 MiB measured serialized input/index budget, LRU idle expiry 5 min; no auth/session cache shared across users |
| Persistent payload | <=200 MiB/catalog (3 committed + staging); <=4 GiB total portal payload with 20 catalogs; manifest/small control overhead included in the 50 MiB generation bound |
| Sessions/permissions | Session absolute expiry 8 h; current-role query timeout 5 s, <=10 pages of 100 assignments; incomplete pagination denies; role/token refresh lease 10 s, contender waits <=2 s then denies |

If parser/index expansion exceeds the resource envelope, bound measured retained objects and evict
inactive entries earlier; a byte estimate is not proof of heap use. Three-browser privacy and workload
targets may not be relaxed merely to make a prototype pass. All rejected candidate errors retain
the last valid compatible publication; confirmed access loss instead disables delivery.

### Test, Coverage, and Completion Design

Every functional change requires automated acceptance tests; every functional bug fix requires a
regression that fails before its fix. Isolated presentation-only changes that preserve behavior and
data flow require no new tests or coverage work, and test work stays deferred unless the owner asks.
Required v1 behavior scenarios are ST-01 through ST-14 in [spec.md](spec.md).
Integration uses real Mongo job/lease boundaries and filesystem operations; CI upstream fixtures
mock external providers only, not the authorization/publication logic under test.

Global coverage scope is all first-party executable root app/**/*.ts(x), components/**/*.ts(x),
lib/**/*.ts(x), auth.ts, instrumentation.ts, executable configuration, and scripts/*.mjs.
Unexecuted files are included. Only generated, third-party, test code and purely declarative files
may be excluded with documented reasons; no runtime ignore annotations, skipped required tests,
placeholder assertions, blanket mocks, retrying away failures, or auto-updated thresholds.

Async Server Components cannot be faithfully covered by direct Vitest rendering. Stage 1 must prove
coverage from the actual Next HTTP server as well as Vitest Node/client-browser tests. Try Vitest's
autoAttachSubprocess first with the coverage-only .next server bundles admitted as intermediate
inputs and excludeAfterRemap; require canonical original first-party TS/TSX identities after remapping.
If this cannot preserve exact executed code/maps, capture the spawned server with NODE_V8_COVERAGE
and use the pinned converter/merger described in research. Await graceful shutdown and collect all
captures; missing server output fails. Coverage-only builds enable server source maps locally and
are never published; normal production builds do not expose browser maps.

The early spike must prove an async page, route handler, metadata function and client guard map to
original sources; an uncalled function, untaken branch and untouched file remain uncovered; denied
paths add real hits; and one source loaded in both runners merges once. Verify matching source
hashes and compatible statement/branch maps. Mapping/merge failures block the stage, rather than
dropping application files or reporting generated-bundle percentages. Merge hit maps, not report
denominators; compare exact covered * 100 >= total * 95 before display rounding.

The following overlapping scopes define each staged capability's implementation file set. Any new
runtime file must be assigned to at least one scope and included globally; shared files remain in
every affected scope. The coverage checker compares source inventory with coverage keys and scope
membership, then aggregates raw covered/total counts separately for statements, branches, functions,
and lines (not averages of file percentages).

| Scope | Implementation file set | Acceptance evidence |
|---|---|---|
| C1 Discovery/reader | app/page.tsx, app/loading.tsx, app/[repoSlug]/**/*.tsx, app/layout.tsx, components/{directory,site-navigation,runtime-sidebar}.tsx, components/project-selector.tsx, components/project-search.tsx, components/sync-status-badge.tsx, lib/layout.shared.tsx, lib/catalog.ts, lib/content/source.ts | US1; ST-12; SC-001-002 |
| C2 Authorization | auth.ts, app/api/auth/**/*.ts, lib/auth/**/*.ts, app/page.tsx, components/private-content-guard.tsx, lib/catalog.ts, all protected app/[repoSlug] handlers/functions | US2; ST-01-03,10,13; SC-003-004,010 |
| C3 Navigation/search/assets | lib/content/**/*.ts, app/api/search/**/*.ts, app/api/assets/**/*.ts, repo reader files, runtime sidebar, project selector and project search | US3; ST-04-05,11-12; SC-005 |
| C4 Synchronization/recovery | lib/sync/**/*.ts, lib/content/{validate,paths,generations,blob-cache}.ts, lib/{mongo,catalog,limits,public-approvals}.ts, instrumentation.ts, app/api/webhooks/**/*.ts | US4; ST-05-09,11,13; SC-006-008 |
| C5 Administration | app/repositories/**/*.tsx, app/loading.tsx, app/page.tsx, app/api/admin/**/*.ts, components/{catalog-form,sync-status,admin-console,directory,site-navigation}.tsx, components/sync-status-badge.tsx, lib/{admin,catalog,public-approvals}.ts, lib/auth/**/*.ts, lib/sync/jobs.ts, lib/content/generations.ts | US5; ST-09-11,12-13; SC-009-010 |
| C6 Packaging/operations/tooling | lib/operations/**/*.ts, app/api/health/**/*.ts, instrumentation.ts, next.config.mjs, mdx-components.tsx if retained, executable test/lint config, scripts/*.mjs, shared startup/config code | ST-11,13-14; SC-012-014 |

### Documentation Directory Sync Actions

`app/page.tsx` sends safe catalog metadata, publication availability, and the latest sanitized sync
status to `components/directory.tsx`. Only a server-verified `librarian-admin` session receives the
selection checkboxes and individual/batch sync controls. The directory toolbar filters titles and
submits 1 to `LIMITS.maxCatalogs` unique catalog UUIDs to `POST /api/admin/repos/sync`; the route
requires the existing session-bound CSRF/origin checks and a UUID `Idempotency-Key`, then admits one
existing per-catalog manual job for each selected source. Inputs are bounded by the current admin JSON
limit; output is one status/error per catalog, preserving partial admission results and sanitizing
unknown persistence errors. It adds no batch collection, worker, service, dependency, or Mongo migration.

`Catalog.lastSuccess` controls first-publication availability. A catalog with no successful publication
is rendered as a non-navigable card; a later failure leaves an existing compatible published generation
readable while the card reports the latest failed status. Status polling uses the existing protected
admin catalog summary endpoint; per-card icons animate only while a job is pending/running. Accepted
requests use a ten-second info notice, and failures expose a collapsed error with a safe description
and issue code. Non-admin directory responses contain only the safe card/status projection.

Mandatory verification is in `tests/client/directory.test.tsx` and
`tests/unit/directory-sync-route.test.ts`, with directory/browser coverage in
`tests/browser/discovery-reader.spec.ts` and `tests/browser/admin.spec.ts`. Run the targeted Vitest
projects, `npm run typecheck`, `npm run lint`, `npm run build`, and the full global/C1/C5/C6 95% gates;
the three-engine browser suite remains an acceptance gate. No schema migration or published state is
introduced: code rollback removes the directory controls/endpoint while already admitted jobs remain
valid under the existing durable job contract. Never delete jobs or published generations to roll back.

CI independently requires **>=95% statements, >=95% branches, >=95% functions, >=95% lines**
globally AND for C1-C6 as each scope gains executable files. Missing instrumentation, reports,
source membership or an empty suite fails. A truly zero-denominator metric may be not applicable
only with an explicit recorded reason. Establish scope enforcement with the first executable feature,
not after the complete portal. The checker itself receives nontrivial unit/self-check tests.

### Administration Removal Follow-up

The repository card is collapsed by default. Edit expands the current settings form; Repository type
is Private or Public. Delete requires a browser confirmation and sends the catalog's `updatedAt` as
If-Match through the existing admin/CSRF boundary. MongoDB atomically removes the catalog only when
its worker lease is null and no reader pin is live; the subsequent UUID-bound content cleanup checks
realpath containment. A repeated delete can finish cleanup after the catalog row has already gone.
The permanent `syncJobs`/`controlReceipts` and monotonic create-quota records remain; a worker cancels
queued jobs whose catalog no longer exists. Stale versions or active operations return a retryable
409 without removing configuration. If cleanup fails after row removal, retrying the same ID is the
recovery path; recreation is possible from the GitHub source after approval/validation.

Affected implementation files belong to C5, with `lib/content/generations.ts` also retained in its
existing C3/C4 scopes and coverage-checker changes in C6. Validate admin integration plus client/browser
editor behavior, the C3-C6 and global four-metric coverage gates, typecheck, lint, production build, and
artifact/link validation.
No remote database or deployment action is part of this local feature change.

Required planned scripts and executable validation procedures are in [quickstart.md](quickstart.md).
No commands absent from current package.json are represented as already runnable today.

### GitHub Source Selection and Phase 3 Correction — 2026-10-13

The importer resolves the configured branch to a commit, walks only the tree path in `docsPath`,
then requests the recursive tree for that subtree and fetches selected blobs by immutable SHA. It
does not clone or download the repository archive. Keep this boundary: only supported Markdown,
MDX, navigation metadata, and asset blobs are fetched; unrelated regular files such as docs-tool
configuration are omitted. Non-regular Git entries, executable modes, unsafe paths, unsupported
MDX syntax, and oversized supported files still fail the candidate and preserve the last generation.

Fumadocs `@fumadocs/local-md` supports `.mdx` at runtime. Since its MDX compiler generates code,
Librarian validates the full MDX AST before the runtime loader. Static `Info`, `Note`, `Warning`,
`Columns`, `Card`, `Steps`, and `Step` nodes are mapped to trusted local components; only literal
string attributes are accepted, except literal `Columns cols={1..4}` values. Imports, exports,
other expressions, unknown components or attributes, and raw HTML are rejected. Card document links
are rewritten to the selected catalog and generation route. This preserves the untrusted-content
boundary without converting safe pages to `.md` or executing source-repository code.

The clean local `HassanTaj/contabo` checkout has `HEAD` and `origin/main` at
`d82a7d26487af66f37d91cdea8e828f133564806`, matching the previously recorded DEV publication commit.
Its `docs/` Git tree is `7406cc078d8c9496b99f6d800e578d3a06e49bd5` and contains 90 regular,
non-executable files (74 `.mdx`, 16 `meta.json`; 533,252 bytes total). The largest MDX is 92,925 bytes;
the largest metadata file is 460 bytes. No other extensions or canonical-path violations were found.
The counts fit the existing 500-page, 1,000-file, 50 MiB snapshot and 256 KiB page limits, so no limit
increase is justified. This was a tree-metadata audit; document bodies were not reread and the live DEV
service was not rechecked. The previously recorded successful sync is evidence for the same SHA.
The GitHub recursive-tree endpoint itself
is capped at 100,000 entries and 7 MB; truncated trees must continue to fail safely.

#### Phase 3 Contract and Verification

Inputs are the selected branch commit and configured `docsPath`; output is a validated candidate
containing only `.md`/`.mdx`, `meta.json`, and supported assets below that subtree. No new package or
Git checkout is required: the existing GitHub tree/blob API reads the selected subtree, and the
installed `remark-mdx` parser validates MDX before the existing Fumadocs runtime loader compiles it.
`Info`, `Note`, `Warning`, `Columns`, `Card`, `Steps`, and `Step` are the only JSX components; string
attributes are static, with constant 1–4 expressions only for `Columns.cols`. Safe root-absolute and
relative document links resolve inside the catalog, and Card links retain the selected generation.
Unsupported files are skipped; oversized supported files, bad Git modes, tree truncation, invalid
paths, unknown components/attributes, imports, exports, dynamic expressions, raw HTML, invalid links,
or any invalid page fail the candidate. Publication stays atomic, so a failed sync leaves the current
generation untouched.

Affected implementation and verification scope: `lib/sync/github.ts`, `lib/content/{validate,paths}.ts`,
`mdx-components.tsx`, the repository reader, admin sync UI/errors, and their unit/integration/browser
tests. These functional changes fall in C3/C4/C5; the four independent 95% thresholds still apply. Focused commands
are `node node_modules/typescript/bin/tsc --noEmit` and
`node node_modules/vitest/vitest.mjs run --project unit tests/unit/content-validation.test.ts tests/unit/paths.test.ts`;
full coverage, lint, build, and browser gates remain separate. No versioned deployment or operational
rollback is in scope; code rollback to the prior grammar is local and failed candidates are not published.

### Responsive Directory and Repository Console UX — 2026-10-13

The UI administration route is `/repositories`; `/api/admin/...` remains the API prefix. The directory
toolbar keeps search and batch sync controls centered vertically with space between them;
its outlined Sync button shows the sync icon, selected-source count badge (including zero), and active
sync state. Cards place a circular selection control at upper left with the same 1px theme border as the
card, a status badge at lower left, and a smaller icon-only sync button at upper right with no visible
circle around the icon; its icon spins while the request queues and while status is pending or running.
Public/Private
labels stay beside or below a wrapping title. Shared navigation supplies Home and Repositories;
the Fumadocs reader controls must wrap cleanly on narrow screens. Failed-first-sync cards stay disabled
and show their sanitized expandable issue. Admin cards use circular actions at upper left, a lower-left
status badge, read-only details before editing/deleting, and shortened commit IDs with the complete value
available as a tooltip. The Configure form uses a bottom description textarea and ordered visibility field;
successful creation closes it and refreshes the list, while a failure leaves it available with a collapsible
error banner. The homepage and `/repositories` skeletons each show three consistent cards, keep sync status
at the bottom left, and contain no error placeholders, catalog metadata, or private content. Reader
skeletons contain no private content.

Affected files: `components/directory.tsx`, `components/admin-console.tsx`,
`components/site-navigation.tsx`, `app/page.tsx`, `app/repositories/page.tsx`, the directory/admin/reader
`loading.tsx` boundaries, `app/[repoSlug]/[[...page]]/page.tsx`, and their unit/client/browser tests.
Inputs and outputs remain the existing safe directory DTO, catalog summaries, sync-status APIs, and form
responses; no package, persistence model, or authorization boundary changes are required for this UX.
Behavior-changing work retains regression coverage for batch/per-card sync status, Configure
success/failure, edit/delete, mobile controls, and route skeleton boundaries. The current directory
polish changes only how existing selection state, count, buttons, status, and active sync feedback are
presented; it does not change synchronization, Configure, edit/delete, or authorization behavior. Per
Card sync icons use a 20px status-colored icon, start muted while a request is being queued, and spin
while sync is pending or running. Principle V defers tests for this presentation-only slice until the
owner asks. Existing functional behavior tests and full v1 gates remain required for their respective
work. A failed configuration save preserves persisted catalog state; a failed sync keeps the prior
published generation. Rollback is a local UI/code revert and requires no database recovery.

### Implementation Sequence and Handoff

| Stage | In-scope future implementation | Exit gate |
|---|---|---|
| 1 | Repair app/packaging boundaries; exact deps and synthetic fixtures; directory/reader/scoped navigation/search/assets; functional tests and coverage | Runtime/bundling/parser and original-source coverage/merge proof, public fixture journeys, accessible UI; no copied private docs in build |
| 2 | Auth.js database sessions, current-project role verification, guard every delivery/metadata/cache path, browser fence | Full ST-01-04,10,13 proof, exact freshness and logout/back; no private production delivery before pass |
| 3 | Catalog persistence/admin, signed intake, durable jobs, lease/fence, publication/retention, manual sync | Real Mongo/filesystem fault, concurrency/restart and storage/access-loss tests; all US4/US5 journeys |
| 4 | Inspect actual source folders, review MDX against the safe static component allowlist, convert only unsupported constructs in their source repository | Explicit owner review of content scope/documents/assets; no automatic GitHub-visibility publication |
| 5 | Standalone container with same-container worker, explicit content exclusions, health, workload/recovery proof | All required tests, coverage, typecheck, lint, production build; versioned image publication separately approved |
| 6 | Infrastructure-owned network/secrets/persistence/placement integration and separate DEV trial | Live identity/sync/browser/resource proof, consistent backup/recovery and rollback; concrete approval before deployment |

No files in sibling infrastructure/source repositories are modified by this command or implicitly
authorized by this plan. Before approved integration, revalidate live Mongo/version/topology,
Zitadel API/audience, GitHub App permissions, actual checkout, Gitea auth, volume placement,
and service/Traefik/Watchtower settings via their established workflow.

### Recovery and Rollback

Preserve previous image/configuration and a consistent database/content backup before approved rollout.
Pause new sync intake/claims, drain requests/worker or fence outstanding work, checkpoint publication
and session/approval state, back up the database plus corresponding immutable directories as one set,
then resume. Restore into isolated DEV first; verify manifests/pointers and auth defaults before serving.

Rollback uses the known previous Swarm image AND its matching config/schema, not an unverified Compose
command. Prefer additive Mongo schema changes and versioned manifests; do not run destructive migrations
during rollback. If old image cannot read new records, restore the consistent recovery set and re-login
users; never roll back to an inherited unguarded private reader. Approval and browser/health verification
remain required. Recovery target: validated isolated DEV restore and healthy rollback each <=30 minutes
for the acceptance corpus; targets require measurement before production.

## Complexity Tracking

### Approved incremental blob download follow-up — 2026-10-13

The owner approved reducing downloads while retaining full candidate validation and complete
immutable publication, including unchanged syncs. Feature implementation scope is
`lib/content/blob-cache.ts`, `lib/content/generations.ts`, `lib/sync/github.ts`, and
`lib/sync/worker.ts`; C3/C4 and global coverage gates include these files.

The internal `readCandidate(catalog, signal?, cache?)` adapter accepts optional verified raw-byte
lookup/write methods. Existing injected providers retain their two-argument invocation. The cache
is under `<contentRoot>/<catalogId>/blob-cache`, keyed by configuration revision and Git blob SHA.
No manifest schema, Mongo schema, public route, sync response, or dependency changes are required.
Normalized Markdown/metadata/attachments are never used as original blobs. Reused bytes undergo
size/SHA checks and the complete existing validation and owner-approval path.

Cache storage is capped at 50 MiB/1,000 blobs. Fenced lease checks precede writes and atomic rename;
exclusive cache locks serialize mutations. Expired locks and abandoned temporary files are cleaned
without following symlinks. Ordinary cache read/write failure falls back to upstream download;
unsafe paths fail closed. Cleanup counts cache and temporary bytes and evicts them before reserving
a full 50 MiB snapshot, within the existing 200 MiB catalog budget. The existing 20-catalog quota
bounds combined catalog payload below the 4 GiB portal budget; neither quota is increased.

Acceptance covers initial/unchanged/changed downloads, duplicate SHAs, renamed/added/deleted files,
restart/configuration isolation, corruption, interrupted writes, storage pressure, unsafe entries,
lease loss, upstream/head failures, normalization equivalence, and preserved publication. Run cache,
GitHub, worker and generation tests; repository coverage collection/check, typecheck, lint,
production build, and artifact validation. Keep full coverage/release tasks open when evidence fails.

Existing installations warm the cache on their first successful download. No live rollout is
authorized. Cache omission restores the uncached provider path; older application rollback must
account for the new cache directory before restoring old cleanup code. Cache disposal is scoped to
that private directory, never published generations or reader pins, and needs the existing approval
process on shared/live infrastructure.

No constitutional exceptions requested. Official session adapter, small encryption/role boundary,
conditional catalog publication, durable replay tombstones, and request pins address explicit
security/recovery requirements. No generic framework, extra service, new provider, or optional feature.

## Planning Validation and Remaining Evidence

All product/planning choices are recorded; no unresolved design placeholder remains. Manifest peers and
the synthetic runtime probe are verified. Phase 1 re-check passes at design level.

Still required for aggregate completion/release: run the planned 15-minute resource/workload and
retention-pressure test; revalidate infrastructure and verify current Zitadel roles, live access removal,
and recovery/rollback in separately approved DEV. The current Windows production build and fresh local
image/container acceptance passed. The private path matrix and intake-to-runtime proof are covered by
automated browser/integration tests. These remaining evidence gates do not weaken the project's scope or
governance.
