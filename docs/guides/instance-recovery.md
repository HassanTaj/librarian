# Recover an instance

Missing or mismatched marker, singleton, database, keyring or unsupported schema
fails to maintenance. Never delete those records to rerun fresh setup. Restore the
same installation identity, consumed-bootstrap state and protected root inputs.

Quiesce all web/worker processes. Back up database configuration, auth state, jobs,
receipts and audit together with immutable content/snapshot pointers. Store roots,
marker and retained encryption keys separately under protected backup policy.
Restore only a consistent set with a compatible image. Do not combine a database
from one point in time with unrelated content or discard needed backup keys.

Ownership transfer/recovery requires a current server-recorded candidate login proof
for the target identity and the dedicated project role. Email, a typed subject, an
operator credential alone, or a role alone is insufficient. Obtain the proof through
candidate owner verification while the current owner can authorize it; the protected
commands reject absent/expired proofs. If the previous owner cannot sign in, first
prepare a limited recovery authorization with all processes stopped:

```powershell
node --env-file=.env.local scripts/instance-operator.mjs recover --instance-id <INSTANCE_UUID> --revision <REVISION> --authorize --processes-stopped
```

This advances the protected recovery epoch and enters maintenance while retaining
initialized/consumed state. Start the upgraded application and open `/instance/setup`.
Enter the newly issued credential directly from its protected host file, then sign
in as the intended target. The page returns a short-lived verified proof ID and
control revision. Stop the application again and complete the operation below.
Provider failure denies target verification; it never permits a typed subject or
operator-only ownership claim.

Provision an expiring purpose-bound `transfer` or `recover` authority through the
approved host mechanism. Stop every application process before using the exact
observed revision and target proof nonce:

```powershell
node --env-file=.env.local scripts/instance-operator.mjs transfer --instance-id <INSTANCE_UUID> --revision <REVISION> --proof-id <PROOF_UUID> --processes-stopped
node --env-file=.env.local scripts/instance-operator.mjs recover --instance-id <INSTANCE_UUID> --revision <REVISION> --proof-id <PROOF_UUID> --processes-stopped
```

Transfer also requires current owner role verification. Both operations atomically
retire bindings, retain enrollment history and advance session security authority.
Recovery advances the protected marker/operator epoch before its database CAS;
interruption produces maintenance, never an open fresh-owner claim. Resume against
the actual revision rather than overwriting state. Restart, sign in, verify health,
all private delivery paths, synchronization and retained snapshots.

The 120-second reconciliation and 30-minute corpus-recovery bounds are targets until
measured. Live DEV recovery, compatible previous-image rollback, resource workload
and production deployment remain separate approval/evidence gates.
