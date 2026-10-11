# HTTP and Reader Contract: Librarian v1

**Status**: Design only; no handlers generated.
**References**: [specification](../spec.md), [plan](../plan.md), [data model](../data-model.md).
Paths retain the agreed brief. The catalog item PATCH route completes administration's update contract;
it is not a new feature. No source-writing, catalog-delete, global-search, or static-index endpoint.

## Cross-Cutting Rules

- Only the configured same-origin portal may use authenticated application JSON mutations.
  Require valid session plus project-verified librarian-admin, exact Origin against configured origin,
  and session-bound CSRF token. Do not enable credentialed wildcard CORS. GET must not mutate catalogs.
- Every overview/article/tree/search/metadata/asset request checks current catalog enablement/access,
  config and, for private content, session/current repository-reader permission before cache/file access.
  Same rule applies to HEAD and conditional requests; never return protected 304 without authorization.
- Admin role does not grant reading. Role freshness uses >=900 seconds, independent of session renewal.
  Failed verification/storage/provider is unavailable/denied, never a public fallback.
- Catalog-dependent HTML/RSC/JSON/assets: Cache-Control private, no-store; conservative no public
  ETag reuse across visibility. Safe static app code/original branding may cache without document content.
  No source-based static params, public private metadata, exported search index or unguarded optimization.
- Errors: bounded JSON {error:{code,message},requestId}; safe generic messages only. No provider
  response, source extracts, paths outside catalog, role/token values, or private titles in denied errors.
- Status: 400 invalid syntax/fields; 401 no valid session for protected API; 403 verified lack of role,
  invalid signature or mutation origin/CSRF; 404 unknown/disabled catalog or missing safe path;
  409 config conflict/generation reload/replay ID mismatch; 413 size limit; 429 rate limit;
  503 persistence/provider/queue/retention capacity unavailable. HTML anonymous private entry starts
  login; authenticated denial renders an accessible denied screen. No content body accompanies denial.
- Validate all decoded segments, reject NUL/backslash/traversal/double-encoding escapes, and normalize
  once to the agreed canonical POSIX path. Role strings are not filesystem paths.
- Optional g query parameter is an opaque generation UUID, not a permission token. Current and
  retained published generations only, current config and authorization always checked. Expired g:
  409 reload_required for JSON/assets; reader replaces document with latest safe reauthorized route.
- Request timeouts/read pins follow the plan. Recheck config/authEpoch before first protected bytes;
  already delivered authorized content is not recalled. Never silently switch generation mid-response.

## Public Directory and Reader

| Method / route | Input and success | Failure / acceptance |
|---|---|---|
| GET / | Safe enabled-catalog cards, title/description/route/Public or Restricted badge; case-insensitive display-title substring name filter | No source-derived private titles/snippets; Mongo unavailable is an error state rather than fabricated empty directory |
| GET /{repoSlug}/[[...page]] | Default latest valid generation; optional g for coherent navigation; overview or article with standard reader controls | Public anonymous works; private local login return/denial; unavailable first sync and safe not-found states |
| Reader navigation/metadata | Selector projects from safe directory projection; authorized selected-generation tree, breadcrumbs, toc, previous/next, copy code | Private metadata generation calls same server boundary; document title may use safe generic project label to avoid private history titles |
| GET /api/search/{repoSlug}?query=...&g=... | UTF-8 query <=256 bytes, <=20 result objects in pinned Fumadocs live-search shape, URLs bound to repository/generation | Empty query gives empty results after authorization; zero cross-project snippets; no staticGET/index export |
| GET or HEAD /api/assets/{repoSlug}/[...path]?g=... | Validated manifest-mapped local file only, selected generation, safe length/type | Authorization before file open/headers; no SVG/HTML/JS/remote fetch or optimized private image path; invalid path rejected |

Search JSON must preserve pinned Fumadocs result adapter shape (IDs/type/content/url and permitted
heading ancestry) while containing only authorized repository/generation records. An implementation
contract test freezes the observed pinned library shape. Do not invent an incompatible search response.

Images use authorized raster delivery. PDF/TXT/CSV/JSON use Content-Disposition attachment with safe
filename. All assets have X-Content-Type-Options nosniff; non-images use sandboxing where applicable.
External https/mailto document links are normal user navigation with safe rel/referrer policy;
images/attachments must be local. Relative .md/index and heading anchors resolve against source document,
not the application's filesystem. Links naming another project cannot bypass that project's boundary.

Reader private links use full document navigation/prefetch off until SPA cache safety is proven.
The private subtree fence covers article, navigation/search state, title and asset references:
hidden until active on a freshly authorized page; hide/scrub on lifecycle/expiry; reload restored pages
before reveal. Logout broadcasts and full replace supplement server checks. No-JS private screen remains
hidden with safe explanation. Test real back/forward/cache restoration in all three supported engines.

## Authentication: /api/auth/[...nextauth]

Use pinned Auth.js GET/POST handlers and supported sign-in/session/sign-out flows, not a custom password
endpoint. Zitadel login uses allowlisted issuer/redirect URIs, PKCE/state/nonce, openid/profile/email,
offline_access and required project/API audience scopes verified in DEV. No secrets are client fields.

