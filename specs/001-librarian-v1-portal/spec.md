# Feature Specification: Librarian v1 Git-connected Documentation Portal

## Approved sync optimization — 2026-10-13

Synchronization may reuse original Git blob bytes scoped to the same catalog and configuration
revision. It must still fetch the current authorized source tree, verify blob sizes and SHAs,
validate the complete current candidate, recheck branch head, enforce public approval and fenced
publication, and produce a complete immutable generation. This is download reuse, not a no-op
publication shortcut. Deleted files are excluded by the new tree; renamed unchanged blobs may be
reused. Normalized delivery files must not substitute for original Git blobs.

The private cache is disposable, capped at 50 MiB and 1,000 blobs per catalog, counted within existing
storage budgets, and subordinate to published snapshots and reader pins. Missing/corrupt/unavailable
cache entries trigger upstream downloads; unsafe filesystem entries fail closed. Synthetic regression
and acceptance tests and the existing global/feature four-metric 95% gates are mandatory.

**Feature Directory**: `specs/001-librarian-v1-portal`

**Created**: 2026-10-11

**Status**: Updated 2026-10-13 for safe static Fumadocs MDX components and docs-subtree-only blob fetching. `.mdx` allows Markdown/GFM plus `Info`, `Note`, `Warning`, `Columns`, `Card`, `Steps`, and `Step` with static attributes, except constant `Columns cols={1..4}`. The inspected local `contabo` checkout at `main` / `567e6d3` contains 72 `.mdx` files plus two unrelated files (74 total, 530,249 bytes; largest page 92,591 bytes); its supported candidate passes existing limits, so no limit increase was made. The first DEV sync failed with legacy `github_invalid_content`; a later sync completed successfully. The current directory and admin views show Succeeded, and admin reports published commit `d82a7d26487af66f37d91cdea8e828f133564806` at `13/10/2026, 02:51:01`. The locally inspected checkout SHA differs from that published commit, so its counts and validation are not evidence about the exact published tree; source provenance and content-scope review remain open. No source files or GitHub App settings were changed. Targeted tests, typecheck, lint, and production build passed; full coverage and three-engine browser acceptance, measured workload, recovery, publication, and deployment evidence remain open.

**Input**: Create one specification for the complete agreed Librarian v1 portal, with
prioritized discovery, authorization, project-scoped reading, synchronization, and
administration journeys, required functional acceptance tests, and all four global and
per-feature 95% coverage gates for functional work and full v1 completion.

**Authority**: [AGENTS.md](../../AGENTS.md), [constitution v2.0.0](../../.specify/memory/constitution.md),
and [agreed v1 requirements](../../docs/requirements/v1-requirements.md). Constitution references
to the former root `plan.md` mean that agreed requirements file, as established by AGENTS.md.
This specification covers the full v1 product; a later feature plan is a separate artifact.
No Git branch is created or required to locate this feature.

## User Scenarios & Testing *(mandatory)*

All five stories are required for v1. Priority orders delivery rather than removing lower-priority
scope. Stories can be independently demonstrated with synthetic catalogs and published content;
this does not authorize deploying private content before the authorization boundary is proven.
Every functional scenario below requires automated acceptance evidence for v1 completion. Isolated
presentation-only UI changes that preserve behavior and data flow follow Principle V's test deferral
exception; the security/recovery matrix and functional release gates remain mandatory.

### User Story 1 - Discover repositories and read documentation (Priority: P1)

As a reader, I want to find a project's documentation from a clear directory and read its
published articles on desktop or mobile, so I can use documentation maintained by its developers.

**Why this priority**: Discovery and reading are the portal's core value and the first staged
delivery. Developers retain their existing source-authoring workflow.

**Independent Test**: Use synthetic enabled public/private catalog entries, including a first-sync
failure and a previously published catalog with a later sync failure. Demonstrate filtering, card
availability/status, opening a project, reading formatted content, and empty/error
states without a live identity provider or GitHub connection. Private entries expose safe
directory metadata only.

**Acceptance Scenarios**:

1. **Given** enabled public and private catalogs, **When** a reader opens the homepage,
   **Then** cards show configured safe titles, descriptions, routes, Public/Private labels beside the title,
   and text-labelled pending/running/succeeded/failed sync status at the lower right, without exposing
   document bodies; the heading is Documentation Directory, and generated application and Perspective V
   branding appear in navigation and the footer;
   the header identifies Perspective V / Docs, offers theme controls, shows an in-place Zitadel
   sign-in control to signed-out visitors or a sign-out control to authenticated visitors, and the
   directory is headed Documentation Directory. A card without a successful publication is disabled;
   its collapsed sync issue can be expanded and reported. A prior successful publication stays readable
   after a later failed sync.
2. **Given** multiple cards, **When** a reader filters by project name, **Then** matching directory
   entries remain; the filter does not search articles or expose private titles from source content.
3. **Given** a published public article, **When** an anonymous reader follows its project link,
   **Then** the article and repository overview display without login, with headings, tables,
   lists, links, fenced code, and local images/attachments supported by the agreed format.
4. **Given** a phone, tablet, or wide desktop viewport, **When** the directory and reader are used,
   **Then** the directory has one, two, or three columns respectively, content is readable, mobile
   navigation can be collapsed, and controls remain operable with keyboard and visible focus.
5. **Given** no configured catalogs, no filter matches, an unpublished catalog, a missing page, or
   a loading/failure condition, **When** the reader reaches that state, **Then** an explicit,
   usable empty/loading/unavailable/not-found/error state appears without private content.
6. **Given** a developer changes documentation in the source repository, **When** a successful
   synchronization publishes it, **Then** readers see the new documentation without editing in
   Librarian or rebuilding the application.
7. **Given** an authenticated administrator opens the directory, **When** they select one or more
   sources, **Then** Sync Selected docs is enabled and submits the selected IDs as independent durable
   per-catalog jobs; each card also has an individual sync action. Pending/running work animates its
   card action and updates the status badge without a page reload. Sync controls are absent for
   non-administrators.
