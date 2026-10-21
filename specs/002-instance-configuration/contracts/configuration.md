# Configuration and Activation Contract

**Status**: Working-tree implementation is under validation. Host-input, migration and recovery acceptance remain open. Never put credential values in tracked examples.

## Host inputs and precedence

| Input | Mode / authority | Change behavior |
|---|---|---|
| Existing `MONGODB_URI_FILE`, `MONGODB_DATABASE` | All modes; dedicated database and scoped user | Host-only, restart; never stored as its own database credential |
| Proposed `INSTANCE_ID` | UUID, immutable installation identity | Host-provisioned; mismatch fails closed, never adopts another installation |
| Proposed `INSTANCE_SETUP_ORIGIN` | Exact protected setup/recovery HTTPS origin (loopback HTTP in isolated DEV); may reuse validated legacy AUTH_URL during legacy enrollment | Host-only initial origin trust, never derived from untrusted Host/forwarded headers or an anonymous draft; required before setup authorization |
| Proposed `INSTANCE_STATE_FILE` | Protected persistent marker containing instance ID, monotonic prepared/sealed/initialized phase and recovery epoch | Survives recreation; no public path or snapshot-contained marker; changes only through protected operator procedure |
| Proposed `INSTANCE_KEYRING_FILE` | Separate versioned 32-byte instance-secret keys and active key ID | Scoped Swarm secret in production; host-assisted migration/restart, keys never in MongoDB |
| Proposed `INSTANCE_OPERATOR_AUTH_FILE` | Random >=32-byte bootstrap/recovery credential, purpose, instance and expiry | Scoped Swarm secret; no default; one purpose/epoch, bootstrap permanently consumed on initialization |
| Existing `AUTH_SECRET_FILE`, `OAUTH_TOKEN_ENCRYPTION_KEY_FILE` | All runtime modes; session and legacy token protection | Host-only, distinct from instance keyring; preserve legacy OAuth format/key compatibility |
| Existing `CONTENT_ROOT`, `AUTH_TRUST_HOST`, `PUBLIC_CATALOG_APPROVALS_FILE` | Host storage/proxy/publication policy | Host-only, restart/revalidation; explicit publication approval still required |
| Proposed `INSTANCE_OUTBOUND_POLICY_FILE` | Exact approved origin/address exceptions for legitimate private providers | Host-only policy; strict public default if absent, no UI override; restart and connection revalidation |
| Existing `AUTH_URL`, Zitadel issuer/client/project/audience and provider secret files; `GITHUB_APP_ID` and App/webhook secret files | Legacy mode only until explicit migration | Complete validation retains working legacy operation; cannot silently override migrated settings |
| Active encrypted provider bundle in MongoDB | Ready/migrated instance | The sole eligible runtime settings source; no fallback to stale legacy provider files on database/key/schema failure |

In fresh mode, provider credentials are not prerequisites; host database/root key/session/storage/identity policy must be available before durable setup authorization. Public setup welcome can report generic prerequisite availability before those are ready. Missing marker or ambiguous nonempty data is maintenance; the application does not mint a fresh instance ID/credential at startup. Builds/imports require no runtime credentials and must not connect to providers or database.

Before readiness, fresh candidate publicOrigin must equal the operator-provisioned setup origin. Changing it requires protected host preparation, not trusting a value submitted to an anonymous form. After readiness, any new origin needs both callbacks registered and the same instance reachable there before candidate identity proof; routing/provider changes remain separately approved operator prerequisites. Do not claim an origin is live merely because it was saved. Mark pending operator/restart requirements explicitly if callback/cookie/proxy adoption cannot be completed safely at runtime.

Legacy mode is detected using validated complete existing configuration plus retained data before deciding fresh intent. Operator preparation must not reset existing legacy collections. Legacy databases acquire an explicit immutable host instance identity/marker during protected enrollment; this is not a reinstall. Host-managed values always win for host-only settings; active database values always win for eligible migrated settings. Candidate values never leak into active runtime. Conflicts are shown as safe field-name/provenance conflicts to the authorized owner; no silent merging or values in logs.

## Runtime modes

