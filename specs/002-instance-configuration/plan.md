# Implementation Plan: Librarian v2 Secure Installation and Instance Settings

**Git branch**: `main` (unchanged) | **Feature**: `002-instance-configuration` | **Date**: 2026-10-19 | **Spec**: [spec.md](spec.md)

**Status**: Phase 0 research and Phase 1 design complete. Ready for requirement-mapped task generation; application implementation, functional verification and release remain outstanding.

## Summary

Extend the existing application with protected first-run setup, encrypted durable provider configuration, explicit instance administration, revision-aware runtime activation and non-destructive legacy import. Use `/repositories/setup` and `/repositories/settings` under the existing reserved application namespace. Provider credentials/private keys live encrypted in MongoDB; independent database/encryption/session/OAuth/bootstrap root inputs remain host-managed. Settings requires both an explicit issuer/subject binding and the configured project's `librarian-instance-admin` role.

Preserve Git-based authoring, runtime Fumadocs loading, every private delivery boundary, separate catalog/reader roles, GitHub read-only ingestion, durable receipts/leases, active immutable snapshots, bottom-left sync badges and three-card skeletons. Reuse Node crypto, MongoDB driver, Zod, Auth.js and existing UI/test helpers. Add no dependency or service.

Input authority: [constitution v3.0.0](../../.specify/memory/constitution.md), [v1 requirements](../../docs/requirements/v1-requirements.md), current v2 spec and its [73-ID reconciliation](requirements-traceability.md). Owner answers dated 2026-10-19 resolve D1-D3; the explicit major constitutional amendment records credential-storage/instance-authority approval without authorizing any live credential or infrastructure operation. Original 001 artifacts and unrelated working changes remain intact.

## Technical Context

**Language/Version**: TypeScript 5.9.3; Node declared `^22.18.0 || ^24.11.0 || >=26.0.0`; existing CI uses Node 22.23.3.

**Primary Dependencies**: Next.js 16.4.0, React/DOM 19.3.0, next-auth 5.0.0-beta.32, Auth MongoDB adapter 3.11.3, MongoDB driver 6.21.0, Fumadocs core/UI 16.15.18, local-md 0.3.5, Zod 4.3.6. Installed peer metadata was inspected during research; no upgrade needed. This is design compatibility, not new runtime/provider acceptance.

**Storage**: Existing dedicated MongoDB database including standalone support; one bounded atomic instance-control document, expiring setup sessions and bounded audit history. Persistent content snapshots remain outside public; protected host marker/root keys remain outside MongoDB and static bundles.

**Testing**: Existing Vitest unit/integration/client/container infrastructure, Playwright Chromium/Firefox/WebKit, provenance-aware coverage and GitHub Actions. Extend existing C1-C6 with exact C7 feature membership; do not mask unexecuted files.

**Target Platform / Project Type**: Existing Next.js application, Linux standalone container, same-container worker; local isolated DEV first. Production infrastructure remains infrastructure-owned.

**Performance Goals**: Preserve inherited BG-01 workload: three catalogs of 500 pages/100 assets each, 50 KiB average pages/10 MiB assets per catalog; ten readers at 20 requests/s for 15 minutes during sync/restart/retention pressure. Warm page p95 <=2 s, search <=1 s, durable acknowledgment <=2 s, cold <=5 s, publish <=120 s, worker recovery <=45 s. Include v2 overhead and gate/admission pressure before release; these are acceptance targets, not results.

**Constraints**: One replica, 0.5 CPU / 512 MB baseline, fixed persistent-volume placement, bounded inputs/caches/jobs; standalone atomicity and v2-aware overlap; 15-minute verified-role deadline; no secrets/private bodies in public payloads/builds/logs. Configuration limits are fixed policy in research, not new tunable UI options.

**Scale/Scope**: Five v2 stories, V2-FR-001-036, V2-QG-001-008, V2-SC-001-014, affected original v1 scenarios and explicit IN-01/BG-01-03. No Redis, new renderer/provider, multi-tenant service, broad GitHub permissions, editor or unrelated UI redesign.

## Constitution Check

**Pre-research gate: PASS after owner decisions and recorded amendment. Post-design gate: PASS for the proposed design; implementation/live gates remain mandatory.**