8. **Given** the directory toolbar and repository cards render at desktop or mobile widths, **When**
   a reader uses them, **Then** search and sync controls are vertically centered and spaced across the
   toolbar; administrators get circular selection controls at the card's upper left and a small
   circular sync action at upper right; the Public/Private label stays beside or below a wrapping title.
   Navigation includes Home and labels the administration destination Repositories. Directory,
   administration, and reader loading states use layout-shaped skeletons where data is pending.

---

### User Story 2 - Read public content and authorize private access (Priority: P1)

As a reader, I want public documentation to be open and private documentation to require my
project reader permission, so I can reach permitted information without exposing restricted work.

**Why this priority**: Private-content confidentiality is a non-negotiable release gate, including
direct requests and cached content, not merely a screen-level login feature.

**Independent Test**: Use public and private published synthetic content and controlled identities
for anonymous, authorized reader, wrong-role reader, expired-role reader, and administrator without
reader permission. Exercise every protected delivery path and the exact freshness deadline.

**Acceptance Scenarios**:

1. **Given** an anonymous reader following a private article link, **When** authentication succeeds
   through Zitadel with the configured repository role in the configured project, **Then** the
   reader returns to the originally requested local page and may read it.
2. **Given** an authenticated reader with no matching role, a role for another repository, or a
   matching role belonging to another identity project, **When** private content is requested,
   **Then** access is denied, no private bytes are delivered, and the reader UI explains denial.
3. **Given** an identity with only `librarian-admin`, **When** it administers the catalog and tries
   private reading, **Then** administration is permitted but private reading remains denied.
   A reader-only identity cannot administer catalogs.
4. **Given** successful role verification at time T, **When** a protected request occurs before
   T + 15 minutes, **Then** the last verified roles may be used; **When** one occurs exactly at
   T + 15 minutes or later, **Then** roles are refreshed before protected content is delivered.
   Session renewal does not reset T.
5. **Given** the verification deadline has arrived, **When** role refresh fails or confirms role
   removal, **Then** protected access is denied until successful authentication and role
   verification establish permission; a cached private snapshot does not bypass this decision.
6. **Given** private content was viewed, **When** the reader signs out and uses back/forward
   navigation or attempts direct content/search/asset requests, **Then** application caches do
   not reveal that content. Catalog disablement and visibility changes also prevent affected reuse.
7. **Given** a private source or an existing private catalog, **When** GitHub visibility changes
   or an administrator requests public publication, **Then** no automatic publication occurs;
   private-to-public publication requires explicit owner approval of the intended documents/assets.
8. **Given** a forged external return destination after login, **When** authentication completes,
   **Then** the portal does not redirect there; the return target must be a valid local destination.

---

### User Story 3 - Navigate, search, and follow project-scoped links and assets (Priority: P1)

As a reader, I want navigation, search, links, and attachments to stay within my selected project,
so I can find relevant information without crossing a repository or permission boundary.

**Why this priority**: A readable page alone is insufficient; finding and following its content
must preserve the same scope and authorization as reading it.

**Independent Test**: Use several repositories with identical article names, distinct private
sentinels, a navigation fixture, nested links, heading anchors, images, and attachments. Prove
selection, isolation, link resolution, and protected direct delivery against published fixtures.

**Acceptance Scenarios**:

1. **Given** a selected repository, **When** its reader opens, **Then** the project selector marks
   restricted entries safely, the sidebar contains only its document tree, and breadcrumbs,
   previous/next article controls, heading table of contents, and code-copy controls work.
2. **Given** a repository with configured optional navigation metadata and one without it,
   **When** the reader navigates either, **Then** valid metadata is respected and the repository
   without it remains navigable using the available documentation.
3. **Given** identical terms in different repositories, **When** the reader invokes keyboard-accessible
   Search this project, **Then** results, snippets, and destinations come only from the selected
   repository and obey its current authorization; empty results have a usable state.
4. **Given** nested relative article links, heading anchors, local images, and attachments,
   **When** the reader follows them, **Then** they resolve within the configured documentation
   folder under that project's route, and protected assets require permission even via direct URL.
5. **Given** a request containing encoded traversal, an escaping path, a hostile link/asset value,
   or a different repository identifier, **When** content is resolved, **Then** no file outside the
   configured folder and no unauthorized content is delivered.
6. **Given** a newer generation publishes while the reader uses a selected generation,
   **When** an article, navigation, asset, or search response is delivered, **Then** it is consistent
   with its selected published generation; no partially published or mixed-generation result appears.
7. **Given** system, light, or dark theme and keyboard-only use, **When** the reader changes theme,
   searches, copies code, or opens navigation, **Then** names, focus, and controls remain usable.

---

### User Story 4 - Synchronize GitHub documentation and recover safely (Priority: P2)

As a documentation maintainer, I want accepted changes on the configured GitHub branch to become
available automatically, and failed updates to preserve valid documentation, so publishing remains
reliable without application rebuilds.

**Why this priority**: Runtime synchronization turns a fixture reader into a Git-connected portal.
It follows proof of the private boundary and cannot weaken that boundary during recovery.

**Independent Test**: Submit controlled signed webhook deliveries and repository fixtures through
the actual intake, durable job, worker, and snapshot boundaries. Include storage, concurrency,
restart, and upstream-failure tests; controlled provider fixtures are not live integration proof.

**Acceptance Scenarios**:

1. **Given** an enabled catalog and a valid signed change notification for its repository/branch,
   **When** the notification is accepted, **Then** work is durably recorded before acknowledgement;
   acknowledgement does not wait for the full fetch/render/publish operation.
2. **Given** a bad/missing signature, modified request bytes, duplicate delivery identifier, or
   unrelated repository/branch, **When** intake processes it, **Then** invalid/unrelated input causes
   no ingestion or publication; a duplicate causes no additional logical job, including after restart.
3. **Given** valid source content, **When** its sync completes, **Then** a complete immutable
   generation becomes published, its commit and last-success time are recorded, and pages,
   navigation, links, assets, and search become available without an application image rebuild.
4. **Given** invalid content, an upstream outage/rate limit, or a failed worker, **When** a sync
   fails, **Then** the previous valid generation remains available to permitted readers and the
   administrator receives a readable status identifying failure without secrets/private bodies.
5. **Given** concurrent, repeated, or out-of-order changes, **When** workers compete or a worker
   loses its lease, **Then** only a valid lease holder can publish, work is serialized safely, and
   an older result cannot overwrite a newer publication.
