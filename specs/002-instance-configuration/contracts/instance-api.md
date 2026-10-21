# Instance Setup and Settings Contract

**Status**: Interfaces are implemented in the working tree; functional, security and coverage acceptance remain open. Presence of a handler is not verification of its contract.

## Shared rules

- Page routes: `/instance/setup` and `/instance/settings`. `/repositories` remains catalog administration. No root `/setup` or `/settings` alias/redirect is added; those paths remain available to catalogs. On confirmed fresh instances `/` leads to `/instance/setup`; valid legacy and ready instances retain their directory. Shared navigation reveals Instance Settings at `/instance/settings` only to a verified bound instance administrator; setup uses its dedicated authority independently of catalog-page layout authorization. Reserve the `instance` namespace only after checking for an existing catalog collision; block route enablement pending explicit owner resolution, never silently rename, remove or shadow that catalog. No aliases or redirects from the former repositories namespace are added.
- New API prefix: `/api/instance`. All handlers are Node runtime, dynamic and explicitly `Cache-Control: private, no-store`; never statically prefetch private setup/settings state. Do not use layout/navigation visibility as the authorization boundary.
- Normal instance access requires a valid active-epoch session, explicit active issuer/subject/project binding and currently verified project role `librarian-instance-admin`. Owner continuity operations additionally require `kind=owner`. `librarian-admin` alone cannot use this API; instance access does not grant catalog mutations or private reading.
- Setup access requires a current hashed opaque setup-session token, matching instance/setup/recovery epochs, unconsumed bootstrap, allowed lifecycle and expiry. No instance ID, owner subject, role or server time sent by the client is trusted as proof.
- Mutations require exact trusted Origin and CSRF double-submit or session-bound token, strict JSON content type and schemas, <=64 KiB streaming body limit, bounded rate limits and current edit/version preconditions. Fresh setup uses the protected host setup origin, not request Host/forwarded headers. The setup page issues a short-lived pre-session CSRF cookie/token for the authorization POST; this is not setup authority and contains no bootstrap credential. OIDC callbacks instead validate protocol state/PKCE/nonce and exact callback/issuer binding; they do not require a browser Origin header that redirect callbacks need not send. Reject malformed duplicate/ambiguous input.
- Use existing sanitized error envelope `{error:{code,message},requestId}`. Never return submitted secrets, ciphertext, paths, raw discovery/provider responses, bootstrap token, token hashes or raw environment. Each denied/failed operation has a finite stable safe code.
- API snapshots distinguish `editRevision` from changing request-admission counters, and `activeVersion` from `candidateVersion`; no client arithmetic. Return `ETag` for the edit revision; writes require exact `If-Match` plus the candidate version where applicable. Stale writes return 409 with a fresh safe snapshot or refresh URL, never merge silently. CAS predicates include instance ID and exact allowed state.

## Routes and authorization

