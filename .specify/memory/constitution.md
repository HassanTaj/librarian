<!--
Sync Impact Report (temporary review material; remove before committing)
Version change: 1.0.0 -> 2.0.0 (owner-approved amendment, 2026-10-13)
Amended principle:
- V. Functional Features Ship with Tests and At Least 95% Coverage
Unchanged principles: I. Git Is the Documentation Source of Truth; II. Private Content Has a Single
Server Authorization Boundary; III. Repository Content and External Inputs Are Untrusted;
IV. Synchronization Publishes Complete, Recoverable Generations; VI. Use Standard Components and
Accessible Reader Behavior; VII. Operations Must Be Bounded, Observable, and Reversible.
Amendment: Principle V and the development gates now exempt isolated, presentation-only UI changes
from test authoring, test execution, and coverage completion gates unless the owner asks for them.
Functional, security, data-integrity, ingestion, and release gates remain in force.
Reason: the owner directed that UI presentation work stay focused and all tests be deferred until requested.
Migration impact: this directory presentation follow-up does not close any open v1 behavior, security,
or release tasks; test work for this presentation slice is deferred until the owner requests it.
Updated sections: Principle V; Development Workflow and Quality Gates; amendment history.
Synchronized artifacts: AGENTS.md and the active feature spec, plan, and task ledger.
Product, security, data-integrity, and release scope are unchanged. Follow-up TODOs: none.
-->

# Librarian Constitution

## Core Principles

### I. Git Is the Documentation Source of Truth

Librarian MUST remain a documentation reader and catalog administrator. Developers
MUST author documentation in its source GitHub repository; Librarian MUST NOT write
source content or provide a documentation editor.

Each enabled catalog MUST identify one repository, one branch, one documentation
folder, and one unique route slug. Reading, navigation, links, assets, and search
MUST remain scoped to the selected repository. Documentation updates MUST become
available at runtime without rebuilding the application image.

V1 MUST implement the scope in `plan.md`. Additional Git providers, AI Q&A,
page-level access control, and automatic GitHub-contributor-to-Zitadel role mapping
MUST remain outside v1 unless the project owner explicitly changes the scope.

### II. Private Content Has a Single Server Authorization Boundary

Anonymous users MAY read public documentation. Private documentation MUST require
both an authenticated Zitadel identity and the configured repository reader role,
verified for the configured Zitadel project. `librarian-admin` MUST authorize
catalog administration only; it MUST NOT implicitly grant private reader access.
The default private reader role MUST be `docs:{repo-slug}:reader`.

Every private delivery path MUST enforce authorization on the server: articles,
repository overview content, navigation, search, metadata, and local assets.
Client UI checks and routing middleware alone MUST NOT be the security boundary.
Public directory cards and the project selector MAY expose only explicitly
configured, safe directory metadata, with a Restricted badge.

Verified roles MUST be refreshed on the first protected request when their last
successful verification is 15 minutes old or older. Session renewal MUST NOT reset
that verification age. Refresh failure after this deadline MUST deny protected
access until authentication and role verification succeed.

Private content MUST NOT enter public static bundles, sitemaps, downloadable search
indexes, Next.js's `public` directory, shared public caches, or unguarded image
optimization routes. Protected assets MUST use the authorized asset handler.
Authorization MUST be checked before accessing cached private content. Cache keys
MUST isolate repository and published generation; retention MUST be bounded.
Logout, role removal, catalog disablement, and visibility changes MUST invalidate
or prevent reuse of affected application caches, including browser navigation
caches. Private-to-public publication MUST require explicit owner approval.

### III. Repository Content and External Inputs Are Untrusted

V1 MUST accept Markdown with YAML frontmatter, GitHub Flavored Markdown, optional
Fumadocs `meta.json` navigation, and local images and attachments inside the
configured documentation folder. Executable MDX/JSX, imports, expressions, unsafe
HTML, symlinks, and paths escaping that folder MUST be rejected. Repository scripts
MUST NOT execute, and repository dependencies MUST NOT be installed.

