# Configuration sources

| Host-managed input | Purpose |
| --- | --- |
| `MONGODB_URI_FILE`, `MONGODB_DATABASE` | Dedicated storage; host-only database credentials |
| `AUTH_SECRET_FILE`, `OAUTH_TOKEN_ENCRYPTION_KEY_FILE` | Independent session and existing OAuth-token protection |
| `CONTENT_ROOT`, `PUBLIC_CATALOG_APPROVALS_FILE` | Persistent snapshots and reviewed publication policy |
| `INSTANCE_ID`, `INSTANCE_SETUP_ORIGIN` | Immutable UUID and exact trusted setup origin |
| `INSTANCE_STATE_FILE` | Persistent protected installation/recovery marker |
| `INSTANCE_KEYRING_FILE` | Independent provider-encryption keys; never stored in Mongo |
| `INSTANCE_OPERATOR_AUTH_FILE` | Expiring purpose-bound protected operator authority |
| `INSTANCE_OUTBOUND_POLICY_FILE` | Optional exact origin/address exceptions; no UI override |
| `AUTH_TRUST_HOST` | Existing proxy trust setting |

Host values and paths are not returned to the browser. Protect root files outside
content/public directories. Changes to database, root keys, storage, proxy and
outbound policy require a protected operator, restart and revalidation.

The active instance bundle supplies display name, description, default docs folder,
public origin, Zitadel identifiers and eligible encrypted provider credentials.
Defaults initialize future catalog drafts only. They never rewrite existing paths,
reader roles, visibility or publication approval.

Complete validated legacy environment/provider files remain authoritative until
deliberate [migration](instance-upgrade.md). Once migrated, missing storage, keys,
marker or supported schema means maintenance; stale provider files are not fallback.
Missing state is never permission to claim a fresh installation.

Provider traffic uses bounded DNS/TLS transport. Public destinations are the default;
private exceptions require an exact host-approved origin/address set. Redirects,
metadata/private-address rebinding and browser-supplied policy exceptions are denied.
Build/import does not require credentials or connect to providers.
