# Data Model and State Transitions: Librarian v1

**Status**: Planned schemas/protocols; no collections, migrations, or live data created.
**Authority**: [specification](spec.md), [plan](plan.md), [HTTP contract](contracts/http.md).
All timestamps are UTC instants; numeric policy values come from the plan, not hidden defaults.
Use the official MongoDB driver directly and validate records on write/read. No credentials or
private bodies belong in catalogs, jobs, manifests exposed to users, or operational logs.

## Catalog Aggregate: catalogs

One small document owns each catalog's configuration, ingestion lease and publication authority.

| Field | Required meaning / validation |
|---|---|
| _id | Server-generated catalog UUID; never derive a filesystem path from user title/slug |
| github | Stable numeric repositoryId and installationId; owner/name; one branch and POSIX docsPath validated with read-only App lookup |
| slug | Lowercase ASCII letter/digit/hyphen, 1-63 chars, starts with letter; unique; reserve admin, api, _next, auth, health and framework asset names |
| title / publicDescription | Explicit safe directory strings, <=120 / <=500 Unicode characters; strip control characters, no source-derived defaults for private catalogs |
| visibility / readerRole / enabled | public or private; default private for private source; default role docs:{slug}:reader; role string <=200 chars; enabled Boolean |
| accessState | unverified, ready, blocked; confirmed App removal/access loss becomes blocked and disables serving |
| configRevision / authEpoch | Monotonic integers; changes to source/branch/folder/slug/role/visibility invalidate incompatible publication and delivery |
| published | Nullable complete generation pointer: generationId, commitSha, jobId, fence, configRevision, manifestDigest, publishedAt |
| publicationRevision | Monotonic conditional-update counter; distinguishes pointer races |
| retained | Up to two previous selectable generations valid for current config, within plan's grace/age/slot rules |
| lease | Nullable owner UUID, fence, expiresAt, heartbeatAt; catalog's leaseFence monotonically increases on claim |
| readPins | Bounded requestId/generationId/expiresAt entries; select/pin and retention eligibility update in this aggregate |
| admissionReservations | Monotonic lifetime count <=100,000; reserves a slot before inserting a durable job; safe overcount is acceptable, undercount is not |
| rateWindow | Server minute/window and count for valid admission attempts; <=60/minute; checked atomically |
| approvalRef | Nonsecret reference to owner-provisioned public approval; absent for private catalogs |
| lastSuccess / lastFailure | Last successful commit/time and sanitized code/time/job identifiers; no provider payload or document body |
| createdAt / updatedAt | Server timestamps and optimistic update version |

Indexes: unique slug; unique (repositoryId, branch, docsPath) to avoid accidental duplicate catalogs;
enabled/accessState for directory projection. Catalog count admission uses a small singleton quota
document with <=20 reservations; failed creates can overcount safely until offline reconciliation.
Unique-source behavior is a documented v1 default; different folders/branches may be distinct catalogs.

Configuration updates compare If-Match revision. Safe metadata-only edits preserve publication.
Source identity, slug, reader role or visibility changes increment configRevision/authEpoch, fence
old workers, remove selectable pointers and require compatible resync/review. Old immutable files
remain for in-flight cleanup/recovery, never under incompatible new settings. Disablement immediately
blocks serving and invalidates lease; reenabling after access loss requires successful access validation.
No catalog deletion UI/API is part of v1.

## Public Approval: Owner-Controlled Manifest

A read-only operator-mounted approval manifest, separate from mutable admin catalog records, contains:
approval ID/version, owner approval date/reference, repository ID, branch, docsPath, slug, reviewed
commit and candidate manifest digest, and explicit approval of future Git-authored updates within
that same reviewed source scope. No secret or private body is recorded.

Admin chooses an existing approvalRef; the server validates its exact scope before public enablement.
A client Boolean claiming approval or librarian-admin role is insufficient. Initial candidate is
reviewed before public activation; subsequent safe commits in the explicitly approved scope may sync
automatically as required by v1. Source-scope changes revoke applicability and need fresh owner review.
Approval manifest provisioning/publication occurs only through concrete owner-approved infrastructure
work. This is an enforcement mechanism for FR-013, not a new owner-role product or approval service.

## Durable Sync Job and Replay Receipt: syncJobs

One unique job record is also its permanent replay receipt; compact terminal records remain.