Database session cookies follow official adapter security defaults with secure production settings.
Session callback returns only explicitly allowed safe user identity fields; not roles, verification
tokens, OAuth/ID/refresh tokens, session token, project claim bodies or private repository data.
Protected boundaries resolve sessions/verified permissions server-side. Local signout uses official
CSRF-protected flow, deletes local session, and clears application state before provider end-session.
Provider failure leaves local session revoked. External/open-redirect returnTo values are rejected.

## Catalog Administration

### GET /admin and GET /api/admin/repos

Require current librarian-admin permission for configured identity project. Return a maximum of 20
catalog summaries with source configuration, safe title/description, visibility/required role/enabled,
config revision, current status (pending/running/succeeded/failed), published commit, last-success time
and sanitized failure. retry_wait maps to pending with safe next-attempt time. Never include credentials,
provider tokens, physical volume paths or private document bodies.

### POST /api/admin/repos

Require admin, CSRF/origin and JSON <=32 KiB. Allowed fields:
github {owner, name, branch, docsPath, installationId}, slug, title, publicDescription,
visibility, readerRole, enabled, and public-only publicationApprovalRef. Stable repositoryId is
verified server-side against the selected App installation. Unknown fields/unsafe identifiers fail.
If source lookup is temporarily unavailable, do not claim validated ready/public status.

Default private when source is private; public request requires real applicable owner approval,
not a client approval Boolean. Optional readerRole defaults docs:{slug}:reader. Source scope and route
constraints are validated; unique collisions or reserved slugs return 409/400 without partial change.
Return 201 {catalog: summary, revision}; saving does not falsely report successful ingestion.
Administrator then invokes Sync now for initial work.

### PATCH /api/admin/repos/{id}

Same guards and field validation. Require If-Match with existing config revision. A missing precondition
is 400; stale revision is 409; rejected mutation preserves existing state. Return 200 summary/new revision.
Metadata-only updates preserve compatible publication. Source/branch/folder/slug/role/visibility change
invalidates incompatible serving/leases and requires compatible resync. Disabled catalogs stop all
delivery and leave administration/status available. Public activation requires matching owner approval.
Approval records are owner-mounted read-only input; administrators cannot create them through this API.

### POST /api/admin/repos/{id}/sync

Same guards; required Idempotency-Key UUID; empty or small bounded request body.
Return 202 {jobId, status:"pending"} only after durable job insertion. Duplicate key for same catalog/
config returns existing logical job outcome without another insertion. A conflicting scope/key returns
409. Disabled catalog 409; unavailable storage/quota/rate/retention gives explicit failure/backpressure.
Manual work follows exactly the automatic lease/current-head/validation/publication rules.
This recovers missed webhooks; it does not grant the admin private reading or public publication.

## GitHub Intake: POST /api/webhooks/github

Accept application/json original bytes <=1 MiB. Validate X-Hub-Signature-256 as bounded sha256 hex with
native HMAC and constant-time comparison before decoding JSON. Require bounded X-GitHub-Delivery and
supported event. Verify configured App/installation and stable repository identity; push work also
requires exact configured branch, with full refs/heads representation normalized safely.

- Valid matched push: durably insert one job per matching catalog, then 202 with generic accepted
  status/job identifiers. No fetch/render/ingestion in the request.
- Duplicate ID with same verified payload/scope: 200 duplicate with stored outcome; no logical job.
- Same ID with different verified payload digest: 409 conflict; no replacement.
- Valid unconfigured repository/branch/unsupported event: 202 ignored with no work.
- Malformed/invalid signature or payload: 403/400; oversized 413; no job.
- Storage/rate/quota failure: 503/429; do not falsely acknowledge all matching work. Already durable
  per-catalog jobs survive a partial failure; retry checks receipts and finishes the remainder.
- Signed installation deletion/repository-removal event: match selected App/installation/repository;
  idempotently block affected catalogs before control-receipt admission, regardless of normal work
  quota/rate/enablement. Acknowledge only after durable receipts and all disables; partial storage/quota
  failure returns 503 without reversing completed disables. Retry/reconcile even if a receipt exists.
  Never infer removal from an isolated
  rate-limit/transport error or a missing branch response.
- Do not subscribe to unrelated events or install App beyond selected sources. Contents is read-only;
  installation token lifetime/permissions match provider constraints, never a long-lived catalog token.

## GET /api/health

No authentication required; return 200 {status:"ok"} only when required storage/content root and bounded
worker startup are operational, or 503 {status:"not_ready"}. No versions, source names, private commits,
paths, credentials or provider error bodies. Detailed sanitized diagnosis remains in operator logs/admin.

## Contract Validation Obligations

Trace FR-001-038 and QG-001-007 through the spec's ST-01-14 matrix. Freeze the pinned search/Auth adapter
shapes with actual handlers; test all direct requests and HEAD/conditional paths, metadata/RSC, malformed
and oversized inputs, authority/project separation, exact role age, duplicate/partial intake, and
configuration races. These contracts are design, not evidence that endpoints exist or tests pass.
