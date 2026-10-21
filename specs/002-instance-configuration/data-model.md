# Data Model: Instance Configuration

**Status**: Original v2 design plus owner-approved full-configuration encryption amendment, 2026-10-21. New names are proposed implementation interfaces; see the amendment addendum for v2 persisted schema semantics.

## Identity and storage boundary

One dedicated MongoDB database belongs to one installation. Every new record carries the host-provisioned UUID `instanceId`; all queries include it. A singleton `_id: "instance"` rejects a different host instance ID rather than adopting it. Existing catalog/auth/job collections remain in the same dedicated database with unchanged IDs; they are never shared across unrelated installations. No multi-document transaction is required.

Protected host inputs: bootstrap Mongo URI/database locator, immutable instance ID, trusted setup origin, persistent installation/recovery marker, independent OS/KMS keyring, bootstrap/recovery verifier file, content location, owner publication-approval input, and outbound destination policy. Production root inputs use scoped Swarm secrets or an approved OS/KMS provider; the marker uses durable protected storage. Ordinary Settings never returns or rewrites these. Auth.js/session, OAuth token key, provider values, supported preferences, and the encrypted copy of Mongo configuration are inside the full application bundle after migration. Loss/mismatch means maintenance, never implicit replacement.

## Instance control — `instance_configuration`

Exactly one authoritative document, <=512 KiB encoded BSON; validate the encoded size before each CAS.

| Field | Type / validation | Meaning |
|---|---|---|
| `_id`, `instanceId`, `schemaVersion` | Literal `instance`, UUID, integer `2` | Unique identity, exact supported encrypted-bundle schema; newer schema fails closed |
| `revision`, `nextBundleVersion` | Monotonic safe integers | CAS revision for every durable control mutation; bundle versions never reused |
| `lifecycle` | `configuring`, `awaiting_owner`, `ready`, `maintenance`, `legacy_migrating` | Fresh and legacy detection precede document creation; no ready-to-fresh transition |
| `createdAt`, `updatedAt`, `initializedAt` | Server dates; initialization nullable until finalization | No client-supplied time authority |
| `bootstrap` | `epoch`, verifier hash, expiry, `consumedAt`, <=8 `{sessionHash,expiresAt}` reservations | High-entropy credential verifier and atomic live-session cap; finalization consumes within same document update as owner/ready state |
| `securityEpoch`, `recoveryEpoch` | Monotonic integer / host-matching token | Logical session invalidation and independent restore fence |
| `active`, `previous`, `candidate` | Nullable sealed bundle records retaining only version/timestamps/actor and required control metadata plus one authenticated-encrypted complete configuration envelope | No setting value or credential may be duplicated in plaintext in the Mongo document; server code decrypts to the logical bundle only in memory |
| `administrators` | <=20 stable issuer/subject bindings; exactly one current owner after initialization | Binds authority; role requirement is checked separately on every instance operation |
| `gate` | `open`, `closing`, `maintenance`; activation token; deadline | Atomic admission barrier |
| `admissions` | <=64 request pins and <=1 worker pin | Server-generated random ID, bundle version, security/recovery epochs, purpose, creation time and hard expiry; bounded operations release explicitly |
| `activation` | Nullable `{id, from, to, phase, actor, deadline, fencedCatalogIds, result}` | One resumable cutover at a time; at most 20 catalog entries; CAS token guards delayed reconcilers |
| `auditOutbox` | <=128 bounded events | Appended atomically with accepted authority/config change; consumed idempotently into audit collection |
| `migration` | Nullable sanitized source digest, mode, timestamp, verification summary | Digest uses safe non-secret fields plus keyed secret fingerprints; never raw env/path/credential values |

**Index**: MongoDB `_id` unique index suffices for singleton authority. Check `instanceId` in every predicate. Validate each nested object strictly; unknown fields/algorithms/newer schema reject without overwrite. Admission operations change the CAS revision but not the configuration bundle version; API edit preconditions use the candidate/control edit token returned by that API, not a user-computed counter. Distinguish frequent admission revision from `editRevision`: an additional monotonic `editRevision` advances only draft/config/admin/activation mutations, so ordinary readers do not make every Settings save stale.

## Logical configuration bundle (embedded after decryption)

The logical shape below is never persisted in plaintext. Mongo stores an AES-256-GCM envelope over the complete strict bundle, including all preferences, origins, provider identifiers, session/OAuth keys, Mongo URI copy/database name, runtime flags and provider secret envelopes. The ciphertext is bound to `instanceId`, purpose `instanceConfigurationBundle`, key ID and immutable bundle version. Bundle version, timestamps, actor, checks, owner proof, impact, and rollback expiry remain outside only where required for CAS, authority, validation and audit; duplicated configuration values do not. Envelope and BSON bounds are checked before every insert/CAS. Unknown schemas, missing roots, tampering and cross-instance substitution fail closed.

