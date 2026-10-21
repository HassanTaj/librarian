# Feature Specification: Librarian v2 Secure Installation and Instance Settings

**Feature Directory**: `specs/002-instance-configuration`
**Created**: 2026-10-14
**Status**: The original 94 tasks passed local automated acceptance as of 2026-10-21, including T085's synthetic parent-revision recovery. The approved v4 configuration-at-rest amendment adds implementation and DEV migration tasks after T094; those are pending until newly verified. BG-01/02/03 workload, live provider/recovery, and release gates remain separate; no production verification is implied.
**Input**: Create one cohesive v2 specification for secure first-run installation, persistent instance configuration, and administrator settings management; reconcile every v1 obligation without implementing code.
**Authority**: [AGENTS.md](../../AGENTS.md), [adopted constitution v4.0.0](../../.specify/memory/constitution.md), [v1 requirements](../../docs/requirements/v1-requirements.md), [primary v2 requirements](../../docs/requirements/v2-requirements.md), and [mandatory reconciliation instructions](../../docs/requirements/v2-pre-requirements.md).

The initial specification/audit invocation read both v2 sources at their repository paths. The owner subsequently invoked speckit-plan and resolved D1–D3 on 2026-10-19, authorizing planning artifacts and the explicit governance amendment below. Application implementation, task generation and deployment remain separate workflows. The original [001 specification](../001-librarian-v1-portal/spec.md) and its artifacts are preserved as found, including pre-existing uncommitted edits. No branch is required or created.

[Requirements traceability](requirements-traceability.md) is normative for retained v1 obligations. Original identifiers use the namespace `V1/FR-001`, `V1/QG-001`, `V1/ST-01`, and `V1/SC-001`; new identifiers use `V2-FR`, `V2-QG`, and `V2-SC`. This avoids confusing original and new requirements. Supersession is proposed only in the decisions below, never assumed.

## User Scenarios & Testing *(mandatory)*

Every functional story requires automated acceptance evidence, including its negative cases. Priorities order delivery; they do not permit omitting compatibility or security. Stories can be demonstrated independently using controlled configuration, provider identities, and synthetic content. A wizard demonstration is not evidence of live provider compatibility.

### User Story 1 - Authorize and complete a fresh installation (Priority: P1)

As an installation operator, I can securely initialize Librarian with minimal host prerequisites, verify integrations, and nominate a proven owner before normal operation begins.

**Why this priority**: An exposed first-run interface could give an attacker control of the installation.

**Independent Test**: Start an empty isolated instance with only host prerequisites and controlled providers; complete setup using a protected bootstrap credential and a verified owner identity. Repeat unauthorized, expired, replayed, concurrent, and interrupted attempts.

**Acceptance Scenarios**:

1. **Given** a new instance without Zitadel or GitHub credentials, **When** the operator opens `/instance/setup`, **Then** a safe welcome shows version, setup status and prerequisite availability; normal publication, catalog mutations, webhook work admission, and background synchronization remain disabled.
2. **Given** no valid setup authorization, **When** a person guesses, replays, or directly calls a setup operation, **Then** no configuration or owner changes occur; guessing is bounded, failures are sanitized, and the credential never appears in a URL, public log, HTML, or JavaScript.
3. **Given** valid bootstrap authorization, **When** the operator follows welcome, database, Zitadel, GitHub App, preferences, owner verification, and review steps, **Then** validated draft progress survives browser closure and restart; a new setup session still requires authorization.
4. **Given** a missing or unavailable host database credential, **When** the database step is used, **Then** the operator receives sanitized host-provisioning guidance and Retry Connection; the wizard neither stores the connection credential in its own database nor writes it into an application directory.
5. **Given** submitted integration settings, **When** tests run, **Then** structural validity, discovery/reachability, actual authentication, permissions, installation access, and signed webhook delivery are shown separately with checked revision/time; unperformed or failed checks are never presented as success.
6. **Given** a successful login through the candidate Zitadel issuer, **When** the bootstrap-authorized operator confirms that identity, **Then** ownership binds the verified issuer and subject, never email or the first arbitrary sign-in. Substituted providers, altered subjects, stale drafts, and repeat registrations fail.
7. **Given** all required checks and owner verification for the current candidate, **When** the operator explicitly confirms the sanitized review, **Then** exactly one concurrent finalization commits readiness, invalidates all bootstrap access, enables normal runtime only for the committed configuration, and redirects to an authenticated application area.
8. **Given** interruption or validation failure before finalization completes, **When** setup resumes, **Then** no partial ready configuration or falsely successful screen exists; the same committed attempt is reconciled safely and cannot register another owner.
9. **Given** readiness, **When** old setup sessions, tokens, URLs, or direct operations are reused, **Then** setup cannot mutate the instance or reopen initial ownership enrollment.

### User Story 2 - Upgrade an existing installation safely (Priority: P1)

As an existing operator, I retain authentication, catalogs, snapshots, jobs, and reader behavior while deliberately migrating eligible settings.

**Why this priority**: V2 must not expose or reset a working legacy instance.

**Independent Test**: Use a complete synthetic legacy installation with encrypted accounts, public/private catalogs, installation mappings, queued jobs, replay receipts, and generations. Compare behavior before, during, after, and following failed migration/rollback.

**Acceptance Scenarios**:

1. **Given** a valid legacy configuration and no instance-settings record, **When** v2 starts, **Then** legacy operation remains available and no open bootstrap wizard appears; missing records alone are not proof of a fresh installation.
2. **Given** an authorized owner reviewing an import, **When** the owner confirms it, **Then** eligible values are imported and activated atomically without overwriting valid values with blanks or silently merging conflicts.
3. **Given** an unauthorized catalog administrator or ordinary user, **When** migration ownership or settings activation is attempted, **Then** instance ownership is not acquired implicitly; the authorized owner-provisioning procedure must have been completed.
4. **Given** any migration failure, **When** the operator returns to legacy operation or the compatible previous version, **Then** catalogs, role assignments, account identifiers, OAuth token ciphertext/key compatibility, source installation mappings, jobs, replay receipts, operational records, and snapshot pointers remain recoverable.
5. **Given** existing reader and administrator journeys, **When** configuration migration or a permitted settings update succeeds, **Then** public reading, every private delivery boundary, exact role freshness, local login return, logout/cache isolation, catalog controls, and no-rebuild synchronization continue to satisfy their v1 acceptance criteria.
6. **Given** an existing catalog uses `setup` or `settings` as a slug, **When** upgrading, **Then** its URLs remain unchanged; instance pages use `/instance/setup` and `/instance/settings` beneath the dedicated instance namespace. No catalog rename or compatibility redirect is introduced.

### User Story 3 - Review and edit instance settings (Priority: P1)

As an explicitly authorized instance administrator, I can review and update supported settings without rebuilding the image or exposing stored secrets.

**Why this priority**: Persistent configuration is useful only if access and updates remain controlled.

**Independent Test**: Seed a ready instance and identities for owner, explicit instance administrator, catalog-only administrator, reader, wrong issuer/project, and anonymous visitor. Exercise the Settings page and every direct operation.

**Acceptance Scenarios**:

1. **Given** an authorized instance administrator, **When** opening `/instance/settings`, **Then** grouped General, Authentication, GitHub Integration, Documentation, Security, and System information shows only supported fields, sanitized diagnostics, version, setup state, configuration revision, ownership information, and bounded audit history.
2. **Given** any identity without instance authorization, **When** the page or its read/test/write/rotation operations are requested directly, **Then** access is denied independently on the server. Catalog administration and private reading remain separate permissions.
3. **Given** an ordinary field edit, **When** Save or Cancel is selected, **Then** inline validation and a clear result appear; Cancel preserves stored state, unsaved navigation warns, and invalid submissions do not partially change configuration.
4. **Given** two administrators editing the same revision, **When** one saves and the other submits stale changes, **Then** the second update is rejected with refresh guidance; neither user's changes are silently overwritten.
5. **Given** a stored secret, **When** settings are viewed or ordinary edits saved, **Then** only configured/missing/update/validation metadata is returned; blank secret inputs retain the secret. Replacement requires an explicit action; there is no reveal-secret control.
6. **Given** valid saved preferences, **When** the application restarts, its container is recreated, or a compatible image upgrade occurs, **Then** the same active settings and revision remain available.
7. **Given** a small viewport or keyboard-only use, **When** forms and diagnostic actions are used, **Then** labels, focus, validation, loading/error states, confirmations, and responsive navigation remain operable.

### Entry points and discovery

- On a confirmed fresh installation, opening `/` leads to `/instance/setup`; its public welcome contains only safe version/state/prerequisite availability. Valid legacy and ready instances keep their normal directory. The wizard steps require protected bootstrap authorization.
- After initialization, shared navigation shows **Instance Settings** linking to `/instance/settings` only for an authenticated user with the explicit instance binding and currently verified `librarian-instance-admin` role. Every page/API still independently enforces server authorization.
- Setup closes permanently after initialization; direct visits cannot enroll another owner. Settings groups supported General, Auth, Zitadel, Mongo, GitHub App, GitHub webhook, Documentation, Security and System information.
- Every active application configuration bundle persists in MongoDB as one authenticated-encrypted envelope and is decrypted only in authorized server memory. The UI returns approved non-secret values and configured/missing credential metadata only. An independent OS/KMS trust anchor and minimum Mongo bootstrap connection, instance identity/recovery marker, content-volume location, outbound policy, and publication-approval input remain host-managed.

### User Story 4 - Activate settings and rotate credentials safely (Priority: P1)

As an instance administrator, I can validate a candidate change, understand its impact, and activate or recover it without leaving inconsistent authorization or synchronization.

**Why this priority**: An apparently successful save must not leave stale credentials or identity boundaries running.

**Independent Test**: Change grouped credentials/origin/provider values while serving protected requests and running a worker in overlapping processes. Inject rejected credentials, provider outages, stale revisions, and activation interruption.

**Acceptance Scenarios**:

