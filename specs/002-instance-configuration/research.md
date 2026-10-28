# Research: Secure Installation and Instance Settings

**Date**: 2026-10-19 | **Scope**: Phase 0 design evidence; no implementation or live verification.

## R1 — Owner policy and credential storage

**Decision**: D1 stores eligible provider credentials in MongoDB using AES-256-GCM with a separate host-managed instance-secret key. D2 requires explicit issuer/subject membership AND the configured project's `librarian-instance-admin` role. The owner revised D3 to `/instance/setup` and `/instance/settings`; retain existing catalogs and require an explicit collision resolution for any legacy `instance` slug before enabling those routes. Constitution v3.0.0 records the approved production-storage amendment.

**Rationale**: The owner's three responses resolve the original gate. Root trust cannot be encrypted with a key stored alongside its own ciphertext. Existing `lib/auth/tokens.ts` supplies a standard crypto pattern, but its OAuth format and key must remain unchanged. Catalog administration and private reading remain independent permissions.

**Alternatives considered**: File-only provider credentials were declined. Role-only Settings or first-login ownership contradict D2. Root `/setup`/`/settings` routes would capture valid catalog slugs and were declined. No plaintext provider secret, reveal endpoint or general credential manager is needed.

## R2 — Dependencies and framework compatibility

**Decision**: Retain the installed package set: Next 16.4.0, React/DOM 19.3.0, next-auth 5.0.0-beta.32, MongoDB driver 6.21.0, Auth MongoDB adapter 3.11.3, Fumadocs core/UI 16.15.18, local-md 0.3.5 and Zod 4.3.6. Add no dependency.

**Rationale**: Research inspection of installed peer metadata accepts these major versions; the MongoDB adapter accepts driver 6. Existing code already uses `dynamicLoader` and `localMd`. Local Next guides confirm nested Route Handlers, centralized server authorization and once-per-process instrumentation. Auth.js supports runtime configuration, but Librarian's `auth.ts` caches its constructed server indefinitely: activation must change that cache deliberately. Installed metadata and documentation establish a design-compatible set, not fresh runtime or external-provider acceptance.

**Alternatives considered**: Upgrading Auth.js, replacing Fumadocs or adding a settings framework would expand scope without resolving the current singleton problem.