| Mode | Reading / catalog / worker behavior | Setup / Settings |
|---|---|---|
| Confirmed prepared fresh or configuring | No normal publication, private/public catalog delivery, catalog mutation, operational webhook admission or worker claims | Safe welcome and protected setup only; candidate login separate |
| Valid legacy | Existing v1 runtime and private boundaries remain | No open fresh enrollment; protected legacy enrollment and import only |
| Ready, gate open | One revision per operation; current auth/roles/worker fences | Settings requires binding plus role; setup closed |
| Gate closing | Finish/abort bounded existing requests; stop new sensitive admission and workers; fence catalogs | Authorized status/reconciliation available; edit races rejected |
| Maintenance / storage/key/schema mismatch | Affected security-sensitive work fails closed, existing snapshots retained | Safe not-ready status and protected recovery guidance; no public reset |

## Activation protocol

1. Save a strictly validated encrypted candidate with CAS using exact edit/candidate version. Every edit invalidates prior checks/proofs. Active remains unchanged.
2. Complete required checks no older than 10 minutes; reverify current actor role and continuity identity. Create a single-use impact nonce for this actor/candidate. Sensitive issuer/project/client/audience/origin replacement needs the current owner and candidate owner proof. App changes verify each affected installation; confirmed access loss cannot keep serving an affected catalog.
3. CAS an exclusive activation ID and close the admission gate. New requests/jobs cannot acquire old pins. Keep active bundle intact; report pending, never falsely active. Reconciler ownership/deadline uses the activation token, not a process-local lock.
4. Drain at most 64 request pins within 30 seconds or abort them. Gate configuration-sensitive callbacks/writes by security epoch. Stop local workers and CAS all catalog worker fences/runtime revisions using the activation ID. Old publication/cleanup/blob effects must fail the existing catalog lease fence or revision predicate. Record/recheck the complete bounded catalog fencing set before commit. Concurrent catalog creates/mutations are gated; late old admissions cannot create an unfenced new catalog. Source mappings/jobs/receipts persist.
5. Within 120 seconds, CAS active/previous bundles, new owner binding where required, security epoch, audit event and ready state together. Keep the gate closed until the committed revision is validated locally and clients/worker are constructed from it. No sensitive admission can continue using an old epoch after commit. Expired pins cannot be renewed or authorize late writes.
6. Reopen only for the committed schema/revision after successful adoption; a process checks current authority at every admission. Health requires current revision and relevant local worker adoption, never an old heartbeat. Success response follows adoption; a durable commit followed by failed adoption yields pending/maintenance and resumes the same operation.

On precommit timeout, do not swap active bundle; keep maintenance/closed gate until all already-fenced catalogs are reconciled to the old active revision using a new monotonic activation token, then reopen. On postcommit failure, reconcile new active or perform an explicit validated rollback activation; never decrement revisions or restore initial setup. Reject stale reconciler CAS predicates and delayed writes. Crashes at each step and each catalog iteration need integration tests on standalone MongoDB.

The global singleton CAS alone is not a transaction with catalog documents. Safety depends on the staged admission barrier plus complete catalog fencing and existing publication CAS predicates. Unmodified v1 binaries must be drained before migration commit; an old image is not a safe overlapping participant. Migration docs must show the downtime/recovery precondition explicitly. A prior image may be used only after its configuration/schema/ciphertext compatibility is proven under maintenance with a consistent recovery set.

## Restart and recovery

Eligible fields in the API contract are designed for coherent runtime activation with v2-aware processes. Host-only inputs require controlled operator changes and restart; a saved draft is never labelled applied by that act. Root key rotation preserves all retained envelope versions and separately protected backup keys. Webhook rotation retains one old receiver secret for at most five minutes and requires a separate sender operation; rejection after retirement is enforced even on rollback.

Before recovery, quiesce writes and preserve a consistent database plus content set: instance control/envelopes/bindings/audit/sessions, existing catalogs/jobs/receipts/accounts/roles/operational records and corresponding immutable snapshots. Keep host keys/instance marker and previous image/config separately protected. After restore, advance the host recovery epoch and reconcile it under protected operator authority before serving, invalidating restored setup sessions, unsafe runtime sessions, OIDC proofs and old admission pins. Keep initialized/bootstrap-consumed state. Validate all private delivery paths, token decryption, catalog/job recovery and health before opening the gate. No backup contents, private documents or credentials enter the planning evidence.