| Principle | Pre-research disposition | Post-design evidence / acceptance obligation |
|---|---|---|
| I: Git source of truth | Existing authoring/reader scope preserved | No source editing/write scopes; defaults never rewrite catalogs |
| II: Private server boundary | Binding+instance role distinct from catalog and reader | Shared authorization before cached content; epoch-bound auth, exact freshness, all private paths/logout/back regressions |
| III: Secrets/authority | D1/D2 approved; constitution v3.0.0 records amendment | Independent host root key, instance/purpose-bound authenticated envelopes, no reveal, explicit legacy import and owner continuity |
| III: Routes/untrusted input | D3 uses already reserved repositories namespace | No root aliases/new slug reservations; strict bounded schemas, pinned outbound checks, CSRF/origin/state; preserve static parse-only AST grammar |
| IV: Complete recoverable generations | Existing leases/immutable snapshots retained | Admission barrier plus per-catalog fences, standalone crash/race tests, retained receipts/last-good snapshots |
| V: Tests and four 95% metrics | Functional feature, no presentation exception | C7 plus affected C1-C6/global gates, unexecuted source inventory, required security/integration/browser cases; fail absent reports |
| VI: Accessible existing UI | Reuse Fumadocs/forms/navigation patterns | Keyboard/mobile/focus/theme/loading/error journeys; bottom-left badges and consistent skeletons preserved |
| VII: Bounded reversible operations | Existing CPU/memory/single worker/deployment ownership | Explicit session/request/activation/check/audit/rotation limits, maintenance recovery, approved DEV/live/release evidence separate |

Static MDX remains an untrusted data AST. `lib/content/validate.ts` rejects ESM and text/flow expressions and never evaluates source; finite named components/static attributes are rendered through trusted components. Literal Columns counts are parsed values, not executable source. This conforms to the executable-content prohibition; no new grammar or constitutional waiver is introduced.

## Project Structure

### Documentation

```text
specs/002-instance-configuration/
  spec.md
  requirements-traceability.md
  checklists/requirements.md
  plan.md
  research.md
  data-model.md
  contracts/instance-api.md
  contracts/configuration.md
  quickstart.md
```

`tasks.md` is deliberately deferred to speckit-tasks. No second state ledger or changes to installed skills/templates are needed.

### Source and interface design

New paths below are proposed implementation files, not files generated by planning. Keep this existing app/lib/components structure; avoid a parallel service or generic settings framework.

| Area / planned files | Responsibility and interfaces | Existing callers and recovery impact |
|---|---|---|
| `lib/instance/bootstrap.ts`, `store.ts`, `secrets.ts` | Load host prerequisites; classify lifecycle; strict typed bounded control document/CAS; independent provider encryption | `lib/config.ts`, `lib/mongo.ts`; build/import remains credential-free; missing storage/key/marker never resets state |
| `lib/instance/access.ts` | Setup authorization/session/CSRF/rate quotas; binding+role and protected enrollment; epoch-aware admission | Reuse `lib/auth/admin.ts`, `authorization.ts`, `roles.ts`, `adapter.ts`, `tokens.ts` mechanics; do not alias instance authority to catalog admin |
| `lib/instance/validation.ts` | Bounded pinned provider transport, typed checks and owner proof | Candidate and active Auth.js/GitHub/role transports; avoid a check-only SSRF defense bypassed by runtime requests |
| `lib/instance/activation.ts` | Exclusive gate/CAS, adoption, per-catalog fences, bounded reconciliation and migration | `auth.ts`, `instrumentation.ts`, worker startup/jobs/worker, webhook, generations/blob cleanup and health |
| `app/repositories/setup/page.tsx`, `app/repositories/settings/page.tsx`, `components/instance-setup.tsx`, `components/instance-settings.tsx` | Dedicated server authorization and grouped accessible forms; explicit save/test/activate states | Root layout/navigation/homepage use safe active preferences; preserve `/repositories` catalog console and reader routes; no shared layout guard may block authorized fresh setup |
| `app/api/instance/**/route.ts` | Only routes enumerated in instance-api contract; strict handlers delegating to the above modules | Independent server guards for every route, bounded safe errors, candidate Auth.js namespace separate from runtime `/api/auth` |
| `scripts/instance-operator.mjs` | Local protected prepare/enroll/transfer/recover/rotate-key operations | No public reset; no live execution/provisioning authorized now; host-only key/marker changes with safe audit |
| Coverage/artifact tooling and docs | Add C7 enforcement, v2 artifact selection, controlled fixtures and installation/admin/config/secret/migration/recovery guides | Preserve original 001 validation and exact source membership; sanitized local self-hosting Compose example as documentation, no production descriptors |