1. **Given** a candidate multi-field update, **When** validation fails or its revision changes, **Then** no part activates; the previous valid active configuration remains usable subject to its security guarantees.
2. **Given** a valid activation, **When** workers and web processes handle new work, **Then** they use the same active revision; stale processes stop admitting sensitive work after the declared activation bound and old work cannot publish across an incompatible revision.
3. **Given** an identity issuer/project or origin change, **When** activation is requested, **Then** impact confirmation, owner continuity, appropriate session/role-cache invalidation and callback consistency prevent provider substitution, stale grants, and administrator lockout.
4. **Given** a credential replacement, **When** activation succeeds or fails, **Then** applicable authentication/permissions checks precede activation, previous credentials remain recoverable, and safe sessions persist only where their security boundary remains valid.
5. **Given** webhook secret rotation, **When** sender and receiver are coordinated, **Then** deliveries signed by the approved transition credentials work only during a declared bounded overlap, retired signatures fail afterward, and durable deduplication remains intact. The interface never promises seamless rotation without that evidence.
6. **Given** a host-only or restart-required setting, **When** it is inspected or changed through its approved operator path, **Then** the interface states the host/restart requirement and never claims it was applied at runtime.

### User Story 5 - Recover and operate a durable instance (Priority: P2)

As an operator and owner, I can diagnose failure, restore a consistent instance, and complete the documented self-hosting journey without weakening security.

**Why this priority**: Failures must not become fresh-install takeover opportunities.

**Independent Test**: Disconnect storage/providers, remove or substitute encryption keys, restore a synthetic backup, and restart during setup/activation. Follow sanitized installation/recovery documentation in an isolated environment.

**Acceptance Scenarios**:

1. **Given** an initialized or legacy instance whose storage, configuration, or encryption key cannot be read, **When** it starts or handles requests, **Then** affected operations fail closed with a maintenance/recovery indication; it does not revert to a publicly claimable fresh instance.
2. **Given** lost browser state or a process restart, **When** a legitimate operator resumes an incomplete setup, **Then** durable validated progress is recovered without weakening bootstrap expiry, owner verification, or finalization exclusivity.
3. **Given** a consistent backup and separately protected required keys, **When** authorized recovery is performed, **Then** instance identity, active settings/secrets, administrator bindings, audit/revision history, catalogs/jobs/receipts, and corresponding snapshots recover coherently; restored bootstrap sessions do not become reusable.
4. **Given** third-party hosting instructions, **When** an operator follows them, **Then** they can provision minimal prerequisites, complete setup, create a catalog, connect an eligible read-only GitHub source, synchronize supported documentation, read it, and later update Settings; examples contain placeholders only.
5. **Given** diagnostic output, **When** any failure is displayed or logged, **Then** it identifies actionable state without credentials, private content, raw environment values, private paths, or sensitive provider response bodies.

### Edge Cases

| Case | Required outcome | Trace |
|---|---|---|
| Missing optional integrations versus missing database/key | Safe authorized setup for confirmed fresh state; sanitized operator prerequisite/recovery guidance otherwise | US1.1–4; V2-FR-001–007 |
| Database unavailable or records unexpectedly absent after initialization | No fresh-install fallback or unauthenticated reset; affected work fails closed | US5.1; V2-FR-005,030 |
| Concurrent setup/finalization and crash at each durable boundary | One owner and one readiness commit; recover/reconcile same attempt | US1.6–9; V2-FR-008,013 |
| Expired setup session, guessing, replay, forged origin/CSRF | No mutation or credential disclosure; bounded throttling | US1.2; V2-FR-006–007 |
| Discovery works but client login/role access fails | Separate check states; block required verification/finalization | US1.5–7; V2-FR-010–013 |
| GitHub key works but no installation or webhook delivery proof | Distinct warning/failure/check-not-run states; no invented success | US1.5; V2-FR-011 |
| Changed draft after owner/provider checks | Invalidate affected check/ownership proof; reverify current candidate | US1.6–7; V2-FR-009,013 |
| Empty secret replacement, invalid RSA key, tampered ciphertext | Retain old secret or reject explicit invalid replacement; fail closed on decryption | US3.5, US4.4; V2-FR-004,020 |
| Stale settings revision, unknown fields/newer schema | Reject conflict/unsupported version safely; preserve active data | US3.4; V2-FR-003,018 |
| SSRF, redirect, DNS rebinding, malicious branding | No prohibited outbound connection, code execution, or stored XSS | V2-FR-024–025 |
| Key loss/change or backup restore | Authenticated/operator-assisted recovery; no secret regeneration/reset fallback | US5.1,3; V2-FR-030–031 |
| Active worker/read during identity/App/origin change | Fence incompatible work and reauthorize delivery; preserve valid generation | US4.2–3; V2-FR-022–023,026 |
| Legacy config conflicts with database values | Explicit provenance/precedence and owner confirmation; no silent merge | US2; V2-FR-027–029 |
| Root setup/settings names already used by a catalog | Preserve catalog URLs; use nested application routes | US2.6; D3 |

## Requirements *(mandatory)*

### Functional Requirements