| Field | Meaning |
|---|---|
| _id | github:{appId}:{deliveryId}:{catalogId} or manual:{catalogId}:{idempotencyKey}; bounded validated identifiers |
| catalogId / configRevision | Accepted source scope; configuration changes cannot reuse a candidate |
| origin / event / payloadDigest | github/manual, accepted event/action, SHA-256 of original verified payload for replay conflict detection |
| admissionSequence | Catalog-assigned monotonic sequence; gaps are safe; NOT a Git commit ordering rule |
| state | queued, running, retry_wait, succeeded, failed, cancelled |
| requestedAt / availableAt / attempts | Indexed scheduling; at most 5 actual ingestion attempts |
| owner / fence / targetCommit | Claimed lease and provider-resolved current branch SHA, not blindly trusted webhook SHA |
| generationId / result | Published pointer identity or sanitized terminal failure |
| completedAt / detailExpiresAt | Terminal details compact after 14 days; unique receipt never expires automatically |

Indexes: unique _id; (state, availableAt, requestedAt); (catalogId, state); terminal compaction due time.
Never TTL-delete replay IDs. Compaction keeps ID, catalogId, configRevision, payloadDigest and terminal
outcome/times, removing detailed retry/error state. All job bodies are bounded small control metadata.
No raw push body or document body is persisted. A delivery matching several catalogs has a unique
receipt per matched catalog; branch matching applies to push work. Signed installation-removal events
match the configured App/installation/repository instead and idempotently disable all affected catalogs
before acknowledgement. Control events idempotently block serving before receipt admission,
even for already disabled catalogs or exhausted work-admission quota/rate. Persist their bounded
receipt before acknowledging; if storage/quota prevents it, return failure with serving still blocked
where the catalog update succeeded. Retry/reconcile partial disable even when a receipt already exists.
No content fetch occurs in that request.

Push/manual admission: validate raw-body size/signature and source match; check existing ID/digest; atomically
reserve catalog quota/rate/sequence under enabled/current config; insert unique queued job with
acknowledged journaled write; only then return success. Quota reservation and job insertion are
separate writes: crash can waste a reservation, but cannot acknowledge nonexistent work. Duplicate
insert races return the existing receipt and may conservatively consume a reservation. Do not decrement
counters blindly or infer acceptance from a reservation. Exhaustion returns explicit backpressure.
Any offline reconciliation requires intake quiescence; no autonomous dedupe purge is permitted.

## Worker and Publication Protocol

1. Query at most 20 ready job references; each server processes one job at a time. Atomically acquire
   its catalog lease when no live owner exists; increment fence using Mongo server time.
2. Match configRevision and valid enabled/access state. Resolve configured branch's current commit
   and selected tree using installation token. Late/out-of-order deliveries sync current head;
   force-pushes are legitimate new current state, not compared lexicographically.
3. Claim one staging slot keyed by owner/fence/job. Reject unsafe Git modes, truncated/incomplete
   traversal, unsupported files and inputs outside plan bounds. Decode/fetch at most two blobs at once.
4. Validate/normalize all Markdown, metadata, links and asset bytes; enforce cumulative normalized
   size; precompile/index the entire candidate enough to surface validation/render/index errors.
   Never execute repository scripts, dependencies or executable MDX. Confirm current branch head
   still matches; changed head discards/requeues candidate within attempt/retry limits.
5. Write manifest checksums/complete marker, flush files and directory metadata with platform-supported
   durability, rename atomically on the same filesystem into an immutable generation directory.
   An orphan complete directory is not a publication.
6. Ensure a reclaimable committed slot exists; never reclaim active/pinned snapshots. Update ONE
   catalog document conditional on configRevision, owner/fence, unexpired lease, enabled/access state,
   and expected publicationRevision. Set new published pointer/revision/lastSuccess and retention
   references together. No matching update means no publication.
7. Mark job succeeded by its fence. If that write fails/crashes after step 6, reconcile from catalog's
   published.jobId/fence or its retained publication receipt; never republish stale work.
8. Release lease/pins appropriately; cleanup only nonselectable, unpinned, expired staging/retired slots.

No protocol assumes atomicity between Mongo and filesystem or between job/catalog documents.
Authority is the catalog pointer plus complete manifest. A former lease holder cannot publish after
a new fence. A process losing its lease cancels network/render work, does not create/recreate paths,
and performs no publication writes. Staging cleanup never deletes a live-owner candidate.
Integration tests inject failures before/after every durability and conditional-update boundary.

| Transition / failure | Outcome |
|---|---|
| queued -> running | Job references live catalog owner/fence; stale job state alone never authorizes work |
| running -> succeeded | Only after successful authoritative publication |
| running -> retry_wait | Transient transport/rate-limit/storage/concurrency error; valid publication retained |
| running -> failed | Invalid content or exhausted attempts; actionable sanitized status |
| any unfinished -> cancelled | Configuration/disablement invalidates accepted scope; retained content not served under new scope |
| restart with abandoned running | Expired lease recovered within <=45 s after heartbeat with healthy storage; reconcile success before retry |
| crash after rename before pointer | Orphan complete generation remains unserved; safely reclaim or reuse only after full same-scope validation |
| crash after pointer before terminal status | Published job/fence proves success; reconcile receipt |
| confirmed App removal/access loss | Catalog blocked/serving disabled; no stale-snapshot fallback |
| temporary GitHub failure | Keep last valid compatible generation; failed sync status remains visible |