6. **Given** pending or interrupted work and restart/overlapping application instances,
   **When** processing resumes, **Then** accepted work survives and abandoned work can recover
   within the declared recovery policy without incomplete publication.
7. **Given** confirmed GitHub App removal or loss of repository access, **When** that loss is
   established, **Then** every content delivery path for the affected catalog is disabled,
   regardless of a retained snapshot, until an administrator resolves access.
8. **Given** active or in-flight generations and retention cleanup, **When** obsolete data is
   reclaimed, **Then** active publication and in-flight readers are preserved within defined bounds.
9. **Given** `.mdx` pages with Markdown/GFM and allowlisted static Fumadocs components, supported
   metadata/assets, and unrelated regular files under the configured documentation folder, **When** a sync runs, **Then** supported content is
   imported from that folder only and unrelated file types are omitted; unsafe MDX syntax, executable
   Git modes, symlinks, submodules, and supported files over their limits fail without publication.

---

### User Story 5 - Administer catalogs and manually resynchronize (Priority: P2)

As a catalog administrator, I want to configure selected repositories, inspect synchronization,
disable delivery, and request a retry, so the directory stays accurate and missed updates recover.

**Why this priority**: Administrative control is required for initial onboarding and ongoing
operation, and is delivered with ingestion after the reader authorization boundary is proven.

**Independent Test**: Use controlled administrator/reader identities and actual catalog persistence
with a controllable worker. Demonstrate configuration, validation, status, disablement, and durable
manual resync without granting the administrator private reader permission.

**Acceptance Scenarios**:

1. **Given** a verified `librarian-admin` identity, **When** it opens administration, **Then** a
   compact catalog table/form exposes GitHub repository, branch, folder, unique route slug,
   safe display title/description, visibility, required reader role, and enable/disable settings.
2. **Given** anonymous, reader-only, wrong-project, or forged administration requests,
   **When** a view or mutation is attempted, **Then** unauthorized access is rejected; mutations
   also reject failed server-side validation and CSRF/origin checks without partial changes.
3. **Given** duplicate/reserved slugs, invalid paths, or incomplete source settings,
   **When** configuration is submitted, **Then** actionable validation errors appear and existing
   valid configuration is preserved; credentials are not stored in catalog records.
4. **Given** a catalog is initially configured, **When** initial sync is requested,
   **Then** work is queued and the catalog remains unavailable for content until valid publication;
   a private GitHub source defaults to private.
5. **Given** a missed webhook or prior failed sync, **When** the administrator selects Sync now,
   **Then** durable work is queued subject to the same validation, authorization, concurrency,
   and publication rules as automatic synchronization.
6. **Given** pending/running/succeeded/failed work, **When** the table is inspected,
   **Then** those states have visible text labels and distinct color cues (amber for pending,
   green for running, app primary for success, red for failure), with published commit, last successful sync, and sanitized
   actionable errors; submitting Sync now immediately shows progress and refreshes status without a page reload;
   accepted notices appear as info banners and dismiss after 10 seconds, while the latest issue appears as an error banner.
   Administration does not expose private document bodies to a non-reader.
7. **Given** a catalog with published content, **When** it is disabled,
   **Then** it stops serving overview, articles, navigation, search, metadata, and assets,
   including cached responses; it is no longer offered for reading in the directory/selector.
8. **Given** a configuration or visibility change, **When** it becomes effective,
   **Then** source identity, authorization, publication, and caches cannot be combined into an
   unauthorized or mismatched view; private-to-public changes still require owner approval.
9. **Given** an authenticated administrator on the console, **When** returning to the directory or
   ending the session, **Then** a clearly labelled home link and sign-out control are available.
10. **Given** a catalog is disabled or its GitHub access is not ready, **When** Sync now is disabled,
    **Then** the console explains the enablement and GitHub-access prerequisites.
11. **Given** an administrator reviews configured repositories, **When** the card is first shown,
    **Then** its settings are collapsed; Edit expands the settings form, and Repository type offers
    exactly Private and Public.
12. **Given** an administrator confirms removal of a configured repository with its current version,
    **When** no worker lease or live reader pin is active, **Then** the catalog configuration and its
    UUID-scoped snapshot are removed; an active lease/pin or stale version is rejected without
    partial deletion, and durable sync/replay history remains available.
13. **Given** an administrator selects one or more directory cards, **When** they invoke Sync Selected docs,
     **Then** each source receives its own durable manual job through the existing job model, partial
     admission is reported per source, and status badges/actions update as work progresses without a
     reload. Circular selection controls feed a visible selected-source count in the Sync Selected button,
     which is disabled until a source is selected; non-administrators receive
    neither batch nor per-card sync controls.
14. **Given** an administrator reviews a configured repository, **When** its card is collapsed or expanded,
    **Then** small circular view, edit, delete, and sync actions are shown at the upper left; view expands
    read-only details, edit opens the form, and delete stays disabled while editing. The sync badge sits
    at the lower right, and a long published commit is shortened with its full value available by tooltip.
15. **Given** an administrator opens Configure or submits a repository form, **When** the save succeeds or
    fails, **Then** configuration can be shown or hidden on demand, the creation form closes with a success
    banner and refreshed list on success, and remains available with a collapsible error banner on failure.
    The Directory description is a textarea at the bottom and Repository type precedes the remaining fields.
16. **Given** a reader opens the documentation directory or reader on a narrow viewport, **When** project
    controls render, **Then** Home, project selection, search, and account actions remain operable without
    overlapping or overflowing the page.

### Edge Cases