| Method / route | Authority | Input | Success/output |
|---|---|---|---|
| POST `/api/instance/database` | Current protected bootstrap credential; prepared host only; exact setup Origin and bounded requests | `{credential,mongodbUri,mongodbDatabase}` | 200 configured; seals the prepared marker and writes the private startup locator. Reject populated or unrelated databases; ready instances reject this endpoint. |
| GET `/api/instance/status` | Anonymous, bounded | None | 200 `{version, state: setup_required|ready|maintenance, prerequisitesAvailable:boolean}`; no integration/owner details, counts or secret inventory |
| POST `/api/instance/setup/authorize` | Protected bootstrap credential | JSON `{credential}` and fresh pre-session CSRF/origin check | 200 sets opaque setup cookie; safe `{expiresAt,csrfToken}`; credential is never echoed |
| GET `/api/instance/setup` | Setup session | None | Safe draft, steps/checks, expiry, candidate version, edit revision and computed callback/webhook URLs |
| PATCH `/api/instance/setup` | Setup session | Exact `If-Match`; `{candidateVersion,changes,secretReplacements?}` | 200 canonical safe draft, incremented versions; no runtime activation |
| POST `/api/instance/setup/check` | Setup session | Exact precondition; `{candidateVersion,type}` | 200 completed typed result, or 202 pending signed-delivery proof; failed check is an explicit result, not fake success |
| GET/POST `/api/instance/auth/[...nextauth]` | Setup session or current owner plus continuity state | Standard bounded OIDC flow; state bound to exact candidate and purpose | Candidate authentication only; recorded proof and local return to setup/settings; separate cookie namespace from runtime Auth.js |
| POST `/api/instance/setup/finalize` | Setup session plus verified candidate owner and current instance-admin role | Precondition; `{candidateVersion,confirmationNonce,confirm:true}` | 200 safe ready snapshot/local next URL only after committed state and successful local runtime adoption; 202 pending reconciliation when committed but adoption not yet proven |
| GET `/api/instance/settings` | Bound instance administrator AND role | None | 200 canonical sanitized active/candidate snapshot, CSRF token, impact/check/owner metadata |
| PATCH `/api/instance/settings` | Bound instance administrator AND role | Exact precondition; same draft-change shape | 200 safe candidate; active unchanged; Cancel in UI makes no request |
| POST `/api/instance/settings/check` | Bound instance administrator AND role | Exact precondition; `{candidateVersion,type}` | Typed, time/revision-bound result as above |
| POST `/api/instance/settings/activate` | Bound instance administrator AND role; owner for identity/origin changes | Exact precondition; `{candidateVersion,confirmationNonce,confirm:true}`; current owner continuity proof when relevant | 200 active/adopted snapshot or 202 bounded in-progress/committed-adoption-pending status; 409 incompatible transition |
| POST `/api/instance/settings/rollback` | Same as activation; current owner for identity changes | Exact precondition; `{previousVersion,confirmationNonce,confirm:true}` | Validates a new candidate copied from recoverable previous bundle; 200 candidate requiring checks/activation; never rewinds counters or silently re-enables retired secrets |
| GET `/api/instance/audit` | Bound instance administrator AND role | Opaque pagination cursor; limit 1–50 | <=50 safe events, bounded cursor; never secret history or complete unrestricted export |
| POST `/api/instance/migration/authorize` | Protected operator credential plus current verified legacy librarian-admin AND instance-admin roles | Credential through bounded JSON; normal session CSRF/origin; explicit legacy identity | Sets purpose-limited enrollment cookie; no automatic Settings grant |
| POST `/api/instance/migration` | Purpose-limited protected enrollment, both verified roles, explicit owner proof | Precondition; `{confirmImport:true,confirmationNonce}` | Safe imported candidate and pending owner binding; legacy remains authoritative until normal validated activation/finalization path completes |

Ready state rejects every setup authorize/draft/check/finalize attempt, including restored/old cookies, with `setup_closed`. A safe setup page links to normal sign-in/Settings; it never reopens enrollment. Repeated finalize requests with the same accepted attempt ID return the same sanitized committed outcome without another owner; different attempts are rejected. A committed-but-not-adopted result does not permit another initialization.

Checks use a fixed enum: `database`, `zitadel_discovery`, `zitadel_owner_login`, `github_structure`, `github_authentication`, `github_permissions`, `github_installation`, `github_webhook`. Database checks verify connectivity; a Settings connection edit additionally must reach the current live instance, verified with matching authority/version metadata and a fresh source-side nonce. No data migration occurs. Identity login check starts an OIDC flow; it cannot accept a subject from JSON. Check snapshots show `not_run`, `passed`, `failed` or `warning`, safe code, checked time, candidate version and applicability. Only required successful current checks plus current owner/role proof allow finalization. Missing installation or unobserved signed delivery may remain an explicit warning before the first catalog exists; serving a catalog still requires installation/source/publication checks.

## Candidate edit and response shapes

`changes` is a strict partial object limited to `displayName`, `description`, `defaultDocsFolder`, `publicOrigin`, `zitadel.{issuer,clientId,projectId,apiAudience}`, `github.{appId,webhookUrl}`, and owner-only `database.{mongodbUri,mongodbDatabase}`. Reject unknown keys, nested prototypes, control characters and invalid path/origin/identifier values. Initial preferences use existing trusted branding only; no upload/HTML/renderer-mode field. Fields absent from a patch retain their values. MongoDB URI remains write-only. Webhook URL is independent of public origin and must route to this instance's receiver; updating the GitHub App sender remains a separate provider operation.

`secretReplacements` has purpose keys `zitadelClientSecret`, `githubPrivateKey`, `githubWebhookSecret`. Each has `{action:"replace",value:<nonempty string>}`. Missing or empty input retains the stored credential; an empty `replace` is rejected. No null/delete/reveal action. Store the replacement only as a new encrypted envelope; never echo the value. Secret JSON reaches only the authorized server mutation; no URL/query, analytics, client persistence, form replay logs or audit payload.

Safe snapshots contain:

```json
{
  "state": "ready",
  "editRevision": 12,
  "activeVersion": 3,
  "candidateVersion": 4,
  "activation": {"state": "draft", "restartRequired": false},
  "settings": {"displayName": "Example Docs", "description": "Documentation", "defaultDocsFolder": "docs"},
  "secrets": {"githubPrivateKey": {"configured": true, "updatedAt": "2026-10-19T00:00:00Z"}},
  "checks": [],
  "impact": {"confirmationRequired": true, "categories": ["github"]}
}
```