API prefix is `/api/instance`; exact endpoint inputs/outputs/roles/status codes are in [instance-api.md](contracts/instance-api.md). Host variable names, precedence, classification, cutover and recovery are in [configuration.md](contracts/configuration.md). Entity types/indexes/transitions are in [data-model.md](data-model.md). Research records decisions, evidence and alternatives without creating executable code.

## Design Decisions and Bounds

- Use one <=512 KiB instance-control document with complete active/previous/candidate bundles, explicit bindings, consumed bootstrap and bounded audit outbox. Finalization/activation authority changes are one CAS, compatible with standalone MongoDB. Separate audit/session records derive authority from it.
- Provider secrets use separate AES-256-GCM root keyring, random nonce, purpose/instance/version-bound AAD; preserve legacy OAuth token ciphertext/key. No plaintext history, reveal operation, implicit blank deletion or fallback to old environment after migration.
- Explicit protected fresh intent and durable host initialization/recovery marker prevent empty/missing database or volume from becoming a public claim. Valid legacy configuration remains authoritative until deliberate owner-confirmed cutover.
- Each operation pins one bundle/epoch. Activation closes admissions, drains requests, fences every catalog's worker authority using separate instance runtime revision and existing monotonic catalog fences, commits, adopts, then reopens. Do not pretend a singleton revision read followed by an unrelated write is atomic. No unmodified v1 binary may overlap an activated v2 migration.
- Maximum activation/drain 120 s; request pins 30 s, max64; one worker pin <=120 s. Failure stays maintenance/recoverable with last active bundle. No stale new admission after commit; expired pins cannot perform later effects. Reconcile same activation after crash.
- Setup session 30 min, max8; bootstrap fresh authority <=24 h; candidate state/proof/checks <=10 min and single-use where applicable; reverify role at activation. Guessing 5/min and100/day instance-wide; mutations30/min and checks6/min per authorized actor/session. No unlimited process-local counters.
- JSON64 KiB, key16 KiB, client secret4 KiB, webhook secret1 KiB; provider5 s connect/DNS,10 s request/30 s workflow,512 KiB response budget, no redirects; one check in progress. Private providers need narrow host-approved origin/address policy.
- Audit <=10,000 events/90 days, <=1 KiB each, atomic outbox128; active+one previous+one candidate bundle, previous <=24 h unless protected recovery hold. One old webhook secret, explicit five-minute maximum overlap, no deadline resurrection on rollback. Settings are not a tuning panel for these policies.

Full operational semantics and safe failure behavior are normative in research/model/contracts, including epoch invalidation, storage-pressure failure, request stream draining and persistent audit reconciliation.

## Functional Delivery Sequence and Traceability

This is implementation ordering for later task generation, not an implementation task ledger. Every row must generate code and acceptance/test tasks with its requirement references. Include defect-demonstrating regression tests before any functional fix.

| Slice | Requirement IDs | Deliverable / test evidence |
|---|---|---|
| Host/configuration foundation | FR001-004,029,030,032,034; QG001-004 | Separate prerequisites from integrations, strict bounded storage/envelopes, lifecycle/marker, empty/corrupt/new-schema/key/cross-instance and legacy precedence tests |
| Setup authority and durable state | FR005-009,012-013,021,025; SC001-003 | Quotas/cookies/CSRF/expiry, seven-step durable draft, single owner/finalization, crash injection/secret sentinel tests |
| Provider validation and continuity | FR010-011,019,023-026; SC003,007 | Pinned safe DNS/HTTPS, OIDC PKCE/state/nonce+role, read-only App checks, distinct install/delivery states, substitution/rebinding/failed rotation tests |
| Settings UI/API | FR014-020,025,032; SC004-005,012 | Binding+role denial matrix, canonical PATCH state, stale conflict/cancel/persistence/blank replace, accessible browser journeys |
| Activation/worker integration | FR022-023,026,030,034,036; SC006-007,009 | Auth/role epochs, standalone gate/catalog fencing race and crash/restart tests, no stale publication/cleanup, truthful health/adoption and bounded overlap |
| Legacy migration / recovery | FR027-031,033; SC008-010 | Protected owner enrollment, explicit import, no data/identity/OAuth/queue/receipt loss, restore epochs, proved compatible rollback, setup/settings slug regressions |
| Docs/acceptance and inherited invariants | FR033-036; all QG001-008 and SC011-014 | Six operator guides, placeholder self-hosting example, full local gates, original v1 regressions, IN-01 closure; BG-01-03 remain explicit release evidence |