- **V2-FR-001**: Distinguish confirmed fresh, in-progress setup, ready, legacy, and maintenance-required states. Absent optional credentials MUST NOT crash confirmed fresh setup. Unavailable storage/decryption or unexplained record loss MUST NOT be treated as fresh.
- **V2-FR-002**: Keep only the irreducible OS/KMS bootstrap identity, bootstrap Mongo connection URI/database locator, bootstrap credential/verifier, instance identity/recovery files, content location, outbound destination policy, and owner publication-approval input outside encrypted database-managed configuration. Auth.js session secrets, OAuth token keys, provider values, application settings, and an encrypted copy of the Mongo connection URI MUST move into the Mongo configuration bundle. The bootstrap connection remains host-authoritative for startup and cannot be rotated solely through that same database. Mark every retained `.env` reference `ABSOLUTELY REQUIRED` with its reason; never reveal credential values in the browser.
- **V2-FR-003**: Persist strictly validated, instance-scoped configuration with schema version, stable instance identifier, lifecycle state, revision, server timestamps, and active/previous/candidate settings as authenticated-encrypted envelopes. Keep only non-configuration control metadata needed for CAS, lifecycle, audit, and authority outside the envelope. Prevent cross-instance access even on a shared database server. Unsupported/newer schemas MUST be rejected without overwrite; supported upgrades require explicit versioned migration.
- **V2-FR-004**: Store the complete application configuration bundle, including all non-secret settings and secret values, in MongoDB only under authenticated encryption with its root key outside MongoDB and client payloads. Bind ciphertext to its instance, purpose and version so substitution/tampering fails. Preserve the exact OAuth token-encryption key and existing ciphertext compatibility; changing that key requires a separately verified token re-encryption procedure. Legacy import still requires explicit owner confirmation.
- **V2-FR-005**: Before readiness, disable normal content publication, privileged catalog operations, sync worker claims, and operational webhook admission. Allow only bounded prerequisites, setup authorization/validation, and candidate authentication required for verified ownership; no private reader path becomes public.
- **V2-FR-006**: Require a high-entropy out-of-band bootstrap credential with no fixed defaults. Deliver it through a protected operator channel/secret file, store only a verifier where feasible, and never place it in URLs, public logs, bundles, or responses.
- **V2-FR-007**: Enforce expiring setup-specific authorization, secure HttpOnly cookies, exact trusted-origin and CSRF defenses, strict bounded requests, and cross-process guessing/replay protection. Reauthentication after expiry MUST not erase drafts or reopen completed setup.
- **V2-FR-008**: Coordinate setup across replicas with one authoritative instance identity and conditional revision/state transitions. Prevent separate owners, competing ready commits, and repeat enrollment; survive restart without process-local authority.
- **V2-FR-009**: Provide the seven-step wizard in US1, saving authorized draft progress durably and showing sanitized prerequisite/check results. Changes invalidate affected checks; Cancel/Back MUST not partially activate drafts or expose saved secrets.
- **V2-FR-010**: Validate Zitadel origin, discovery issuer/endpoints, client configuration, required scopes/audience and actual authenticated issuer/subject. Show the exact origin-derived callback URL. Preserve PKCE/state/nonce, database sessions, secure cookies, token protection, configured-project role checks and the existing 15-minute freshness rule. Discovery alone is insufficient verification.
- **V2-FR-011**: Validate GitHub App ID, RSA key/signing, App authentication, read-only permissions, relevant installation/repository access and expected webhook configuration. Show the origin-derived webhook URL and distinct structural/authentication/App/installation/signed-delivery statuses. Never request repository writes or claim an unperformed check.
- **V2-FR-012**: Establish the initial owner only after bootstrap authorization and successful candidate Zitadel authentication, bound to stable verified issuer/subject and current draft revision, with the dedicated current project role `librarian-instance-admin`. Subsequent instance access requires both explicit binding and that role. Legacy first-owner enrollment additionally requires protected operator authorization and current `librarian-admin`. No random first login, email match, or role alone may confer ownership.
- **V2-FR-013**: Require explicit final review/confirmation, current required check results, owner proof, and durable atomic readiness transition. Consume bootstrap authorization on committed initialization; report success only after committed settings and runtime readiness checks succeed. Recover an interrupted post-commit activation without reopening setup.
- **V2-FR-014**: Serve Settings at `/instance/settings` and setup at `/instance/setup`; protect each related page/read/test/write/rotation operation using server-verified instance authorization or the narrowly scoped setup authority. Instance operations require explicit issuer/subject binding AND current `librarian-instance-admin` in the configured project. Separate instance administration, catalog administration and private reading; navigation visibility is not authorization.
- **V2-FR-015**: Group configuration in distinct Auth, Zitadel, Mongo, GitHub App, GitHub webhook, documentation/runtime, and host-prerequisite sections. Auth includes the Auth.js session and OAuth token keys; credentials are write-only and never returned. Show version, lifecycle, configuration revision, owner/security metadata and sanitized health. Never expose raw environment, credential file contents, private keys, or private content; host filesystem locations remain operator-managed.
- **V2-FR-016**: Initially offer display name, site description, public origin and default documentation folder, with existing supported branding/publication options only. Defaults affect future catalogs; do not rewrite existing source paths, roles or visibility. Do not add renderer modes, sync tuning knobs, arbitrary access policies or branding upload features merely because the source lists examples.
- **V2-FR-017**: Provide accessible labels, inline validation, Save/Cancel, unsaved-change warnings, loading and error states, connection tests, responsive layout, visible focus and impact confirmations for sensitive actions. Persist only valid submitted changes.
- **V2-FR-018**: Apply strict schemas and revision-aware atomic updates to configuration and linked secret metadata. Reject stale edits, unknown fields, malformed/oversized requests and invalid transitions without partial writes/activation; display refresh guidance.
- **V2-FR-019**: Separate candidate, active and recoverable previous revisions; associate validation with exact candidate revision, time, check type and actual result. Later field edits/provider failures MUST not inherit false validation success.
- **V2-FR-020**: Secret fields, including Auth.js/session, OAuth key, Mongo URI, Zitadel, GitHub App key, and webhook secret, expose configured/missing/updated/check metadata only. Blank input retains existing values; explicit replacement validates before activation where supported. Do not add a reveal operation or implicit deletion; failed replacement preserves working credentials. OAuth-key replacement requires a dedicated migration preserving all existing token ciphertext; Mongo bootstrap rotation requires the host operator and restart.
- **V2-FR-021**: Persist bounded audit events for setup authorization outcomes, owner binding, migration, save/conflict, activation/rollback, and rotations, recording actor identity, time, operation, revisions and sanitized result. No secret values, plaintext old credentials or private bodies enter history. Planning MUST define retention and rate/storage bounds.
- **V2-FR-022**: Activate validated multi-field revisions coherently across authentication, webhook verification, worker/provider clients, authorization and web processes. Fence incompatible pending work; no mixed-revision sensitive request or stale worker publication. Bound propagation and stale-process admission; settings are not active merely because saved.
- **V2-FR-023**: Before issuer/project/client/origin changes, preserve proven owner recovery, validate new callback/provider boundaries and explain impact. Invalidate affected sessions, verified-role caches and candidate proofs when identity security changes; retain safe unrelated sessions only where justified. Old issuer identities MUST NOT silently acquire privileges under a new provider.
- **V2-FR-024**: Provider validation MUST prevent SSRF: allowed schemes/destinations, bounded DNS/connect/read behavior, redirect checks, and DNS-rebinding-safe connection controls. No arbitrary internal/metadata endpoint fetch; legitimate private provider deployments require a narrow host-managed approved destination policy, never a global bypass.
- **V2-FR-025**: Administrative/setup input MUST not become executable configuration or stored XSS. Every mutation requires applicable authorization, CSRF/origin checks, bounded request schemas/rates, safe errors and audit. Client-supplied owner/instance/role identifiers are not proof of permission.
- **V2-FR-026**: Rotate credentials with verified replacement, explicit impact, bounded provider-supported overlap, retirement and rollback/recovery. Coordinate webhook sender/receiver; retain deduplication and signature guarantees. Do not claim automatic external-provider updates, seamless rotation or restart-free activation unless supported and proven.
- **V2-FR-027**: Detect a valid legacy installation before exposing setup. Keep its environment/file configuration working until authorized owner confirmation of migration; never overwrite it with empty settings.
- **V2-FR-028**: Migration MUST preserve existing accounts/sessions where safe, stable identities, OAuth ciphertext and key behavior, catalogs/reader roles, GitHub installation mappings, jobs/leases/replay receipts, operational records and immutable snapshots. Define compatible rollback before activation; no reinstall or destructive migration.
- **V2-FR-029**: Document provenance and precedence: legacy mode uses validated legacy inputs; migrated mode uses its explicitly activated encrypted database bundle; OS/KMS/bootstrap and other host-managed prerequisites always remain host authoritative. Conflicts require review, not silent value merging or stale environment override. Document each remaining required variable/file and restart requirement.
- **V2-FR-030**: On storage/provider/key/configuration failure, fail affected security-sensitive work closed, preserve last valid state where safe, and require authenticated recovery or the protected operator recovery procedure. No unauthenticated reset, automatic fresh-owner claim, key regeneration or public fallback.
- **V2-FR-031**: Backup/restore MUST pair instance configuration/encrypted secrets/administrator bindings/audit and revisions with catalog/job/receipt/auth state and corresponding content. Keys are protected separately but required for recovery. Restore MUST not revive setup-token access; invalidate unsafe restored sessions and verify before serving.
- **V2-FR-032**: Classify every setting as bootstrap-only, runtime-editable, restart-required, immutable identity or security-sensitive as applicable. Show activation status and truthful restart needs. Persistent eligible settings survive restart/recreation/redeployment/compatible image upgrades without rebuilding.
- **V2-FR-033**: Preserve every applicable v1 requirement in the traceability matrix, including all stories, negative cases, local routes/interfaces and deployment gates. Settings ownership does not grant private reading, publication approval or catalog administration implicitly; keep `/repositories` and existing APIs/links. D3 resolves reserved-route conflicts.
- **V2-FR-034**: Keep the same MongoDB, Zitadel/Auth.js, read-only GitHub App, Fumadocs runtime rendering and same-container worker architecture. Retain source-folder-only fetch, immutable fenced publication and original-blob cache safety. No Redis, extra queue/provider, renderer replacement, source editor/write permission, unrelated UI redesign, multi-tenant hosting, infrastructure provisioning or paid cloud service.
- **V2-FR-035**: Provide installation, administrator, configuration, secret-management, migration, troubleshooting and recovery guides with a sanitized local self-hosting Compose example. Infrastructure deployment descriptors remain infrastructure-owned; documentation examples do not authorize live provisioning or Swarm deployment.
- **V2-FR-036**: Preserve resource/retention constraints, non-sensitive health and observability, prior-version recovery and explicit live-operation approvals. Carry v1 performance/live/deployment evidence forward as BG-01–03; do not claim release readiness until those gates actually pass.