Source paths, decoded route paths, relative links, asset paths, frontmatter,
navigation files, repository configuration, and webhook input MUST be validated at
their trust boundaries. Slugs MUST be unique and MUST NOT collide with reserved
application routes. Ingestion MUST impose explicit bounds on content size, file
count, processing time, and supported asset types, documented in the feature plan.

GitHub webhooks MUST verify their signature against the original request bytes,
deduplicate delivery identifiers durably, and match the configured repository and
branch before queuing work. The GitHub App MUST have read-only Contents access and
only the webhook subscriptions and installations required for selected repositories.
Installation tokens MUST be short-lived.

Administration mutations MUST require `librarian-admin`, server-side validation,
and CSRF/origin protection. Secrets and tokens MUST NOT appear in repository
records, source control, client payloads, logs, or user-visible errors. Production
credentials MUST be provided through scoped Swarm secrets.

### IV. Synchronization Publishes Complete, Recoverable Generations

Webhook handling MUST durably queue accepted work and return promptly; it MUST NOT
perform full ingestion in the request. A background worker in the application
container MUST fetch and validate content, prepare an immutable snapshot, and
publish it only after the candidate is complete and valid.

MongoDB leases MUST serialize ingestion and recover abandoned jobs after restart,
including overlapping containers during Swarm updates. A worker that has lost its
lease MUST NOT publish. Publication MUST prevent partial generations, mixed
generation responses, and an older job overwriting a newer published result.
Pages, navigation, assets, and search MUST agree on the selected generation.

Content validation errors and transient GitHub or worker failures MUST retain the
last successful snapshot and expose a readable, actionable administration status.
Confirmed GitHub App removal or loss of repository access MUST disable serving the
affected catalog until an administrator resolves it. Disabling a catalog MUST stop
all of its content delivery paths even when a snapshot remains on disk.

Manual resync MUST recover missed webhooks. Sync status MUST distinguish pending
work, running work, successful publication, and failure, and MUST identify the
published commit and last successful sync without exposing credentials.

### V. Functional Features Ship with Tests and At Least 95% Coverage

Changes to application behavior, data handling, authorization, APIs, persistence,
ingestion, synchronization, and operations MUST include automated tests for their
acceptance criteria. A bug fix in those areas MUST include a regression test.
Test tasks MUST be explicit in feature specifications and generated task lists;
template language describing tests as optional MUST NOT override this requirement.

Presentation-only UI changes that leave existing behavior and data flow intact,
including styling, layout, spacing, badge placement, and visibility of information
already produced by the application, do not require new tests or coverage work.
Test authoring and execution for this class of change MUST be deferred unless the
owner explicitly asks for tests. Do not add tests that only assert utility-class
strings for visual presentation. This exception does not apply when a UI change
alters authorization, data access, validation, persistence, or other application
behavior.

For functional feature and v1 release completion, coverage MUST be at least **95%
separately for statements, branches, functions, and lines** across all first-party
executable application code, including the worker, route handlers, authorization,
rendering adapters, and administration logic. The same four thresholds MUST apply
to each functional feature's implementation file set, declared in its plan and
checked in CI, so an overall average cannot hide an untested feature. These gates
are not completion requirements for a standalone presentation-only change.
Unexecuted source files MUST be included in coverage measurement. A metric with no
applicable items MAY be reported as not applicable, with an explanation; missing
instrumentation or an empty test suite MUST NOT count as passing coverage.

CI MUST fail when any applicable threshold falls below 95%, a required test fails,
or a required coverage report is absent. Coverage enforcement MUST be established
with the first executable feature and retained throughout implementation. Reports
MUST show the measured source scope, exclusions, and all four metrics.

Only generated code, third-party code, test code, and purely declarative files MAY
be excluded, with documented reasons. First-party runtime logic MUST NOT be
excluded or annotated to ignore coverage merely to meet the gate. Tests MUST assert
observable behavior; placeholder assertions, blanket mocks of the behavior under
test, skipped required tests, and retrying until a failure disappears MUST NOT be
used to make the gate pass.