| Field | Type / rule |
|---|---|
| `version`, `createdAt`, `createdBy` | Monotonic safe integer, server date, stable actor or protected operator action ID |
| `preferences` | Display name 1–120 Unicode code points, description <=500, normalized non-escaping docs folder <=1024 bytes and <=32 segments; reject controls and executable markup |
| `publicOrigin` | Exact HTTPS origin, no credentials/path/query/fragment; loopback HTTP only in isolated DEV |
| `zitadel` | Exact approved issuer origin; client/project/audience identifiers retain current config validation; no subject/email hints as authorization |
| `github` | Positive decimal App ID; provider fixed to GitHub; no repository write scopes |
| `secrets` | Active/previous bundles require purpose-keyed encrypted client secret, App key and webhook secret; candidate drafts may keep each envelope null until replaced. Optional prior webhook secret expires on its declared deadline |
| `checks` | <=12 typed revision/time-bound results; status `not_run`, `passed`, `failed`, `warning`; safe code only |
| `ownerProof` | Optional candidate instance/version/issuer/subject/project/security epoch/nonce/expiry; derived from actual candidate callback, not browser input |
| `impact` | Changed categories, required auth epoch increment, affected source revalidation, confirmation nonce; server-derived |
| `previousUntil` | Previous bundle only; <=24 h, or explicit protected maintenance recovery hold |

Allowed runtime preferences are the finite fields above plus existing trusted assets; no new renderer mode, sync knob or upload. Source defaults affect future catalogs only. Fresh setup persists a validated, possibly incomplete candidate draft so the seven-step wizard can resume after session expiry or process restart. Blank secret input means unchanged; explicit nonempty `replace` creates a new credential version/envelope, invalidates checks and preserves active credentials. No ordinary delete/reveal action exists. Candidate edits increment bundle version and invalidate all checks/proofs; update CAS requires the returned `editRevision` and candidate version. Provider checks and finalization reject missing required identifiers or envelopes; partial candidates cannot become active bundles.

### Authenticated secret envelope

`{formatVersion: 2, algorithm: "aes-256-gcm", keyId, credentialVersion, nonce, tag, ciphertext, updatedAt}`. All binary fields are canonical base64; nonce decodes to 12 bytes and tag to 16; key ID must exist in the host keyring. Random nonces per encryption. AAD is an unambiguous canonical encoding of envelope version, instance ID, purpose, key ID and immutable bundle version. Purpose cannot be relabelled. Decryption checks tag/AAD before returning plaintext server-side; wrong key, malformed envelope or substituted context fails closed. The exact existing OAuth token-encryption key is preserved inside the encrypted bundle to retain token compatibility. Limits are bounded so the complete document remains below 512 KiB.

Key rotation is host-assisted maintenance: provision a new key ID, re-encrypt all retained bundles without changing OAuth format, CAS replace envelopes, validate restart/decryption and retain old keys for surviving backup sets. Never delete an old key until every required restore point is accounted for. Key values are never audit fields. Recovered plaintext exists only in short-lived server memory needed for provider operations.

## Administrator binding (embedded)

`{bindingId, issuer, subject, projectId, kind: owner|administrator, status: active|retired, boundAt, boundByActionId}`. Unique active `(issuer,subject,projectId)` within the installation; exactly one current owner, immutable history of first enrollment. A valid binding alone is insufficient: a current authenticated session with matching instance/security/recovery epoch and verified `librarian-instance-admin` is also required. Owner-only actions are provider/identity/origin replacement and protected binding changes. `librarian-admin` remains necessary for catalog operations; reader roles remain necessary for private content.

Legacy owner binding requires protected operator authorization, verified current legacy identity and both admin roles, plus explicit confirmation. Additional bindings/transfer and recovery use the protected operator procedure and verified target identity/proof; no arbitrary email matching. Transfer retires previous owner binding atomically with new binding/epoch. Recovery preserves initialized state and cannot clear bootstrap consumption.

## Setup sessions — `instance_setup_sessions`

`{_id: randomTokenHash, instanceId, setupEpoch, recoveryEpoch, createdAt, expiresAt, purgeAt, csrfHash, candidateVersion, lastNonceHash, purpose}`. Opaque random bearer token exists only in Secure/HttpOnly/SameSite cookie; server stores its hash. Unique `_id`, index `(instanceId,expiresAt)`, TTL index on `purgeAt` with `expireAfterSeconds:0`; purgeAt is expiresAt plus one hour. Explicit absolute 30-minute expiry check is mandatory even if TTL deletion is delayed. At most eight live sessions; admission under the singleton prevents a race around the cap. Matching current singleton epoch, not-ready lifecycle and unconsumed bootstrap are required for every setup use. Durable drafts survive session expiry; a new authorized session resumes without inheriting expired owner proof.