| Case | Required outcome | Coverage |
|---|---|---|
| Empty directory, no name matches, unpublished catalog, missing page/asset | Usable state; no private details; missing content is not fabricated | US1.5; FR-004 |
| First sync fails with no valid snapshot | Disabled directory card, unavailable content, expandable sanitized issue and actionable admin failure; no partial content | US1.1, US5.4; FR-003, FR-024 |
| Later sync fails after a compatible successful publication | Continue serving the last valid generation and display the latest sanitized sync failure | US1.1, US4.4; FR-003, FR-024 |
| Removed/renamed source page or stale local link | Complete new publication; missing destination has a safe not-found outcome | US3.4; FR-015 |
| Empty/missing documentation folder or malformed frontmatter/navigation | Reject invalid candidate; retain last valid snapshot if present | US4.4; FR-016, FR-024 |
| Expired session, wrong project/role, administrator without reader | Deny private content across all protected paths | US2.2-5; FR-007-010 |
| Verification age immediately below, exactly at, or above 15 minutes | Refresh at/after deadline; failure denies; renewal cannot extend age | US2.4-5; FR-010 |
| Logout/back navigation, disablement, role/visibility change | No unauthorized reuse of application/browser navigation caches | US2.6; FR-012 |
| Same slug/page/term or cached generation reused across projects | Slugs unique; content/cache scope isolated by repository and generation | US3.3,6; FR-014, FR-019 |
| Encoded/double-encoded traversal, hostile HTML/URLs, symlink, executable source | Reject at trust boundary; no escape, execution, or unsafe delivery | US3.5; FR-017 |
| Content/file-count/time/asset bounds at limit and beyond | Within-limit supported content accepted; out-of-limit candidate rejected safely | FR-018; test matrix |
| Intake storage failure before durable acceptance | Do not report accepted queued work; expose sanitized failure so retry is possible | US4.1; FR-022 |
| Duplicate/replayed delivery after restart, wrong repository/branch | No extra logical job and no unrelated ingestion/publication | US4.2; FR-021 |
| Concurrent/out-of-order jobs, lost lease, restart during publish | No stale overwrite, partial generation, or unauthorized publication; recover accepted work | US4.5-6; FR-023-025 |
| GitHub temporary outage/rate limit versus confirmed access loss | Temporary failure retains valid generation; confirmed access loss stops all serving | US4.4,7; FR-024, FR-026 |
| Full/unavailable storage or cleanup during reading | Fail candidate safely; retain valid state; protect active/in-flight generations | US4.4,8; FR-024, FR-027 |
| Private source becomes public upstream; public catalog becomes private | No automatic publication; enforce future delivery/cache authorization after change | US2.7; FR-013 |
| Malicious login return target or forged admin origin | Safe local return or rejection; no unauthorized mutation | US2.8, US5.2; FR-006, FR-028 |
| Reconfiguration points to a different source or required role | No serving old content under incompatible new source/authorization | US5.8; FR-030 |
| Delete races with a worker lease or live reader pin, or uses a stale edit version | Reject without removing the catalog; retry with the current version after work/read completion | US5.12; FR-029 |

## Requirements *(mandatory)*

### Functional Requirements

Every requirement is mandatory for complete v1. Story scenarios, edge cases, the test matrix,
and measurable outcomes define acceptance together.

- **FR-001**: Librarian MUST be a documentation reader and catalog administrator. Developers MUST
  author source documentation in GitHub; the portal MUST NOT write source content or provide an editor.
- **FR-002**: Each catalog MUST select exactly one GitHub repository, one branch, one documentation
  folder, and one unique route slug. Reading MUST use that catalog's published documentation.
- **FR-003**: The homepage and project selector MUST expose only explicitly configured safe directory
  metadata for enabled catalogs, identify Public/Private entries beside or below each title, and support
  directory name filtering. Cards MUST place sync status at lower right; an administrator's selection
  control and circular per-card sync action MUST occupy the card's upper left and upper right respectively.
  The directory toolbar MUST align search and batch actions with vertical centering and space between them.
  A catalog without a successful publication MUST appear as a non-navigable card; a sanitized,
  expandable issue is available when a sync failure exists. A previously successful compatible
  publication remains readable after a later failed sync.
- **FR-004**: Directory, overview, article, navigation, search, and administration journeys MUST
  provide usable loading, empty, unavailable, denied, and failure states as applicable. Directory,
  administration, and reader route loading MUST use layout-shaped skeletons where feasible; missing
  documents/assets MUST have a safe not-found outcome rather than unrelated content.
- **FR-005**: Anonymous users MUST be able to read enabled published public content, including its
  navigation, scoped search, metadata, and permitted local assets.
- **FR-006**: Private article entry MUST support Zitadel authentication and return to the requested
  valid local page; authenticated readers without permission MUST receive a clear access-denied screen.
- **FR-007**: Every private overview, article, navigation, search result/snippet, metadata response,
  and local asset delivery MUST require authenticated identity plus the configured repository reader
  role verified for the configured Zitadel project on the server, including direct requests.
- **FR-008**: The default private reader role MUST be `docs:{repo-slug}:reader`.
  `librarian-admin` MUST grant catalog administration only, never implicit private reader access.
- **FR-009**: Authorization MUST precede access to cached private content. Client presentation and
  routing checks alone MUST NOT provide the security boundary.
- **FR-010**: On the first protected request when verified roles are at least 15 minutes old,
  roles MUST refresh before delivery. Session renewal MUST NOT reset verification age. Failed refresh
  or absent permission MUST deny delivery until authentication and verified permission succeed.
- **FR-011**: Private content MUST NOT enter public static bundles, sitemaps, downloadable search
  indexes, public asset directories, shared public caches, or unguarded image optimization delivery.
  Private assets MUST be delivered through the authorized content boundary.
- **FR-012**: Logout, role removal subject to FR-010's deadline, catalog disablement, and visibility
  changes MUST invalidate or prevent affected application cache reuse, including browser navigation
  caches. Cached bodies MUST NOT restore access after it is denied.
- **FR-013**: Private GitHub sources MUST default to private in Librarian. Public publication MUST
  be an explicit reviewed decision; private-to-public publication MUST require explicit owner approval
  of intended documentation/assets. Upstream visibility changes MUST NOT automatically publish content.
- **FR-014**: Sidebar, breadcrumbs, previous/next navigation, table of contents, code-copy controls,
  and keyboard-accessible Search this project MUST operate within the selected repository.
  Switching projects MUST NOT retain another project's private navigation or results.
- **FR-015**: Relative article links, safe docs-root links, heading anchors, images, and attachments MUST resolve under
  the repository route within the configured documentation folder. Links to a protected destination
  MUST NOT bypass that destination's authorization.