Unit tests MUST cover changed functional logic; integration tests MUST exercise
actual application boundaries, MongoDB job/lease behavior, and filesystem snapshots
as applicable. External providers MAY use controlled contract fixtures in CI, but
live DEV integration checks MUST prove compatibility before production. Browser
tests MUST cover reader and administration journeys when their behavior changes.
Isolated presentation-only adjustments do not require browser tests unless the owner
requests them.

Coverage does not replace security or recovery evidence. Automated scenarios MUST
exercise public, anonymous-private, authorized-private, wrong-role, expired-role,
and administrator-without-reader access across every protected delivery path.
They MUST cover the exact role-freshness deadline, failed refresh, logout/back
navigation, cross-repository isolation, catalog disablement, and visibility changes.
Webhook and ingestion scenarios MUST cover bad signatures, duplicate deliveries,
wrong branches, invalid content, concurrent events, lost leases, worker restart,
GitHub failures, access loss, and retention of the last valid generation.

### VI. Use Standard Components and Accessible Reader Behavior

The application MUST reuse standard Fumadocs components and suitable existing
layout/container patterns before adding custom implementations. It MUST NOT fork
Fumadocs or introduce a dependency, abstraction, or service without a current,
documented need. Custom code MUST be limited to Librarian's catalog, authorization,
runtime ingestion, and required presentation behavior.

The homepage MUST list configured public and restricted repositories with safe
titles, descriptions, routes, badges, and a name filter. The reader MUST provide a
project selector, repository-specific sidebar, breadcrumbs, article navigation,
table of contents, code-copy controls, and keyboard-accessible search labelled
"Search this project". Authentication MUST return readers to the requested local
page; authenticated readers without the required role MUST receive a clear
access-denied screen.

Mobile layouts, keyboard navigation, visible focus, accessible names, and system,
light, and dark themes MUST be verified. Loading, empty, access-denied, and failure
states MUST be usable. Branding and assets MUST be original; reference sites inform
layout direction only.

### VII. Operations Must Be Bounded, Observable, and Reversible

The application MUST initially fit the planned **0.5 CPU / 512 MB** container limits
with one replica on the node holding its persistent content volume. Representative
reading and ingestion workloads MUST be measured before proposing higher limits.
Caches, retained generations, jobs, and retry behavior MUST have explicit bounds
and a recovery policy; cleanup MUST preserve the active generation and snapshots
needed by in-flight reads.

Health checks MUST report operational status without sensitive details. Operational
logs MUST identify repository/job/delivery/generation context as applicable, redact
secrets and private document bodies, and make failed synchronization diagnosable.

Application images MUST be built outside the VPS, versioned, and published to the
existing Gitea registry. A separate DEV hostname MUST be validated before replacing
the production service. Deployment MUST retain a known previous image and
configuration, validate health and rollback, and back up MongoDB catalog/job state
and the content volume as a consistent recovery set.

Live infrastructure changes, credential provisioning, publication of private
documentation, and production deployment MUST require explicit owner approval for
the concrete scope. Once approved, the scoped work and verification MUST be
completed without redundant approval requests.

## Architecture and Scope Constraints

- Librarian MUST remain a separate Next.js application and Git repository in this
  folder. Infrastructure descriptors, Swarm/Traefik configuration, networks,
  secrets, and deployment scripts MUST remain in `contabo-server-setup`.
- The chosen stack MUST be Next.js, Fumadocs, Auth.js with Zitadel, the official
  MongoDB driver against the existing MongoDB deployment, a GitHub App, and
  persistent local content storage. MongoDB MUST use a dedicated database and
  scoped application user.
- Markdown loading MUST use `@fumadocs/local-md` with `dynamicLoader`, one source
  and base URL per repository. A compatible pinned dependency set and runtime
  loading behavior MUST be verified during planning and implementation; an
  incompatibility MUST be resolved explicitly before changing the agreed stack.
- MongoDB MUST hold repository configuration/publication state and durable sync
  jobs. Immutable document snapshots and assets MUST live on a persistent volume
  outside `public`. Credentials MUST be kept separate from these records.
- The server and background worker MUST run in the same container. No additional
  queue service or dedicated worker deployment is part of v1.
- Routes MUST follow `plan.md`: `/`, `/{repoSlug}/[[...page]]`, repository-scoped
  search and assets, GitHub webhook intake, Auth.js authentication, administration
  configuration/manual sync, and a non-sensitive health endpoint.
