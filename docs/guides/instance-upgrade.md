# Upgrade a legacy installation

Inventory the actual image, configuration, database, content volume and provider
callbacks before any approved live change. Back up database and content as one
quiesced recovery set and preserve separately protected root/session/OAuth keys.
Stop every unmodified v1 process before enabling v2 cutover; old binaries cannot
participate in the new instance admission barrier.

Keep complete legacy configuration available. An existing `instance` catalog blocks
the new page namespace and needs explicit owner resolution; never rename or shadow
it automatically. Catalogs named `setup` and `settings` retain their routes.

On isolated local DEV, deliberately prepare enrollment with existing host/legacy
inputs and a new ignored destination:

```powershell
node --env-file=.env.local scripts/instance-operator.mjs enroll --root .local/instance --origin https://docs.example.test --legacy-drained
```

Load the generated host inputs and start the upgraded application in legacy mode.
At `/instance/setup`, authenticate the intended owner with both `librarian-admin`
and `librarian-instance-admin`. Supply protected enrollment authority, review and
explicitly import. A keyed source digest rejects configuration changed after review.
Run the wizard's checks and explicitly finalize. Legacy settings stay authoritative
until committed cutover; no blank-value merge or automatic first-login ownership.

## Roll back before activation

Before enrollment, keep a protected copy of the exact legacy host file set and the
list of secret files those settings reference. Record the target database, its
instance ID, the pre-import control-document absence, and the newly created host
paths. Stop the v2 process before rollback.

Rollback is allowed only while the target control record still has the expected
instance ID, `lifecycle` `legacy_migrating` or `awaiting_owner`, no active bundle,
`initializedAt: null`, and `bootstrap.consumedAt: null`. Restore the protected
legacy environment file and only its referenced secret files. Remove only the
`instance_configuration` singleton matching `_id: "instance"` and that exact
`instanceId`; remove the marker only if it is still `phase: "sealed"` for the same
ID and was created by this enrollment. Remove other generated host files only when
the preflight inventory proves their exact paths were created for this attempt and
the restored legacy configuration does not reference them. Leave all catalogs,
accounts, sessions, authorizations, jobs, receipts, snapshots and content untouched.

After activation, do not remove the control record or restore legacy application
values. Use a validated v2 rollback or restore one consistent recovery set; an old
image or configuration file alone is not a safe downgrade.

Catalog IDs/slugs/config revisions, accounts, OAuth ciphertext, grants, installations,
queued jobs, durable receipts and snapshot pointers remain in place. Cutover drains
operations and advances lease fences before adoption. Record actual local preservation
and restart evidence; static code and fixtures do not prove a live upgrade.

Only roll back to an image proved compatible with the stored schema, envelopes,
OAuth format and configuration. An old Compose file or image tag alone is not a
working rollback. Use a consistent recovery set for incompatible downgrade, following
[recovery](instance-recovery.md). Production rollout and image publication require
separate explicit approval.