### Mandatory Automated Tests and Coverage

- **V2-QG-001**: Require acceptance tests for every functional requirement and defect-demonstrating regressions for functional fixes. The isolated presentation-only exception remains as adopted; it does not exempt this configuration/security feature.
- **V2-QG-002**: Require at least 95% independently for statements, branches, functions and lines globally and for every declared v2 implementation scope, including unexecuted first-party files. Retain affected v1 C1–C6 scopes. CI fails missing reports/instrumentation/source membership, required failures or any sub-threshold applicable metric; only constitution-approved exclusions, with reasons, are allowed.
- **V2-QG-003**: Unit acceptance covers bootstrap/schema validation, cryptographic tampering/wrong keys, revisions/transitions, replacement/blank semantics, authorization and configuration precedence. Integration acceptance uses actual MongoDB/filesystem/application boundaries for setup persistence, concurrent finalization/editing, atomic activation, restart/restore, legacy migration, authentication, App validation and worker revision fencing.
- **V2-QG-004**: Security acceptance covers guessing, replay/expiry, unauthorized setup/Settings/direct operations, CSRF/origin failures, identity/provider substitution, cross-instance access, secret sentinels in responses/logs/builds/audit/errors, invalid keys/rotations, SSRF redirects/rebinding/internal destinations, stored XSS and concurrent modifications.
- **V2-QG-005**: Browser acceptance covers fresh installation through authorization/seven steps/owner/finalization, normal reader/catalog access, Settings read/save/cancel/conflict/secret replacement, restart/persistence and blocked setup reuse. Exercise affected mobile/keyboard/focus/theme behavior and v1 logout/back/cache isolation in Chromium, Firefox and WebKit using synthetic fixtures.
- **V2-QG-006**: All V1/ST-01–13 outcomes remain regression obligations for affected behavior, including original-byte signatures, durable dedupe, wrong branch/source, invalid content, leases/restart/access loss, last-good preservation and bounded cleanup. No blanket mocks, skipped required cases or retries to hide failure.
- **V2-QG-007**: Functional completion requires acceptance, applicable four-metric coverage, typecheck, lint and production build. Separate controlled-provider evidence from genuine approved DEV Zitadel/GitHub/webhook/recovery proof; no fixture or stored report is live integration or capacity evidence.
- **V2-QG-008**: Planning MUST define exact source/caller/interface scope, per-feature coverage sets, input/output bounds, bootstrap/session/rate/audit/rotation/activation/recovery limits, compatible dependencies, migrations and rollback. Subsequent tasks MUST map every in-scope requirement to implementation and test tasks. The plan workflow does not create the task ledger or implement application code.