- **FR-016**: Supported authoring MUST include `.md` and `.mdx` files containing Markdown/GFM,
  optional YAML frontmatter, headings/tables/lists/links/fenced code, optional navigation metadata,
  supported local images and attachments, and static `Info`, `Note`, `Warning`, `Columns`, `Card`,
  `Steps`, and `Step` components in `.mdx`. Component attributes are static strings except literal
  `Columns cols={1}` through `cols={4}` values. Optional navigation metadata MUST NOT be required.
- **FR-017**: Repository configuration, source/decoded paths, relative links, assets, frontmatter,
  navigation, and webhook inputs MUST be validated at their trust boundaries. MDX imports, exports,
  dynamic expressions, non-allowlisted components/attributes, unsafe HTML, symlinks, executable Git modes, submodules, and escaping paths MUST
  be rejected. Unrelated regular files MUST NOT be fetched into a generation. Source repository
  scripts MUST NOT execute and its dependencies MUST NOT be installed.
- **FR-018**: Ingestion MUST enforce documented bounds on content size, file count, processing time,
  and supported asset types. Planning MUST declare exact supported limits and boundary tests;
  exceeding a limit MUST fail safely without replacing the last valid generation.
- **FR-019**: Every content response MUST use a complete selected published generation; pages,
  navigation, assets, and search MUST agree on that selection. Cached content MUST be isolated
  by repository and published generation with bounded retention.
- **FR-020**: Source changes on the configured branch MUST be made available at runtime after
  successful synchronization without rebuilding the application image.
- **FR-021**: Webhook intake MUST verify signatures against original request bytes, durably
  deduplicate delivery identifiers, and match configured repository/branch before accepting work.
  Repeated/unrelated/invalid notifications MUST NOT create additional or unauthorized publication.
- **FR-022**: Accepted automatic/manual work MUST be durably queued before success acknowledgement.
  Intake MUST return after durable acceptance without doing full ingestion; work MUST survive restart.
  A failure to persist work MUST NOT be reported as successful acceptance.
- **FR-023**: Synchronization MUST validate an entire candidate before publishing an immutable
  generation. A partial candidate or older job MUST NOT replace the newer published result.
- **FR-024**: Invalid content and transient GitHub, worker, or storage failures MUST preserve the
  last successful generation and expose actionable sanitized admin status. If no valid generation
  exists, the catalog MUST report unavailable content rather than serve a partial candidate.
- **FR-025**: Work coordination MUST serialize ingestion and recover abandoned jobs after restart,
  including overlapping application instances. A worker that loses its lease MUST NOT publish.
- **FR-026**: Confirmed GitHub App removal or repository access loss, and catalog disablement,
  MUST stop all affected overview/article/navigation/search/metadata/asset delivery despite retained
  snapshots. Serving MUST resume only after administrator resolution and valid current configuration.
- **FR-027**: Caches, retained generations, jobs, and retries MUST have explicit finite bounds and
  recovery policies. Cleanup MUST preserve the active generation and snapshots needed by in-flight reads.
- **FR-028**: Administration views and mutations MUST require the configured project's
  `librarian-admin` permission. Mutations MUST enforce server-side validation and CSRF/origin
  protection; rejection MUST preserve existing valid state.
- **FR-029**: Administrators MUST configure source, branch, folder, slug, display title/public
  description, visibility, reader role, and enablement; slugs MUST be unique and avoid reserved
  application routes. The table/form MUST expose those fields without exposing credentials.
  Configured catalogs MUST be editable from a collapsed summary and removable through a confirmed,
  current-version-checked action that removes the settings document and its UUID-scoped snapshot.
  Removal MUST wait for no active worker lease or live reader pin and MUST retain permanent sync and
  replay receipts. Repository cards MUST provide small circular read-only view, edit, delete, and sync
  actions; delete MUST be disabled during editing. Sync status MUST appear at the card's lower right,
  and long commit identifiers MUST be visually shortened while keeping the full identifier available.
  The configuration form MUST be toggleable, close after successful creation with a success notice and
  refreshed cards, and stay open after failure with a collapsible error notice. Its description MUST be
  a bottom-positioned textarea and repository type MUST precede remaining configuration fields.
- **FR-030**: Catalog changes MUST preserve coherent source identity, visibility, reader permission,
  and publication. A snapshot from an incompatible previous configuration MUST NOT be served as
  current documentation; affected delivery/caches MUST obey the new valid configuration.
- **FR-031**: Administrators MUST request initial/manual synchronization through Sync now or a
  selected-directory batch action to recover missed notifications or failures. Each selected source
  MUST be admitted as its own durable job using the existing sync-job model. Manual requests MUST obey
  automatic intake's durable work, validation, authorization, lease, and safe publication rules.
- **FR-032**: Administration and the admin-enabled directory MUST distinguish pending, running,
  successful publication, and failure;
  show published commit and last successful sync; and provide readable actionable sanitized errors.
  Manual sync progress and resulting status MUST update without a page reload. Accepted notices MUST
  appear as info banners and dismiss after 10 seconds; the latest issue MUST use an error banner.
  Administrative status MUST NOT reveal private document bodies to an administrator without reader access.
  Selected and per-card directory sync actions MUST show active progress and update their status badges
  without a page reload. Accepted directory sync notices MUST use an info banner that dismisses after
  10 seconds; failures MUST use a red error banner and offer sanitized, expandable issue details.
  Administration MUST place its refresh action in an accessible icon-only button, show compact circular
  card actions, and place sync status at the lower right. A configured-repositories section heading MUST
  not be repeated when the page heading already identifies that list.
- **FR-033**: All reader/admin controls MUST support keyboard access, visible focus, accessible
  names, and usable mobile layouts. Shared navigation MUST provide Home and call the admin destination
  Repositories. System/light/dark themes MUST work. Directory columns and reader
  navigation MUST follow the agreed phone/tablet/desktop behavior; the generated Librarian icon and
  Perspective V footer mark MUST use the supplied original branding assets.
- **FR-034**: Secrets/tokens MUST NOT appear in catalog records, source control, client payloads,
  logs, or user-visible errors. Logs MUST redact private document bodies and identify relevant
  repository/job/delivery/generation context without leaking protected information.
