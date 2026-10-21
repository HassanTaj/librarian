# Administer instance settings

Open `/instance/settings` after normal sign-in. Access requires an explicit active
issuer/subject/project binding and a currently verified `librarian-instance-admin`
role. Catalog administration and private-reader roles remain separate.

General, Authentication, GitHub Integration, Documentation, Security and System
contain the supported fields and safe status. Save creates a durable candidate;
active settings remain unchanged. Cancel discards unsaved form values without a
write. Blank secret fields retain credentials. Check Replace and supply a nonempty
value only when replacing a credential. No reveal or delete operation exists.

Every edit invalidates checks and owner proof. A stale edit returns a conflict:
refresh, review the current draft, and reapply the intended changes explicitly.
Test the saved candidate. Discovery is distinct from actual owner authentication;
installation and signed-delivery warnings must not be treated as successful checks.
The current owner verifies candidate identity before identity/origin activation.

Review impact and explicitly activate the exact candidate.
The administrator who saved the current draft must activate it within ten minutes;
otherwise save a fresh reviewed revision and repeat its checks. Owner-only changes
must therefore be saved by the current owner.

A pending response means
adoption has not yet been proved. Check health and refresh; maintenance is not
success. New admissions close while existing operations drain and catalog lease
fences advance. Catalog content revisions and source defaults remain unchanged.

A previous bundle is retained for at most 24 hours. Prepare rollback creates a new
draft requiring fresh checks and activation; it does not rewind versions, restore
sessions, or revive a retired webhook secret. See [secrets](instance-secrets.md).

Audit pages contain at most 50 safe events, with instance-bound signed cursors.
History is bounded to 10,000 events and 90 days. A full durable outbox denies
mutations until safely drained. Audit does not retain submitted values or secrets.