Keep the last publication's job/fence proof until its terminal job transition is durably reconciled;
require that reconciliation before a later publication replaces it. One outstanding publication proof
suffices; do not accumulate an unbounded embedded receipt history.

## Immutable Files and Manifest

Planned content root is operator-provided, outside public and outside the build context:

    CONTENT_ROOT/
      catalog-uuid/
        staging-owner-fence/
        generations/generation-uuid/
          docs/**/*.md
          docs/**/meta.json
          assets/validated-path
          manifest.json

A manifest has formatVersion, catalogId/configRevision, generationId, commitSha/tree SHA, worker fence,
complete timestamp, normalized byte count, and per-document/asset path, SHA-256, size and allowed type.
Document records include canonical route, safe parsed title/description, headings/links and asset
mapping; this metadata remains protected along with bodies. JSON attachments are not navigation JSON.

Generation/path identifiers are server generated; realpath checks and no-follow opening defend
filesystem boundaries even after Git-mode checks. Relative links resolve POSIX paths under the docs
folder; normalize .md/index paths and heading anchors, reject ambiguous route collisions, retain the
selected generation on rewritten local links/assets. External https/mailto links are never fetched
server-side; remote images, unsafe schemes and root-relative cross-project escapes are rejected.
New requests without generation select latest; explicit old generation requests must still authorize
current config and select only retained published generations. Missing/expired generation returns
reload_required, never a silent mixed-generation fallback.

Each response pins the selected generation atomically against current selectable catalog state
before opening cache/files; max 64 pins and 60-second lease, with 30-second delivery timeout.
Cleanup atomically removes a generation from selectable state only when no live pins remain.
Retained slot pressure safely defers/fails ingestion; it does not delete content needed by reads.

## Identity, Account and Permission Records

Use the official adapter's users/accounts/sessions collections in the scoped application database.

- User/account linkage binds provider issuer and subject; no authorization solely from an email.
- Session uses official opaque HttpOnly, secure in production, same-site cookie; createdAt and
  absoluteExpiresAt enforce 8-hour absolute lifetime even if Auth.js renews its expires field.
  Sessions are checked server-side, not accepted from a client session callback.
- OAuth access/refresh/ID token fields are encrypted at the account-storage boundary with
  authenticated encryption and a scoped operator-provided key. Official adapter account writes and
  token reads pass that boundary; tokens are decrypted only in server memory for provider use.
- Separate identity-state keyed by issuer/subject/project: roles, verifiedAt, token/role lease owner,
  fence/expiresAt, and sanitized refresh state. Records never enter client payloads/raw logs.
- Token renewal compares lease fence/current token version; store rotated tokens atomically.
  If logout/session expiry occurs during refresh, do not deliver or resurrect that local session.
- Current-role API uses bounded complete active assignments for the exact user/project; malformed,
  wrong-subject/project, incomplete pagination and provider/storage failures deny. Successful empty
  roles are a verified denial. Session renewal never modifies verifiedAt.
- Role lease 10 seconds; provider timeout 5 seconds; contenders wait <=2 seconds for completed
  current verification, otherwise fail closed. No expired grant is served while refresh is pending.
- Delete local session first on logout; broadcast/hard navigation scrubs caches. Provider end-session
  and revocation use only allowed URLs/server-held tokens. Local logout persists despite provider outage.

Indexes: adapter-required user/account/session lookups; unique provider+providerAccountId; unique
sessionToken; session expiry cleanup; unique identity issuer+subject+project. TTL cleanup is not
authorization: handlers compare actual expiry at request time.

## Validation, Durability and Recovery Prerequisites

Use primary reads for catalog/session decisions and acknowledged journaled writes for acceptance,
lease and publication. Use majority acknowledgement when supported by the actual topology; do not
assume secondary reads or distributed transactions. Version/topology/write concern support must be
verified before ingestion deployment. Unavailable persistence denies protected access and accepted work.

Mongo connection pool is shared and bounded (maxPoolSize 10, minPoolSize 0, finite selection timeout);
worker failure must not leave unbounded clients/timers. Backups include catalog/jobs/receipts,
identity/account/session state and corresponding immutable directories as one consistent set.
A restore can deliberately invalidate sessions and require re-login; it cannot relax reader roles.
No destructive schema migration is planned.