The same limited session record can represent protected legacy-enrollment/recovery authorization, with a distinct purpose. It cannot be used as general Settings authorization. Candidate login temporary state/nonce is single-use, <=10 minutes, uses isolated cookies and is bound to that session/candidate. Runtime login continues at `/api/auth`; candidate authentication never links arbitrary runtime accounts.

## Audit events — `instance_audit_events`

`{_id: eventId, instanceId, at, actor: boundedStableIdentityOrOperatorId, operation, fromVersion, toVersion, resultCode, requestId}`. Unique `_id`; index `(instanceId,at)` and TTL `at + 90 days`; hard count <=10,000 per instance enforced by bounded trimming before insert. Each event <=1 KiB. Include no submitted values, secret ciphertext, paths, provider bodies, email or private document content. Denied unauthenticated attempts aggregate into capped minute/day buckets in control state; do not create one audit record per hostile request.

Authority changes append event metadata to the control outbox within their CAS. Drain by idempotent upsert, then remove only acknowledged event IDs with CAS. A crash can cause a duplicate upsert, never a duplicate logical event or unaudited ready commit. Full outbox denies new mutations, with maintenance diagnostics. Cap/TTL truncation is documented bounded history, not an immutable compliance archive.

## Existing entities extended, not replaced

- **Catalog**: Add separate `instanceRuntimeRevision` and `activationId` authority fields to the existing document. Preserve catalog `configRevision`, slug, IDs, access/publication state, GitHub installation mapping and generation pointers. Every worker side effect predicates on live catalog lease/fence AND matching runtime revision/activation token. Legacy v1 binaries must be drained before this policy becomes authoritative.
- **Sync jobs and worker status**: Carry instance ID/runtime revision; old queued jobs are revalidated/rebound by a current worker or marked superseded, never blindly executed. Health includes lifecycle/schema/runtime revision/adoption. Keep durable delivery identities and GitHub App namespaces; a secret-only rotation does not reset them.
- **Auth sessions / role grants**: Add instance/security/recovery epoch to new runtime sessions; accept legacy sessions only under explicit validated legacy migration policy. Identity/project cache keys and original `verifiedAt` remain; changing epoch makes old role proof unusable without verification. Do not bulk-delete accounts/tokens to simulate atomic security invalidation.
- **Generations / blob cache / read pins**: Keep immutable manifests/content revisions and original-blob integrity; add runtime fence to effects/admission, not to content identity. Preserve active snapshots and in-flight readers through the declared drain/grace.

## State transitions and crash recovery

| From | Event and precondition | Atomic authority outcome / recovery |
|---|---|---|
| Host fresh intent, no data | Protected provisioning, sealed marker, verified empty dedicated storage | Create one `configuring` singleton; unique insert excludes second initializer; crash/absent data after sealing is maintenance |
| Valid legacy, no singleton | Valid legacy environment/files, protected enrollment | Continue legacy runtime; create `legacy_migrating` candidate without displacing active legacy until explicit cutover |
| Configuring | Authorized strict draft save / complete checks | Candidate only; invalidates stale proof; active runtime remains unavailable |
| Configuring | Genuine owner login/role proof for current candidate | `awaiting_owner`; proof expires or candidate edit returns to configuring |
| Awaiting owner | Explicit review, required checks/role recheck, exclusive CAS | One owner/bundle/readiness commit and consumed bootstrap; adopt runtime before reporting success |
| Ready | Candidate save/check | Active unchanged; failed candidate remains visible as failed draft |
| Ready | Authorized activation with current edit/version/impact proof | Close gate, drain/fence catalogs, commit bundle/bindings/epochs atomically, then reopen admissions for current runtime |
| Closing | Timeout/crash/key/database error | Preserve old active or already committed new active; maintenance; resume by recorded activation ID, never restart enrollment |
| Ready / legacy | Missing record/key/storage or host mismatch | Maintenance; no fresh fallback, secret regeneration or public access |
| Maintenance | Protected restore/recovery with new host recovery epoch and verified identity | Reconcile same initialized identity, retire unsafe sessions/bootstrap state and validate health before reopening |

For standalone cross-document fencing, follow R5 in [research.md](research.md); a read-before-write revision comparison alone is insufficient. Crash injection is required before/after every durable transition, catalog fence and outbox write. A rollback is a new validated activation/version; never decrement counters, revive bootstrap authorization or extend retired webhook-secret deadlines.