### Key Entities *(include if feature involves data)*

- **Instance identity/configuration revision**: Stable installation identity, schema version, lifecycle, candidate/active/previous revisions, supported preferences/integration metadata, timestamps and validated provenance.
- **Host prerequisite boundary**: Operator-owned connection, session/key material, bootstrap authorization and storage/proxy/publication policy required before durable instance access; not database-managed settings.
- **Encrypted instance secret**: Instance/purpose/version-bound protected credential, key reference/version and sanitized replacement/check timestamps; decrypted only in authorized server use.
- **Setup draft/session and ownership proof**: Expiring bootstrap authority, revision-bound durable progress/checks and verified issuer/subject awaiting one-time finalization.
- **Instance administrator binding**: Explicit issuer/subject-scoped owner or administrator membership; distinct from catalog roles and private reader grants. D2 requires the dedicated current instance-admin role as well as binding; protected enrollment/recovery cannot bypass provider identity verification.
- **Integration check**: Candidate revision, check category, result, timestamp and safe explanation; not a general connected Boolean.
- **Audit event**: Bounded append history of actor/operation/revisions/time/result; contains no secret or private-body payloads.
- **Existing catalog, generation, account/session and sync receipt**: Retained v1 entities; migration does not replace their source, identity, publication or recovery semantics.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **V2-SC-001**: A fresh acceptance instance completes all seven setup steps using only declared host prerequisites and without preconfigured optional integrations; 100% of missing-prerequisite cases yield safe actionable guidance.
- **V2-SC-002**: Across unauthorized/expired/guessed/replayed/concurrent setup cases, zero unauthorized changes occur; exactly one owner/readiness commit exists and zero completed-bootstrap reuses succeed.
- **V2-SC-003**: Every integration result states its actual check/revision/time; zero unperformed discovery/login/permission/installation/delivery checks are labelled verified.
- **V2-SC-004**: All Settings operations succeed for explicitly permitted identities and reject all other tested identities; zero stored secrets or private bodies appear in prohibited client/log/audit/export surfaces.
- **V2-SC-005**: Every stale concurrent save is rejected; every invalid multi-field/secret update preserves the previous active revision; all valid saved preferences survive restart, recreation and a compatible upgrade.
- **V2-SC-006**: During every configuration activation test, no sensitive request or publication mixes revisions; stale admission ceases within the planning-declared maximum, measured from commit. The feature cannot pass without a concrete bound and evidence.
- **V2-SC-007**: All candidate provider/identity/origin changes and secret rotations either activate with the required proof/continuity or retain recoverable prior settings; zero retired webhook credentials are accepted after the declared overlap deadline.
- **V2-SC-008**: All legacy acceptance datasets preserve catalogs, identities, token decryption, installation mappings, receipts/jobs and coherent snapshots through successful migration and rollback; zero valid legacy instances expose open first-owner enrollment.
- **V2-SC-009**: Every storage/key/provider failure and restore scenario remains non-claimable without authorized recovery; zero failures silently reset a ready instance to public setup.
- **V2-SC-010**: All affected v1 stories and V1/ST-01–13 regressions pass, including zero unauthorized private bytes and refresh at exactly 15 minutes; setup/settings add no implicit reader/publication privileges.
- **V2-SC-011**: Required functional suites, build/type/lint and every applicable global/per-feature statement/branch/function/line metric pass independently at 95% or higher; intentionally missing/failing evidence blocks completion.
- **V2-SC-012**: An isolated operator walkthrough completes installation, catalog creation, eligible source sync, reading and later settings update using the guides; all controls are keyboard-operable and journeys pass on phone/tablet/desktop and three supported browser engines.
- **V2-SC-013**: 100% of the 73 identified original requirements and all supplemental constraints have explicit evidence/status/disposition/destination; zero substantive removals are treated as approved without owner evidence.
- **V2-SC-014**: Release is withheld until carried-forward workload, live DEV, recovery/rollback and publication/deployment gates pass with separately recorded evidence and concrete approvals.

