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

Catalog IDs/slugs/config revisions, accounts, OAuth ciphertext, grants, installations,
queued jobs, durable receipts and snapshot pointers remain in place. Cutover drains
operations and advances lease fences before adoption. Record actual local preservation
and restart evidence; static code and fixtures do not prove a live upgrade.

Only roll back to an image proved compatible with the stored schema, envelopes,
OAuth format and configuration. An old Compose file or image tag alone is not a
working rollback. Use a consistent recovery set for incompatible downgrade, following
[recovery](instance-recovery.md). Production rollout and image publication require
separate explicit approval.