- Private GitHub sources MUST default to private. Making content public MUST be
  an explicit decision after reviewing the intended documentation and assets.
  Changing GitHub visibility MUST NOT automatically publish content in Librarian.

## Development Workflow and Quality Gates

1. Each feature specification MUST state its acceptance criteria, access-control
   impact, failure behavior, and mandatory tests for functional requirements. Each
   implementation plan MUST include a Constitution Check, affected source/interfaces,
   applicable feature coverage scope, test commands, and operational evidence.
2. Generated tasks MUST include unit, integration, and browser tests appropriate
   to changed functional behavior, coverage enforcement, and required negative/security
   scenarios. Presentation-only tasks MUST defer test authoring and execution until
   the owner explicitly requests them. Required regression tests MUST demonstrate
   functional defects before their fix.
3. Implementation MUST follow the sequence in `plan.md`: fixture-based directory
   and reader; proof of public/private boundaries; ingestion and administration;
   source preparation; container packaging; infrastructure integration. Private
   delivery MUST NOT proceed to production before its boundary is proven.
4. A functional feature MUST NOT be marked complete or merged until its acceptance
   tests, applicable 95% coverage gates, type checks, lint checks, and production
   build pass. A standalone presentation-only change is not gated on new tests or
   coverage. Configuration/documentation-only changes MUST receive appropriate
   validation without manufacturing meaningless coverage measurements.
5. Review MUST confirm that all entry points, callers, assets, caches, fixtures,
   and error paths affected by a change follow the same rules. Specifications,
   plans, and task lists MUST be corrected when they conflict with this constitution.
6. Production readiness MUST include live DEV login, refresh, logout, GitHub sync,
   MongoDB/storage recovery, resource measurements, browser verification, and the
   acceptance criteria in `plan.md`. CI mocks MUST NOT be presented as evidence
   that a live integration or resource budget has been verified.
7. Before approved deployment, the operator MUST revalidate live service state,
   Gitea authentication, Zitadel configuration, MongoDB connectivity, and the
   actual infrastructure checkout. Deployment MUST follow the established
   `ssh contabo` path and include post-deployment browser and health verification.

## Governance

This constitution MUST govern feature specifications, plans, tasks, reviews, and
implementation. `plan.md` records the product decisions and acceptance criteria;
feature artifacts MUST satisfy both documents. A conflict MUST be resolved
explicitly rather than silently weakening a rule. Generic template examples and
optional-test wording MUST NOT waive functional, security, or release test and
coverage gates. The presentation-only exception in Principle V is an explicit
project rule, not an implied waiver for functional work.

Amendments MUST record the reason, affected principles, migration or remediation
impact, and owner approval. Changes MUST use semantic versioning: MAJOR for removal
or incompatible redefinition of principles, MINOR for added principles or material
expansion, and PATCH for clarifications that do not change obligations. The
ratification date MUST remain the original adoption date; Last Amended MUST reflect
the date of the latest adopted change.

Exceptions MUST NOT be granted implicitly by a feature plan or complexity table.
Weakening authorization, content validation, functional/security test requirements,
or the 95% thresholds for functional features requires an explicit constitution
amendment before the affected work can pass its completion gate. Unverified
integrations and performance assumptions MUST be recorded as unresolved evidence,
never represented as successful checks.

### Amendment history

#### 2026-10-13 — Version 2.0.0

- **Owner approval**: The owner explicitly requested updating the testing rules and deferring all tests until requested.
- **Reason**: Keep presentation work focused on improving the UI instead of adding broad test work for visual defects.
- **Affected rules**: Principle V and the development workflow and quality gates.
- **Change**: Isolated presentation-only changes no longer require new automated tests, test execution, or coverage gates. Functional, security, data-integrity, ingestion, and v1 release requirements remain.
- **Migration impact**: The current directory UI follow-up has no test or coverage completion gate until requested; existing open v1 acceptance, security, and release tasks remain open.

**Version**: 2.0.0 | **Ratified**: 2026-10-11 | **Last Amended**: 2026-10-13