## Assumptions

### Scope, classification and lifecycle defaults

MongoDB, Zitadel, Auth.js, GitHub App and Fumadocs are fixed inherited constraints, not new implementation selections. No dependency versions or algorithms beyond the source's standard authenticated-encryption guarantee are invented here. Branding remains text and existing trusted assets; no arbitrary source execution or upload feature.

| Settings class | Initial members | Required semantics |
|---|---|---|
| OS/KMS/bootstrap-only / host-managed | Independent encryption root, bootstrap Mongo URI/database locator, bootstrap verifier, instance ID/recovery/operator files, content location, outbound destination policy, owner publication-approval input | Never placed solely in MongoDB; every retained `.env` path reference is marked `ABSOLUTELY REQUIRED`; protected operator changes and restart where needed |
| Encrypted application bundle | Auth.js origin/trust/session secret, exact OAuth token key, Zitadel fields/secret, Mongo URI copy/database name, GitHub App ID/key/webhook secret, supported preferences/runtime settings | Entire active/previous/candidate bundle uses instance/purpose/version-bound authenticated encryption; owner-validated candidate, fenced activation and rollback; credential values are write-only |
| Runtime eligible | Display name, description, default docs folder; supported existing preferences | Validated revision activation; defaults affect new catalogs only |
| Security-sensitive eligible | Public origin, Zitadel issuer/client/project/audience/client secret, GitHub App ID/key/webhook secret | Candidate validation, impact/continuity confirmation, fenced activation, rollback; restart status explicit if required |
| Immutable identity | Instance identifier, completed first-owner enrollment history | Ordinary Settings cannot change them or reset setup; provider/owner replacement uses approved recovery policy |
| Restart required | Any setting the reviewed runtime cannot safely reload | Planning enumerates exact fields; interface distinguishes saved/pending from active and states restart requirement |

Conceptual states: fresh → configuring → awaiting owner verification → ready; edits can return a pre-ready draft to configuring and invalidate its proof. Ready never returns to first-run enrollment. Ready → maintenance-required when safety/readiness cannot be established; authenticated/operator recovery returns it to its proven active state. Legacy remains operational under validated old inputs until authorized migration commits ready. Database failure is not a state transition to fresh. Exact storage protocol belongs to planning.

Finalization requires successful database/key checks, genuine candidate Zitadel owner authentication, structurally valid and authenticated read-only GitHub App credentials, and current preferences/origin validation. An absent installation or unobserved webhook delivery is a visible warning rather than fabricated success; creating/serving a catalog still requires proven eligible installation access and valid publication. This is an explicit default: it permits operators to initialize before their first catalog exists.

### Reconciliation, inherited backlog and dependencies

The [matrix](requirements-traceability.md) contains the complete original ID inventory, exact source sections, requirement text, local evidence, dispositions and acceptance destinations. Retain each original story/scenario and edge-case outcome alongside its ID rows; none is removed by this new specification. V2-FR-033/V2-QG-006 require affected regressions; unchanged delivered behavior remains an invariant rather than a request to rebuild it.

| Destination | Outstanding original requirements | Disposition and closure |
|---|---|---|
| IN-01 — configuration/compatibility completion | V1/QG-007, V1/SC-011 | Include now: full local functional gates after configuration/migration changes; generate implementation/test tasks during later workflow |
| BG-01 — representative resource evidence | V1/FR-036, V1/ST-11 (measured portion), V1/SC-012 | Carry forward, original T086: 3 catalogs, 500 pages + 100 assets each, 50 KiB average pages, 10 MiB assets/catalog, 10 readers at 20 requests/s for 15 minutes with sync/restart/retention pressure, 0.5 CPU/512 MB. Warm page p95 ≤2 s, search ≤1 s, durable ack ≤2 s, cold ≤5 s, publish ≤120 s, recover ≤45 s. Add v2 overhead to measurements before release |
| BG-02 — live compatibility and recovery | V1/FR-035 (recovery portion), V1/FR-037, V1/QG-006 (live portion), V1/ST-14, V1/SC-013 | Carry forward, original T088–T090: revalidate actual infra/provider/storage prerequisites; approved isolated DEV login/refresh/logout/role removal/all delivery paths/signed sync and consistent restore/previous-image rollback, each recovery exercise ≤30 minutes for the declared corpus |
| BG-03 — approved publication/deployment | V1/FR-038, V1/ST-14, V1/SC-013 | Carry forward, original T091: prior image/configuration and consistent backup, explicit image/private-content/infrastructure/deployment approvals, DEV before production, health/browser verification |