Evidence: `package.json`, installed package metadata, `auth.ts`, `lib/content/source.ts`; Next guides `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`, `01-app/02-guides/authentication.md`, `01-app/03-api-reference/03-file-conventions/instrumentation.md`; [Auth.js Next.js reference](https://authjs.dev/reference/nextjs).

## R3 — Standalone-safe persistence

**Decision**: Keep one bounded instance-control document containing lifecycle, instance ID, active/previous/candidate bundles (including encrypted provider credentials), administrator bindings, setup consumption, activation state and a bounded audit outbox. Use single-document compare-and-swap (CAS) operations for authority transitions. Store expiring setup sessions and bounded audit history separately; neither can confer authority without the current control document.

**Rationale**: `lib/mongo.ts` and current CI support standalone MongoDB. Single-document atomic writes work there; cross-collection transactions and change streams cannot be assumed. Co-locating configuration, credential envelopes and first-owner binding avoids partial finalization. Only three configuration bundles and 20 bindings are needed. A unique `_id` and host instance ID isolate one dedicated database per installation. Audit writes are drained idempotently from the outbox; a full outbox blocks successful mutations rather than silently dropping their audit record.

**Alternatives considered**: Separate authoritative secret/config/owner collections need distributed commit or replica-set-only transactions. An unbounded singleton history would hit storage limits. Runtime settings must not be stored in catalog documents.

Evidence: `lib/mongo.ts`, `.github/workflows/ci.yml`; [MongoDB atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/).

## R4 — Freshness is explicit operator intent

**Decision**: Add a protected persistent host marker outside public/content snapshots, containing the stable instance ID, recovery epoch and monotonic installation phase. A protected local provisioning command creates a fresh intent only for an empty dedicated database and uninitialized storage. Seal that intent before first database initialization; missing records after sealing require operator recovery, never automatic setup. Valid complete legacy configuration takes precedence over an absent v2 record.

**Rationale**: A database outage, deletion, missing key, empty mounted volume or failed restore is not evidence of a fresh installation. The marker is independent of MongoDB and must survive container recreation. A crash between sealing and initialization deliberately enters maintenance, recoverable through the protected local command and explicit evidence, rather than offering a takeover opportunity.

**Alternatives considered**: `findOne() === null` as the fresh-install test, regenerating keys automatically, a public reset endpoint, or a new process-local Boolean all violate V2-FR-001/030. Host preparation is not remote infrastructure provisioning.

## R5 — Activation without a cross-document race

**Decision**: Resolve one immutable configuration bundle per request/job. Sensitive work atomically acquires a bounded, revision/epoch-bound admission pin in the control document. Activation CAS-closes admissions, drains request pins and fences worker/catalog authority, then atomically commits the complete new bundle and bindings. No configuration background poll is needed: read current authority at admission, callback, renewal and delivery boundaries. Cache at most three immutable bundles/Auth.js constructions keyed by instance/revision/security epoch; no cached authority decisions.

**Rationale**: A singleton revision read followed by publication in a catalog is not an atomic fence. During the closed gate, CAS each of at most 20 catalogs to an activation ID/new instance runtime revision, clear old worker leases and advance existing lease fences. Include that separate runtime revision in claim, heartbeat, publication, blob writes and cleanup predicates; do not increment catalog content `configRevision` for ordinary preferences. Record each catalog's fencing completion in the control document and recheck all before commit. Late old claims/queues carry their old revision and cannot publish. Do not allow a delayed old activation operation to move a catalog revision backward. Pending activation keeps all new workers gated until the new active bundle commits.

Existing requests finish before commit or abort at their hard deadline. Delivery checks authority before/after preparing a buffered response; protected asset streams are bounded and tracked until closed. Expired request/worker pins do not authorize later effects. Every publication and destructive storage effect still requires a live catalog fence. A post-commit old OAuth callback/session write carries its old security epoch and cannot produce an authorized new-epoch session. Successful response/readiness is separate from durable commit: if process adoption fails afterward, show maintenance and reconcile the same revision, never reopen setup.

Activation drain/fencing has a 120-second maximum. On timeout, retain the old active revision and enter resumable maintenance; reconcile fenced catalogs back under a new activation token before reopening the old revision. No success is reported for an incomplete cutover. An unmodified v1 binary cannot obey these fences: drain all v1 web/worker processes before migration activation. Overlap is supported only for v2-aware binaries with the same schema/fencing contract.

**Alternatives considered**: Time-based config polling alone, a new Redis bus, or checking instance revision before a later unrelated catalog CAS does not establish coherent activation. Adding a separate worker service is excluded.

Evidence: `auth.ts`, `lib/sync/worker-startup.ts`, `lib/sync/jobs.ts`, `lib/content/generations.ts`, `lib/content/blob-cache.ts`, `lib/operations/health.ts`, webhook route.

## R6 — Identity and owner continuity

**Decision**: Reuse existing issuer/subject accounts, database sessions, PKCE/state/nonce and role refresh. Candidate setup authentication has a separate short-lived cookie/provider namespace and callback `/api/instance/auth/callback/zitadel`; it cannot create ordinary runtime authority. Use one server-recorded nonce, instance ID, candidate revision and exact verified issuer/subject for owner proof. Fresh finalization requires current `librarian-instance-admin`. Legacy enrollment requires protected operator authority plus current `librarian-admin` and `librarian-instance-admin` from the existing provider, then explicit binding.

Issuer/project/client/origin changes require the current bound owner AND successful candidate-provider login/role proof for the proposed replacement binding. Keep stable owner history; replace its active binding only in the configuration activation CAS. Ordinary additional bindings/transfer use the protected local operator command, require the current owner when available and genuine target login/role proof; maximum 20 bindings, exactly one current owner. If the owner/provider is lost, recovery requires a new out-of-band recovery authorization, maintenance mode and verified replacement identity/role; it cannot bypass target identity proof or reopen setup.

**Rationale**: Email, client-submitted subjects and Mongo user IDs are not cross-provider continuity. Reuse `getVerifiedRoles`' exact 15-minute deadline; a session renewal or configuration save must not refresh role age. Security-epoch changes invalidate old sessions and role proofs logically before any asynchronous cleanup. Candidate proofs are at most 10 minutes old and recheck required roles at finalization/activation. Owner continuity/recovery is an explicit protected operation, not an extra public administration feature.

**Alternatives considered**: Granting Settings to all catalog admins, requiring Zitadel platform administrator privileges, or deleting sessions asynchronously as the sole invalidation fence.

Evidence: `lib/auth/admin.ts`, `authorization.ts`, `roles.ts`, `adapter.ts`, `tokens.ts`; [Zitadel project role verification](https://zitadel.com/docs/guides/integrate/retrieve-user-roles).

## R7 — Outbound checks and static content

**Decision**: Provider checks use bounded server DNS and HTTPS, with each actual connection pinned to a validated address while keeping TLS hostname verification. Default allowlist is public HTTPS origins; reject loopback, link-local, metadata, multicast, private/reserved ranges and IPv4-mapped equivalents. An exact host-managed issuer-origin/address allowlist permits a legitimate private provider, without a browser bypass. Reject redirects; validate every discovery/JWKS/token endpoint against the approved origin/address policy before use. Preserve PKCE/state/nonce and JWT signature/issuer/audience checks. GitHub API destinations remain fixed. Apply the same transport policy to candidate and active provider clients, not only a Test button.

**Rationale**: Validating a hostname then allowing an automatic resolver/redirect to choose another address leaves SSRF. Use Node standard DNS/HTTPS APIs; do not assume generic `fetch` alone pins a resolved address. A check returns a sanitized code and type, not a raw response body or internal endpoint.

Static MDX syntax remains parsed as an untrusted AST, never compiled/evaluated: `lib/content/validate.ts` rejects ESM and flow/text expressions and validates the finite component/attribute grammar. `Columns` numeric literals are parsed data, not executed JavaScript. This conforms to the constitution's rejection of **executable** MDX/JSX; no broader grammar, renderer preference or amendment is introduced. Branding is plain bounded text plus existing trusted assets.

**Alternatives considered**: An unrestricted provider URL, global private-network bypass, an eval-based MDX loader, arbitrary logos or source scripts.

## R8 — Secrets, rotation and bounds

**Decision**: AES-256-GCM envelopes use random 12-byte nonces and 16-byte authentication tags; AAD includes instance ID, purpose, envelope version, key ID and credential version. Use independent random credential version IDs so unchanged envelopes remain bound when carried to a new configuration revision. Root keyring is host-managed and versioned; no OAuth key reuse. A key migration re-encrypts candidate/active/previous envelopes under maintenance and retains old host keys until all recoverable bundles and backups expire. Never mutate old OAuth ciphertext format.

Retain one previous configuration bundle and one candidate. Webhook rotation accepts at most one old secret for at most five minutes after explicit cutover, with server-side `acceptUntil` checks on every delivery. Sender changes are a separate operator action; manual cutover can have a delivery gap, recovered by manual sync and durable deduplication. Rollback never extends a retired old-secret acceptance deadline; it requires a fresh validated rotation or explicit maintenance recovery.

**Alternatives considered**: Plaintext previous secrets, indefinite overlap, silent empty-string deletion, or seamless sender updates without a GitHub write integration.

Evidence: existing token crypto and webhook verification; [Node crypto authenticated encryption](https://nodejs.org/download/release/v22.21.0/docs/api/crypto.html).

| Policy | Bound / behavior |
|---|---|
| Bootstrap / recovery credential | At least 32 random bytes, protected host file; verifier only in MongoDB; fresh authority expires after 24 h; one installation epoch, consumed at readiness |
| Setup sessions / candidate authentication | 30-minute absolute session; at most 8 live sessions per instance; proof/state nonce single-use, 10-minute expiry; HttpOnly/Secure/SameSite cookies; fresh nonce after expiry |
| Guessing / mutations / checks | Durable instance-wide 5 failed bootstrap attempts/minute and 100/day; 30 mutations/minute and 6 integration tests/minute per bound actor or authorized setup session; aggregate before writing audit to avoid unbounded attack storage; reject with 429 |
| Admission / activation | At most 64 request pins (30 s maximum) and 1 ingestion pin (120 s); no renewal beyond operation deadline; gate CAS blocks new admissions; cutover/drain maximum 120 s; no stale new admissions after commit |
| Provider requests | 5 s DNS/connect, 10 s total per request, 30 s per check workflow, no redirects, 512 KiB total check response bytes, bounded discovery/JWKS keys; one concurrent provider check per instance |
| Input / stored control document | 64 KiB JSON request; 16 KiB private key, 4 KiB client secret, 1 KiB webhook secret; control document <=512 KiB including ciphertext; reject before durable growth |
| Drafts / revisions / bindings | One durable draft/candidate; active plus one previous bundle; up to 20 explicit bindings; previous retained <=24 h, except explicit in-progress recovery lock; unreachable retired secrets pruned after grace |
| Checks | Up to 12 typed checks per candidate; exact revision; <=10 minutes old at activation; changed candidate invalidates all proof rather than guessing dependency equivalence |
| Audit / operational state | 90-day TTL and hard cap 10,000 events; <=1 KiB/event, no values/bodies; 128-event control outbox; 1 h setup-session cleanup TTL with explicit 30-minute expiry checks; bounded rate buckets deleted after 48 h |
| Recovery | Inherited worker recovery <=45 s; consistent restore/previous-image exercise <=30 min on declared corpus; v2 interrupted activation reconciles or reports maintenance within 120 s |

Bounds are design acceptance targets, not measured performance. Trusted server/database time determines expiry; reject invalid/backward timestamps. TTL is cleanup only, never authorization. Sustained throttle or storage failure fails affected work closed. Publication, request, retention and lease limits already in `lib/limits.ts` remain in force; the stricter applicable bound wins.

## Research outcome

All original D1–D3 choices and technical design unknowns have a recorded disposition. Live provider compatibility, workload, restore, previous-image rollback, and deployment remain evidence gates in the spec's BG-01–03; they are not unresolved design choices or a claim of completion. Tasks must implement and prove this design before feature acceptance.

## Security maintenance update — 2026-10-28

The selected Next.js 16.4.0 was included in the affected range for the 2026-10-14 upstream security advisories. Updated only `next` to the official patched 16.4.1 release in `package.json`, `package-lock.json`, and `pnpm-lock.yaml` so the production build and real-Next coverage checks can run. No deployment or live operation occurred. See the [Next.js security update](https://nextjs.org/blog/nextjs-security-update-october-14-2026) and [patched-version advisory](https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr).