IDs in this table abbreviate `V2-FR`, `V2-QG` and `V2-SC`. All 36 FR are covered; every story/scenario, original ST01-13 negative path and supplemental matrix constraint remains normative. The 73-ID matrix's audit counts are historical 2026-10-14 local evidence, not re-audited implementation claims. No numbered v1 requirement is silently removed; new provider-storage policy affects migration of the v1 production credential rule, with legacy retained until approval/activation.

## Exact Feature Coverage Scope

Add scope **C7** in `scripts/check-coverage.mjs`, retaining C1-C6 and global rules. Its membership is the union of all files in the following groups; overlaps with existing scopes are intentional. Tests, third-party/generated code and genuinely declarative data can be excluded with documented reasons; executable tooling/config stays included. New files must fail as unassigned until membership and baseline instrumentation are present.

**New implementation file set:**

```text
lib/instance/bootstrap.ts
lib/instance/store.ts
lib/instance/secrets.ts
lib/instance/access.ts
lib/instance/validation.ts
lib/instance/activation.ts
components/instance-setup.tsx
components/instance-settings.tsx
app/repositories/setup/page.tsx
app/repositories/settings/page.tsx
app/api/instance/status/route.ts
app/api/instance/setup/authorize/route.ts
app/api/instance/setup/route.ts
app/api/instance/setup/check/route.ts
app/api/instance/setup/finalize/route.ts
app/api/instance/auth/[...nextauth]/route.ts
app/api/instance/settings/route.ts
app/api/instance/settings/check/route.ts
app/api/instance/settings/activate/route.ts
app/api/instance/settings/rollback/route.ts
app/api/instance/audit/route.ts
app/api/instance/migration/authorize/route.ts
app/api/instance/migration/route.ts
scripts/instance-operator.mjs
```

**Existing boundary/caller implementation file set:**

```text
lib/config.ts
lib/mongo.ts
lib/limits.ts
lib/auth/admin.ts
lib/auth/authorization.ts
lib/auth/adapter.ts
lib/auth/roles.ts
lib/auth/tokens.ts
lib/catalog.ts
lib/sync/worker-startup.ts
lib/sync/worker.ts
lib/sync/jobs.ts
lib/sync/github.ts
lib/content/generations.ts
lib/content/blob-cache.ts
lib/content/source.ts
lib/layout.shared.tsx
lib/operations/health.ts
lib/operations/logging.ts
lib/admin.ts
auth.ts
instrumentation.ts
app/layout.tsx
app/page.tsx
app/repositories/page.tsx
app/[repoSlug]/[[...page]]/page.tsx
app/api/auth/[...nextauth]/route.ts
app/api/webhooks/github/route.ts
app/api/health/route.ts
app/api/search/[repoSlug]/route.ts
app/api/assets/[repoSlug]/[...path]/route.ts
app/api/admin/csrf/route.ts
app/api/admin/repos/route.ts
app/api/admin/repos/[id]/route.ts
app/api/admin/repos/[id]/sync/route.ts
app/api/admin/repos/sync/route.ts
components/site-navigation.tsx
components/directory.tsx
components/admin-console.tsx
scripts/check-coverage.mjs
scripts/collect-coverage.mjs
scripts/validate-artifacts.mjs
```

This is the declared minimum affected file set for C7, including reusable boundaries even where no edits prove necessary. Verify actual names/existence and call sites before tasks. If implementation introduces/renames an executable file or moves logic, amend this inventory and mapping together before acceptance; do not narrow it to improve a metric. Coverage of global, C7 and every applicable C1-C6 metric must independently reach95%; no missing reports, source files, branch/function/line/statements metric or runtime annotation waiver. Checker currently accepts only C1-C6, so extending validation and its unit/integration tests is required before new runtime logic can be accepted.