- **FR-035**: Health reporting MUST identify operational status without sensitive information.
  Operations MUST permit diagnosis of failed synchronization and consistent recovery of catalog/job
  state together with published content.
- **FR-036**: Representative reading and ingestion MUST fit the agreed initial resource budget.
  Planning MUST define the representative corpus, load, measurements, and pass criteria before
  implementation; capacity increases MUST follow measured evidence and explicit scope review.
- **FR-037**: Production readiness MUST require live DEV authentication/role refresh/logout,
  GitHub sync, persistent-state recovery, browser verification, resource measurements, and
  health/rollback proof. Controlled tests MUST NOT be represented as verified live integrations.
- **FR-038**: Delivery MUST preserve a previous application version/configuration and a consistent
  database/content backup for recovery. Live infrastructure changes, credential provisioning,
  private publication, image publication, and deployment MUST require explicit approval of the
  concrete scope and the agreed DEV-before-production sequence.

### Mandatory Automated Tests and Coverage

- **QG-001**: Functional changes MUST include automated acceptance tests; functional bug fixes MUST
  include a regression test demonstrating the defect before the fix. Isolated presentation-only UI
  changes that preserve behavior/data flow do not require new tests, and their test work MUST be
  deferred unless the owner asks. Specifications and task lists MUST retain tests for functional
  behavior; optional-test template wording MUST NOT waive those obligations.
- **QG-002**: Coverage MUST be at least **95% separately for statements, branches, functions, and lines**
  across all first-party executable application code, including worker, delivery handlers,
  authorization, rendering adapters, and administration logic, including unexecuted source files,
  for functional changes and complete v1 release. A standalone presentation-only change has no new
  coverage gate.
- **QG-003**: The same four independent 95% thresholds MUST apply to each feature's implementation
  file set declared in its plan and checked in CI for functional work. This single v1 specification MUST NOT let an
  overall average conceal an untested staged capability; planning MUST declare the scope for each
  implemented functional feature/capability and its coverage checks. Presentation-only changes are
  exempt from new coverage work.
- **QG-004**: CI MUST fail for any applicable threshold below 95%, any required test failure, or a
  missing coverage report for functional feature and full v1 gates. Enforce these gates from the
  first functional executable feature onward. Reports
  MUST state source scope, exclusions, and all four metrics. An empty suite/missing instrumentation
  MUST NOT pass; a metric with no applicable items requires an explicit explanation.
- **QG-005**: Only generated, third-party, test, and purely declarative code MAY be excluded with
  documented reasons. First-party runtime logic MUST NOT be excluded or annotated away to meet the
  gate. Placeholder assertions, blanket mocking of tested behavior, skipped required tests, and
  retrying until failure disappears MUST NOT be used to make the gate pass.
- **QG-006**: For functional changes, unit tests MUST cover isolated logic; integration tests MUST exercise actual
  application/storage boundaries, job/lease behavior, and filesystem snapshots as applicable;
  browser tests MUST cover affected reader/admin behavior. Presentation-only UI changes do not
  require new browser tests. Synthetic private fixtures MUST be used.
  Provider contract fixtures in CI MUST be supplemented by live DEV compatibility proof before production.
- **QG-007**: All applicable functional scenarios in the matrix below MUST be automated for v1;
  coverage percentage does not substitute for security/recovery evidence. Functional feature and
  full v1 completion require acceptance tests, all applicable coverage gates, type checks, lint checks,
  and production build to pass. Presentation-only changes are exempt from new test/coverage work.
  Documentation/configuration-only changes require appropriate validation without artificial coverage.

### Required Security and Recovery Acceptance Matrix

These are required outcomes for future executable tests, not reports of tests already run.
US references use story/scenario numbers, for example US2.4 means Story 2, scenario 4.

| ID | Required scenario set | Pass condition and trace |
|---|---|---|
| ST-01 | Public, anonymous-private, authorized-private, wrong-role, expired-role (successful and failed refresh), wrong-project, administrator-without-reader across overview/articles/navigation/search/metadata/local assets | Public/authorized delivery works only with valid fresh permission; every unauthorized case delivers zero private bytes, even direct or cached requests (US2; FR-005-011) |
| ST-02 | Verification immediately below, exactly at, and above 15 minutes; renewed session; refresh failure and role removal | First request at/after deadline verifies before delivery; renewal does not extend age; failed/removed permission denies (US2.4-5; FR-010) |
| ST-03 | Logout with back/forward navigation; role removal; disablement; public/private visibility changes; cached search/assets | No affected application/browser cache restores denied content; public change needs owner approval (US2.6-7, US5.7-8; FR-012-013, FR-026) |
| ST-04 | Equal paths/terms in separate repositories and generations; project switching; direct asset/image requests | No cross-project result/body/asset leakage or mixed-generation output (US3; FR-009, FR-011, FR-014-019) |
| ST-05 | Markdown/GFM and allowlisted static Fumadocs MDX components; imports/exports/dynamic expressions, unknown components/attributes, unsafe HTML, invalid frontmatter/navigation, symlinks, executable modes, submodules, escaping/encoded paths, hostile link/asset values | Safe `.mdx` is rendered; unsafe candidates are rejected without code execution, escaping delivery, or replacing valid publication (US3.5, US4.4; FR-016-018, FR-024) |
| ST-06 | Missing/bad signature, changed original bytes, duplicate delivery including restart, wrong repository/branch, unavailable intake storage | No invalid/unrelated work; duplicates add no logical job; acknowledgement requires durable work (US4.1-2; FR-021-022) |
| ST-07 | Concurrent/reordered notifications, multiple/overlapping workers, lost lease, restart before/during publication | No stale overwrite or partial generation; former lease holder cannot publish; abandoned accepted work recovers (US4.5-6; FR-023-025) |
| ST-08 | Invalid/empty/missing content, GitHub outage/rate limiting, worker error/restart, full/unavailable storage; retry/manual resync | Last valid generation retained; first-sync failure unavailable; admin error actionable; successful retry restores valid publication (US4.4, US5.4-6; FR-024, FR-031-032) |
| ST-09 | Confirmed App removal/access loss versus transient failure; catalog disable/reenable | Loss/disable blocks all delivery; transient error preserves permitted last-good reads; restoration requires resolved access/current configuration (US4.7, US5.7; FR-026) |
| ST-10 | Invalid catalog fields, duplicate/reserved slug, reader-only admin, wrong-project admin, forged origin/CSRF, malicious login return target, unauthorized/stale deletion | No unauthorized mutation, partial configuration, external redirect, or implicit admin reader access (US2.3,8, US5.1-3,8,12; FR-006, FR-008, FR-028-030) |
| ST-11 | Publication during reading/search/assets; active/in-flight snapshot cleanup and catalog removal; content/file/time/type limits at and beyond bounds | Coherent responses, safe retention, bounded work, and safe failure without destroying valid state (US3.6, US4.8, US5.12; FR-018-019, FR-027, FR-029, FR-036) |
| ST-12 | Directory filter/empty states, Markdown/nav/link/anchor/code-copy journeys, mobile/keyboard/focus/themes, denied/error admin states | All required reader/admin journeys usable without protected metadata/body exposure (US1, US3, US5; FR-003-004, FR-014-016, FR-033) |
| ST-13 | Secrets/private-body sentinel checks in records, user errors, responses, logs, public exports/bundles/search indexes; health output | No secrets/private bodies escape; operational health/errors remain actionable and non-sensitive (FR-011, FR-032, FR-034-035) |
| ST-14 | Separate live DEV integration, resource measurement, consistent backup/recovery, health and previous-version rollback | Required production evidence recorded separately from CI fixtures; only approved scoped operations proceed (FR-036-038; QG-006-007) |

