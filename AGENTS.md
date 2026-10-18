# AGENTS.md

## Purpose and Authority

These are the repository-wide operating instructions for coding agents working on
Librarian. They adapt the relevant practices from [Contabo's agent guidance](../contabo/AGENTS.md)
to this application; Contabo's host inventory and internal paths are not Librarian defaults.

Follow system/developer instructions and explicit user instructions first. Nested
`AGENTS.md` files may refine directory-specific practices. Within project governance,
[the adopted constitution](.specify/memory/constitution.md) governs specifications,
plans, tasks, reviews, and implementation. This file and nested guidance MUST NOT
silently waive its security, testing, coverage, or deployment obligations. Resolve
conflicts explicitly; changing the constitution requires its amendment procedure.

## Read the Existing Project State

Before planning or editing, read only the relevant sources:

- `.specify/memory/constitution.md`: adopted principles and non-negotiable gates.
- [docs/requirements/v1-requirements.md](docs/requirements/v1-requirements.md): agreed
  product scope, architecture constraints, implementation sequence, acceptance
  criteria, and deployment boundaries (formerly root `plan.md`).
- `.specify/feature.json`, when present: the current feature directory.
- The relevant `specs/<feature>/spec.md`, `plan.md`, `tasks.md`, contracts, research,
  and checklists, when present: feature requirements and implementation state.
- Existing code, configuration, package scripts, tests, and affected callers.

`docs/planning/constitution-draft.md` is preparation material, not the adopted
constitution. References in the constitution to the former root `plan.md` refer to
`docs/requirements/v1-requirements.md`; confirm this mapping if the documents move again.
Do not create Contabo-style `docs/state/` files or a second state ledger here.
Update the applicable feature tasks, checklists, and documentation as work is
verified; never mark planned or mocked behavior as implemented or live-verified.
Preserve unrelated working-tree changes and existing feature artifacts.

## Project and Repository Boundaries

- Librarian owns the separate Next.js/Fumadocs application, its tests, and application
  packaging. Developers continue authoring documentation in source GitHub repositories.
- Follow the chosen Auth.js/Zitadel, official MongoDB driver, GitHub App, persistent
  snapshot storage, and runtime Markdown loading architecture in the constitution.
  Verify compatible dependencies during planning; do not invent package versions.
- Reuse suitable components and patterns from `contabo-server-setup/docs` after
  inspection. Confirm the actual checkout path before relying on a sibling folder.
- Swarm/Traefik descriptors, networks, secrets, and deployment scripts belong in the
  infrastructure repository, `contabo-server-setup`. Do not relocate them here or
  edit sibling repositories outside the authorized task scope.
- Do not add excluded v1 features, upstream forks, duplicate services, queue systems,
  dependencies, or abstractions without a current requirement and explicit scope decision.

## Spec Kit Workflow

Use the installed `.agents/skills/speckit-*` instructions for the requested workflow.
Keep constitution, specification, planning, task generation, and implementation work
within the scope of their respective commands. A request to write a specification
or plan does not authorize implementing the application or deploying it.

- Feature specifications MUST include testable user stories, access-control impact,
  failure/recovery behavior, and mandatory tests/95% gates for changed functional
  behavior. Isolated presentation-only UI work follows the exception in Principle V.
- Feature plans MUST define affected files/interfaces, inputs/outputs, dependencies,
  edge cases, validation commands, feature coverage scope, and operational rollback
  when relevant. Use the Constitution Check to expose conflicts before implementation.
- Task lists MUST include required test and coverage work for functional features.
  Do not add or run tests for presentation-only changes unless the user asks; defer
  that test work until requested.
- Do not modify installed Spec Kit skills or template sources unless requested.
  Use the existing template resolver when the workflow requires it.
- Do not create Git branches, commits, pushes, or releases unless explicitly requested.
  Creating a Spec Kit feature directory does not itself authorize a Git branch or commit.

## Inspect Before Editing and Finish the Scoped Work

Keep synchronization status badges at the bottom left of homepage and repositories
cards, including their skeletons. Both page skeletons show three consistent cards
without error placeholders. Preserve this placement during future UI changes.

Inspect current behavior and every affected caller, route, configuration, fixture,
and interface before changing shared logic. Preserve required behavior and validation.
For migrations, map existing behavior to the replacement and identify recovery needs.

Make the smallest complete change. Reuse existing code and installed dependencies;
avoid speculative refactoring, unrelated fixes, duplicate documentation, and extra
configuration. Fix an unrelated issue only when requested or when it directly blocks
the task, and explain why it is necessary.

Proceed through ordinary local DEV steps without repeated confirmation. Ask only
when a missing decision blocks safe or correct work; inspect the repository first and
group blocking questions. Complete authorized work and its required verification.

## Testing and Completion Gates

Changes to functional behavior MUST ship with automated acceptance tests. Functional
bug fixes MUST include a regression test demonstrating the defect before the fix.
Presentation-only UI changes that preserve existing behavior, data flow, and access
control do not require new tests or coverage work; defer all test authoring and
execution for them until the user asks. Do not add tests that only assert utility
classes for visual styling.

For functional feature and v1 release completion, enforce at least **95% separately
for statements, branches, functions, and lines**:

- Across all first-party executable application code, including unexecuted files.
- For each feature's implementation file set declared in its plan.
- In CI, failing on any applicable threshold below 95%, required test failure, or
  missing coverage report. Apply the constitution's documented exclusion rules.

Use unit, integration, and browser tests appropriate to changed functional behavior.
Security tests MUST exercise all protected delivery paths and relevant negative
cases. Ingestion tests MUST verify signatures, deduplication, concurrency/leases,
restart recovery, invalid content, upstream failure, and preservation of the last
valid generation. The constitution defines the complete required scenario set.

Run lightweight, targeted checks while developing. Before declaring a functional
feature complete, run its acceptance tests, applicable coverage gates, type checks,
lint, and production build. Standalone presentation-only changes do not require new
test or coverage runs. Targeted checks do not replace functional feature gates.
Use actual repository scripts once available; do not claim nonexistent commands ran.

Investigate validation failures, fix in-scope causes, and report unresolved blockers.
Do not weaken assertions, remove failing tests, exclude runtime code, skip required
tests, or retry away failures to make a gate pass. Documentation-only changes require
appropriate content/link/diff validation, not artificial application coverage.

## Private Content and Secrets

Apply server authorization to pages, navigation, metadata, search, and assets before
reading cached private content. An administrator is not automatically a private
reader. Preserve the 15-minute verified-role freshness deadline and fail closed
after it when refresh fails. Test logout/back navigation and cache isolation.

Keep snapshots outside `public`; never publish private fixtures, documents, assets,
or indexes into static bundles, sitemaps, public caches, or unguarded asset routes.
Use synthetic fixtures. Treat Git content and external input as untrusted; reject
executable content, unsafe HTML, symlinks, and escaping paths. Do not execute source
repository scripts or install source repository dependencies.

Never expose credentials, tokens, keys, private document bodies, database dumps,
volume archives, or live environment values in Git, logs, command output, plans,
documentation, or responses. Tracked environment examples MUST contain placeholders.
Production root/database/session/OAuth/bootstrap secrets MUST use scoped Swarm
secrets. Eligible provider credentials use the constitution's authenticated-encrypted
MongoDB storage and explicit legacy migration policy. Verify ignore rules before
writing local secret files; ignored files are not automatically safe to print.

Do not fabricate missing secrets or ask for their values in chat. Request provisioning
through the approved secret mechanism when required. Treat credentials committed to
Git as compromised; report the exposure without repeating values and obtain approval
for account-sensitive rotation/revocation and history remediation.

## DEV and Production Operations

Default to local DEV. Clearly identify the target of commands that affect an
environment, and keep local DEV and VPS / PROD operations in separate execution blocks.
A remote DEV hostname still uses shared infrastructure; deployment or configuration
changes there require explicit approval. Relevant read-only production inspection
and rollback planning are allowed.

Explicit approval is required for live infrastructure changes, credential provisioning,
private-content publication, image publication, and production deployment. This
includes service restarts/updates, Swarm mutations, production secrets/configuration,
firewall/network changes, system packages, destructive migrations, volume deletion,
data deletion, and Docker pruning. A general implementation request is not approval
for these operations.

Before requesting approval, inspect current state, prepare the concrete change,
validate locally when practical, and identify rollback. Execute only the approved
scope, then complete health and browser verification without redundant approval.
Never treat an unverified Compose configuration as a working Swarm rollback path.

Build images outside the VPS. Keep versions and the prior image/configuration for
rollback. Before an approved deployment, revalidate the live service, actual checkout,
Gitea authentication, Zitadel settings, MongoDB connectivity, and storage. Follow
the established `ssh contabo` deployment path and the infrastructure repository's
own operating rules. Validate on a separate DEV hostname before replacing production.
Back up database state and content storage as a consistent recovery set.

## Resource and File Discipline

Use the planned initial **0.5 CPU / 512 MB**, one replica, persistent-volume placement,
and same-container worker constraints. Revalidate live settings before deployment;
these limits are a design baseline, not proof of current capacity or performance.
Measure representative reading and ingestion before proposing a resource increase.

Bound caches, retained generations, logs, content inputs, job retries, and background
activity. Preserve active snapshots and in-flight readers during cleanup. Prefer
event-driven synchronization, efficient queries, lightweight images, minimal runtime
dependencies, and existing services. Avoid unnecessary rebuilds, pulls, container
recreation, polling, restart loops, and volume churn.

Use existing files before adding new ones. Keep required reports sanitized. Remove
only disposable artifacts created by the task once they are no longer needed;
preserve user files and required evidence. Do not commit runtime snapshots, backups,
database dumps, credentials, or temporary investigation output. Regenerate machine
outputs from their source when a supported generator exists.

## Final Verification and Reporting

Before completion, confirm scope, preserved behavior, required tests/coverage,
constitution compliance, accurate feature state, environment boundaries, and any
remaining blocker. Do not report partially implemented work as complete.

Report what changed, where, why, and the actual validation results concisely. Separate
local/mocked evidence from live integration, performance, and deployment evidence.
State skipped checks and material remaining risks; never claim an operation ran or
a check passed without evidence.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