This is an illustrative sanitized subset, not permission to omit supported safe fields. Owner metadata exposes only necessary stable binding identifiers to authorized administrators; anonymous status exposes none. The server computes origin-derived runtime callback `/api/auth/callback/zitadel`, candidate callback `/api/instance/auth/callback/zitadel`, and webhook `/api/webhooks/github`. Both callbacks must be registered before identity/origin activation. No user-supplied return URL outside the applicable approved local origin is accepted.

The form warns before unsaved navigation, has Save/Cancel and explicit Test/Activate actions, accessible validation/focus/loading states and clear saved-versus-active status. Save creates a durable candidate; Apply validates and activates it. Connection results invalidate after any draft edit. High-impact changes require an expiring server-created confirmation nonce bound to exact candidate, actor and impact; a generic Boolean alone cannot authorize a stale change.

## Security-sensitive changes

| Change | Required check / activation effect |
|---|---|
| Name/description/default docs folder | Strict validation; revision activation; existing catalogs unchanged; sessions retain valid epoch |
| Zitadel client secret | Actual candidate authentication, valid owner role, callback consistency; current sessions retained only if issuer/project/client identity boundary unchanged |
| Issuer/project/client/audience/public origin | Current owner authority plus candidate owner login/role and explicit replacement binding; increment security epoch, invalidate old sessions/role proofs, restart-free v2 adoption only after all gates pass |
| GitHub App ID/private key | Signing/App authentication/read-only permissions; installation/source revalidation for every affected catalog; gate serving on confirmed access loss and retain snapshots; fence old jobs/clients |
| Webhook secret | Explicit rotation confirmation; show sender action and exact five-minute maximum overlap deadline; receiver accepts current plus one previous only during that deadline; manual resync closes missed deliveries |
| Root keys/database/content/proxy/outbound policy | Read-only status plus protected operator/restart guidance; never browser-managed or falsely labelled active |

Failure to adopt the committed new bundle yields maintenance/not-ready, not a success banner. The next authorized read shows committed and adopted states separately. Rollback is a new activation with compatible session/binding/secret checks; unavailable or retired previous credentials require replacement rather than a silent downgrade.

## Errors and transport

400 `invalid_request`, `invalid_secret`, `invalid_provider_url`; 401 `setup_unauthorized` / `authentication_required`; 403 `instance_forbidden`, `csrf_rejected`, `origin_rejected`; 409 `revision_conflict`, `setup_closed`, `invalid_transition`, `owner_continuity_required`, `migration_conflict`; 413 `request_too_large`; 429 `rate_limited` with bounded Retry-After; 503 `storage_unavailable`, `configuration_unavailable`, `activation_pending`, `recovery_required`. Unknown exceptions map to a sanitized 503. Never distinguish bootstrap guesses by secret-specific error text. Public status/health may expose only generic not-ready on failures.

Provider-check failure is an authorized check result; transport/database failure can return 503. No request retries a non-idempotent transition under a new attempt identity. Audit/result IDs allow safe reconciliation after uncertain network outcomes. Setup cookies are cleared at successful readiness and checked as consumed server-side even if browser deletion fails.

## Existing interfaces preserved

Runtime `/api/auth`, webhook, health, catalog APIs, repository directory, reader, metadata, navigation, search and assets keep their existing contracts and roles. Add readiness/revision guards without exposing private data. Webhook bad signatures retain rejection before JSON parsing/durable operational admission. During closed readiness/activation gates, valid operational deliveries receive retryable not-ready; any setup delivery-verification challenge is authorized, short-lived, matches only bounded signed evidence and queues no ingestion. Durable receipts/deduplication are retained. Health stays 200 `{status:"ok"}` or 503 `{status:"not_ready"}` with no-store, now requiring current lifecycle/revision/adoption rather than any old worker heartbeat.

## Protected operator interface

Plan one local `scripts/instance-operator.mjs` with explicit `prepare`, `enroll`, `transfer`, `recover` and `rotate-key` operations. It is not a public reset API and is not implemented by this artifact. Restrict execution to trusted host operators; read credentials from protected files or non-echoing input, never command-line values; validate ignore rules before generating local files. Require explicit instance identity, expected revision and purpose, and emit only safe action IDs/result codes. An owner cannot be chosen using email or an unverified subject.

`prepare` verifies empty dedicated database/storage and creates/seals a one-time host intent. `enroll` for legacy and `transfer` require the stated roles, current owner where available and verified target login proof. `recover` creates a new out-of-band recovery epoch/authorization, forces maintenance and verifies target identity/role before CAS; it never clears initialized/consumed state. `rotate-key` re-encrypts retained envelopes under maintenance and preserves backup decryption. Each operation records safe audit metadata and leaves failed/interrupted operations recoverable. Live execution or credential provisioning still needs explicit scoped approval; planning does not authorize it.