### Scope and Agreed Architecture References

The agreed brief and constitution are binding planning inputs; this specification defines outcomes
rather than selecting new libraries, schema, endpoints, or algorithms. The later plan MUST include
a Constitution Check and honor:

- [Constitution: Architecture and Scope Constraints](../../.specify/memory/constitution.md#architecture-and-scope-constraints):
  chosen stack, runtime Markdown loading, separate application ownership, catalog/job persistence,
  immutable snapshots outside public delivery storage, same-container worker, and agreed route boundaries.
- [Brief: Application, ingestion, and access control](../../docs/requirements/v1-requirements.md#3-application-ingestion-and-access-control):
  approved interfaces, read-only GitHub App permissions, short-lived installation tokens, scoped
  database/user, and production secret handling.
- [Brief: UI direction](../../docs/requirements/v1-requirements.md#2-ui-direction-from-the-showcase):
  standard reader components, discovery/reader/project-selection layout direction, original assets,
  directory columns, and responsive accessible behavior.
- [Brief: Implementation and deployment sequence](../../docs/requirements/v1-requirements.md#4-implementation-and-deployment-sequence):
  initial 0.5 CPU / 512 MB, one replica on the persistent-volume node, no added queue/worker deployment,
  builds outside the VPS, existing image registry, separate DEV validation, and reversible deployment.
  Infrastructure descriptors/networks/secrets/deployment scripts remain in the infrastructure repository.

V1 excludes additional Git providers, a documentation editor/source writes, AI Q&A, page-level
access control, automatic GitHub-contributor-to-Zitadel role mapping, upstream component forks,
and an additional queue service or dedicated worker deployment. Adding these requires an explicit
scope decision consistent with constitutional governance.

### Staged Delivery and Dependencies

| Stage | Required delivery and evidence | Dependency / boundary |
|---|---|---|
| 1. Fixture directory and reader | Discovery, safe directory metadata, Markdown reader, navigation/search/link/asset fixtures, accessibility, functional tests/coverage from first functional executable work | US1 and US3; synthetic catalogs; no live private publication |
| 2. Prove public/private boundary | Verified identity/roles, all protected paths, freshness, cache/logout/visibility tests | US2; release gate before private production delivery |
| 3. Ingestion and administration | Durable sync, immutable publication, concurrency/recovery, registration/status/manual sync | US4 and US5; preserves proven authorization; story order does not block configuration fixtures |
| 4. Prepare sources | Agreed docs folders, review `.mdx` against the safe static component allowlist, convert only unsupported constructs, explicit content-scope approval | Owner/source access required; source work remains in its own repository |
| 5. Package application | Versioned standalone application image and resource/health/recovery evidence | All preceding acceptance gates; image publication separately approved |
| 6. Integrate infrastructure | Scoped persistence/secrets/networking, separate DEV trial, rollback/consistent backup, production handoff | Infrastructure repository owns descriptors; concrete approval and live revalidation required |

Completing a stage does not mark complete v1 readiness. Later plans/tasks MUST retain every
story, requirement, test gate, and production acceptance criterion in this single specification.

### Key Entities *(include if feature involves data)*

- **Catalog**: A configured repository/branch/folder/route with safe directory metadata, visibility,
  reader role, enablement, current publication, and sync status. It contains no credentials.
- **Reader identity and verified permission**: Authenticated identity, configured project, verified
  roles, and last successful verification time; administration and repository reading are independent.
- **Documentation generation**: Complete immutable set of articles, overview/navigation, local assets,
  and scoped search data for a source commit; a catalog selects its published generation.
- **Document or asset**: A validated path and supported content within a catalog's documentation
  folder and generation; private delivery inherits the catalog authorization.
- **Sync delivery/job**: Durable accepted work, source/branch and delivery identity, lifecycle,
  ownership/lease, attempts, and sanitized failure; links work to its candidate/published generation.
- **Publication decision**: Explicit visibility configuration and required owner approval for private
  publication; upstream repository visibility does not replace this decision.

## Success Criteria *(mandatory)*

### Measurable Outcomes

All counts apply to the declared acceptance corpus and identities, not a claim about untested
live environments. Planning defines workload and operational bounds as required below.

- **SC-001**: Every configured enabled acceptance catalog appears once with its correct safe
  metadata, route, Public/Private label, and sync badge in the specified card positions; first-sync
  failures cannot navigate while a previously published generation remains available after a later
  failure. Name filtering returns every matching catalog and no nonmatching catalog or article-content
  search result (US1; FR-002-003).
- **SC-002**: 100% of supported published public fixture articles and assets are readable anonymously;
  every required directory/reader/navigation/search journey completes on phone, tablet, and desktop
  with keyboard access and system/light/dark themes (US1, US3; FR-004-005, FR-014-016, FR-033).
- **SC-003**: Across the complete protected-path/identity matrix, unauthorized users receive zero
  private document, navigation, search, metadata, or asset bytes, including cache/back-navigation
  attempts; all authorized positive cases succeed (US2; ST-01, ST-03-04).
- **SC-004**: A permission removed after verification cannot authorize any protected request whose
  verification age is at least 15 minutes; the exact deadline refreshes and failed refresh delivers
  zero protected bytes. Renewing a session never extends this window (US2.4-5; ST-02).
- **SC-005**: Every scoped search hit, local document link, heading anchor, and supported asset in
  the accepted fixture corpus resolves to the intended project/generation; zero cross-project
  private results or mixed-generation responses occur (US3; ST-04, ST-11).
- **SC-006**: Every accepted valid source change becomes a complete published generation without
  an application image rebuild; all pages/navigation/assets/search agree on its publication.
  No test publishes a partial candidate or lets an older job overwrite a newer result (US4; ST-07, ST-11).
- **SC-007**: Invalid signatures and unrelated source/branch deliveries create zero accepted jobs;
  replaying an accepted delivery, including after restart, creates zero additional logical jobs.
  Every success acknowledgement corresponds to durable work (US4.1-2; ST-06).
- **SC-008**: In every required transient-failure/restart/lost-lease scenario, valid publication is
  preserved and accepted work remains recoverable; a subsequent successful manual sync publishes
  valid content. Confirmed access loss or disablement yields zero content deliveries on all paths
  until resolved (US4, US5; ST-07-09).
- **SC-009**: Every required administration task, including safe repository removal, completes for administrators and is denied for
  reader-only/anonymous/wrong-project identities; table status distinguishes all four work states,
  publishes the correct commit/time, and rejected mutations preserve valid configuration (US5; ST-10).
- **SC-010**: 100% of private-to-public acceptance cases require explicit owner approval; upstream
  visibility changes alone cause zero portal publications (US2.7, US5.8; FR-013).
- **SC-011**: Every functional feature has required acceptance tests, and every functional bug fix
  has its regression test. Standalone presentation-only changes that preserve behavior/data flow do
  not require new tests or coverage. For functional work and complete v1, all applicable statements,
  branches, functions, and lines coverage results are at least 95% independently, both globally and
  within every declared implementation scope; deliberately failing an applicable gate or omitting
  its report prevents completion (QG-001-007).
- **SC-012**: The planning-declared representative reading/ingestion workload completes within
  the initial 0.5 CPU / 512 MB budget without resource exhaustion or loss of valid publication;
  declared content/retention/retry bounds are observed and active/in-flight content survives cleanup
  (FR-018, FR-027, FR-036).
- **SC-013**: Live DEV evidence proves authentication, role refresh, logout, source sync, and browser
  journeys; recovery restores a consistent catalog/content set and rollback restores a healthy
  previous version. No live prerequisite is represented as satisfied by controlled fixtures
  (FR-035-038; ST-14).
- **SC-014**: All secret/private-body sentinel checks yield zero exposures in disallowed records,
  outputs, exports, errors, or logs; health and sync failures remain diagnosable (ST-13).

## Assumptions

### Documented Product Defaults

- Readers use enabled catalogs. Disabled catalogs are hidden from discovery/selection and cannot
  deliver content; administrators can still inspect their configuration/status.
- Directory name filtering is case-insensitive substring matching of configured display titles;
  it does not inspect source articles. Empty input restores all enabled cards.
- An enabled catalog with no published generation has an unavailable/pending state and no content.
  An empty or missing documentation folder is an invalid sync candidate; it cannot erase last-good content.
- Source authoring/conversion remains developer work in source repositories. V1 reads only the
  agreed safe Markdown/MDX format in FR-016; it does not provide an editing or conversion service.
- Changing source identity or visibility must not pair old content with incompatible new settings.
  Planning will define atomic configuration/publication handling satisfying FR-030.
- Existing authorized downloads and previously public copies cannot be recalled. Logout and
  visibility requirements concern subsequent portal delivery and reuse through application-managed
  caches, including navigation; this limitation does not permit private cache leakage.
- All stories remain complete v1 scope. Fixture demonstrations are development milestones,
  not evidence of live compatibility, readiness for private publication, or owner approval.

### External Dependencies

- Selected source repositories, agreed documentation folders, and GitHub App installation with
  read-only content access, limited subscriptions, and short-lived installation tokens must be available.
- Zitadel must provide identities and verified role claims for the configured project; an owner
  must assign administrator and repository-reader roles separately.
- The approved persistence/content storage, scoped application access, production secret mechanism,
  existing image registry, DEV hostname, and infrastructure-owned deployment path must be provisioned
  or revalidated during their authorized stages. No real credentials or live values are in this spec.
- Dependency/runtime-loading compatibility and suitable existing component/container patterns must
  be inspected during planning. Agreed architecture cannot be silently changed to bypass incompatibility.

### Planning Decisions and Readiness

There are no blocking product-scope or authorization decisions requiring clarification.
The defaults above are explicit assumptions, not changes to the agreed architecture.

The later plan MUST resolve and record, before relevant implementation:

1. Exact supported `.md`/`.mdx` and asset limits, accepted asset types, path/navigation/link handling,
   and boundary tests for each limit; no source-folder escape or executable content may be permitted.
2. Finite cache/snapshot/job/retry retention, lease and recovery timings, and coordination rules
   protecting active/in-flight generations and avoiding stale publication.
3. Representative corpus and concurrent reading/ingestion workload, responsiveness targets, resource
   measurements, and concrete operational pass/fail procedures for SC-012.
4. Compatible pinned dependencies and runtime loading, source preparation needs, configured identity
   project/role verification, current infrastructure prerequisites, and secure owner publication approval.
5. Stage/capability implementation file scopes, test commands and fixtures, separate global/per-scope
   coverage enforcement, live DEV evidence, consistent backup/recovery, and rollback verification.

These are planning obligations with fixed required outcomes, not open permission to weaken
security, functional acceptance tests, the four 95% thresholds for functional work/full v1, or the
complete v1 scope. Isolated presentation-only changes follow the explicit exception in Principle V.