## Validation Strategy

Reuse the actual scripts in package.json and disposable loopback Mongo/application/provider harnesses. Local and CI tests may use controlled providers; use real MongoDB/filesystem/Next processes for persistence, CAS, restart, publication and boundary tests. No production/shared services may be started by a test harness. Do not execute Git content or install source repository dependencies.

- Unit: strict schemas/keys/AAD/tamper/blank semantics, lifecycle/provenance, role/binding matrix, CSRF/rate/session/check expiry, outbound addresses/redirects, revisions/epochs, coverage/artifact memberships and sanitized errors.
- Integration: standalone Mongo finalization/save/activation races and crash points, bounded audit outbox replay, role/token/session continuity, every delivery boundary, SSRF connection pinning, missing keys/records, worker leases/fences/blob effects/cleanup, webhook original bytes/dedupe/retirement, retained generations, full synthetic legacy/restore/previous-config paths.
- Browser: fresh seven-step path, forbidden/replayed/expired setup, role-only/binding-only/catalog-only/wrong issuer/project identities, candidate proof tampering, Settings save/cancel/conflict/check/secret replacement, reboot persistence, setup reuse, logout/back/private cache and all three browser engines; keyboard/mobile/theme/error/focus behavior as functional journeys. No CSS-class-only tests.
- CI: extend the existing workflow/validator minimally; retain unit/integration/client collection, source provenance/zero-hit inventory, global/C1-C7 metrics, type/lint/build, real container/e2e gates. V1 validator is hardcoded to001 and cannot be presented as validating v2 artifacts until explicitly extended.

Commands and prerequisite/evidence separation are in [quickstart.md](quickstart.md). During implementation run targeted checks first, then the required acceptance/coverage/type/lint/build gates; no suite was run for this planning-only change.

## Migration, Rollback and Release Boundaries

Before migration, inventory legacy eligible values and safe field provenance, preserve accounts/OAuth key/ciphertext, catalog routes/source mappings/publication pointers, jobs/leases/delivery/control receipts and snapshots. Protected legacy enrollment requires operator authorization plus both current admin roles. Review exact import; no blank overwrite, automatic mixed-source merge or public wizard. Drain unmodified v1 containers before enabling v2 fencing. Old files are recoverable operator inputs, not a silent runtime fallback after migration.

Rollback to previous configuration is a newly validated activation with monotonic epochs/version and required owner continuity; it cannot resurrect retired webhook secrets or consumed bootstrap. Application-image rollback additionally requires proven schema/config/OAuth/envelope compatibility or a consistent database/content restore under maintenance. Keep root keys and host marker/recovery epoch separately protected. Restore invalidates old setup/OIDC/session authority and rechecks every delivery path before opening the gate. Detailed protocol is in the configuration contract. Design targets120 s reconciliation and <=30 min full corpus recovery are unverified until exercised.

IN-01 retains full local acceptance and coverage completion; BG-01 representative workload, BG-02 live DEV/provider/storage/recovery/rollback and BG-03 approved publication/deployment remain blockers. No local fixture test substitutes for these. Live secret provisioning, role assignments, sender changes, service restarts, image/private-content publication or Swarm/VPS deployment require concrete scoped approval. No live inventory or descriptors are modified here.

## Complexity Tracking

No unapproved exception. One control document, existing MongoDB, same-container worker, six focused instance modules, reused framework/UI primitives and two page forms are sufficient. Separate admission and catalog fencing are required by standalone atomicity; they are not optional infrastructure abstractions. No additional queue, provider, generic config platform or speculative preference is introduced.

## Workflow Verification

- Setup script selected `specs/002-instance-configuration` via feature.json; its reported feature/branch label is002, while actual Git branch remains `main`.
- Pre/post hooks: `.specify/extensions.yml` absent; no registered hooks to execute.
- Phase0 research and Phase1 data model/contracts/quickstart generated; post-design Constitution Check passed for planning.
- Documentation validation records link/ID/inventory/whitespace checks and original001 preservation separately from functional acceptance.
- Next workflow is speckit-tasks. No application code, task ledger, Git branch, commit, push or live operation is part of this invocation.