Backlog is normative within this feature, not a second implementation state ledger. Follow-up planning/tasks must preserve destinations and dependencies. Carry-forward does not authorize those operations now and does not waive release gates. V1 T087 remains open despite passing saved coverage: its entire current quickstart acceptance has not been freshly completed. Existing v1 task checkboxes are preserved.

### Owner decisions and constitutional disposition — 2026-10-19

**D1 — Historical approval, expanded by D4.** The original provider-credential decision authorized encrypted provider secrets with a separate host root. The owner's 2026-10-21 architecture instruction supersedes its narrower host-only boundary for application settings, session secrets, OAuth token key, and encrypted Mongo connection copy. The independent OS/KMS root and bootstrap connection remain outside the database; see D4 and constitution v4.0.0. No production migration or deployment is authorized by this amendment.

**D2 — Resolved: explicit binding plus dedicated Zitadel role.** The owner selected a dedicated Zitadel instance-admin role as well as owner binding; legacy enrollment requires protected operator authorization plus verified `librarian-admin`. Use the application project role `librarian-instance-admin` (not a Zitadel platform administrator privilege). Fresh ownership requires bootstrap authority, verified candidate issuer/subject and that role. Legacy enrollment requires all three permissions, explicit confirmation and stable binding. Additional bindings, transfer and recovery use a protected operator procedure with verified target identity and role; ordinary Settings does not provide unrestricted ownership enrollment. Neither authority grants private reading, catalog administration or publication approval.

**D3 — Revised by the owner: dedicated instance namespace.** The owner subsequently requested `/instance/setup` and `/instance/settings` explicitly, superseding the earlier choice of the repositories namespace. Keep `/repositories` for catalog administration and `/api/instance/*` for instance APIs. Do not create aliases or redirects under `/repositories`, `/setup` or `/settings`. Existing `setup` and `settings` catalogs retain their URLs. Reserve `instance` for application routing only with a pre-upgrade collision check: an existing catalog with that slug requires an explicit owner-approved resolution before the new routes are enabled, never an automatic rename, deletion or silent shadowing. This decision changes route scope without weakening secret storage, authority, coverage or deployment gates.

**D4 — Resolved 2026-10-21: encrypted application configuration with an OS/KMS bootstrap identity.** The owner explicitly required every application setting and credential to be encrypted in MongoDB, then approved an independent OS/KMS bootstrap identity after the startup/decryption dependency was explained. Preserve the exact OAuth token key during import. The host-authoritative Mongo connection, encryption root, instance/recovery identity, content mount, outbound policy, and owner publication-approval input remain external. This authorizes only the current DEV migration requested by the owner; production and publication remain separately gated.

Other reconciled tensions:

- Constitution Principle III rejects executable MDX/JSX/imports/expressions; current v1 artifacts/code approve a narrow static component subset including literal Columns counts. Preserve that current safe grammar and rejection boundary under V2-FR-033–034; no unrestricted MDX preference is added. Planning must explicitly document why trusted static AST handling meets the adopted boundary; any substantive exception needs an amendment.
- V1 requirement/contract historical text places badges at lower right, while current v1 spec/plan and AGENTS require bottom left and three consistent skeleton cards. Preserve bottom left and current skeleton behavior; do not edit historical sources in this invocation.
- Minimal bootstrap needs database credentials before settings can persist. Host provisioning plus Retry Connection resolves the database wizard suggestion without pretending the URI is database-managed.
- Multi-replica configuration coherence is required for overlap/future safety; the deployment baseline stays one replica on its persistent-volume node. It does not authorize scaling or shared-storage redesign.
- Source examples of MDX preferences/branding/sync options are not requirements for speculative fields. Preserve the implemented renderer, access policies and finite v1 bounds.
- Source §18/§20 implementation and tasks remain future workflow deliverables. The current speckit-plan request authorizes planning artifacts after D1–D3 resolution; it does not authorize application implementation or deployment.

### Current evidence and planning handoff

Audit date: 2026-10-14. Current implementation inspection covers configuration callers, authentication/adapter/role/token boundaries, Mongo startup, webhook signature/admission, worker/provider configuration, catalogs, runtime content/generation boundaries, limits, packaging, CI and existing tests. Details and limitations are in the matrix.

The saved 640-test report and local coverage evidence exist. Running `node scripts/check-coverage.mjs` in this invocation accepted current runtime source provenance and all global/C1–C6 four-metric gates: statements 3717/3840, branches 2936/3065, functions 614/633, lines 2888/2933. This rechecks saved evidence; it is not a new test collection. The v1 ledger records 72/72 browser cases and local build/container checks, but those were not rerun here. No workload or live integration/deployment proof is inferred.

D1–D3 were resolved on 2026-10-19 and the constitutional disposition is recorded above. The [implementation plan](plan.md), research, model, contracts and quickstart now declare the required bounds and design. Generate requirement-mapped tasks in the subsequent workflow, retaining affected v1 regressions. No implementation is authorized by this document alone. Historical 2026-10-14 evidence above is not a fresh test/coverage/build run.

