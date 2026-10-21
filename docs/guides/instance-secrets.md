# Provider secrets and root keys

Zitadel client secret, GitHub App private key and webhook signing secret use
AES-256-GCM envelopes in the instance control record. Instance, purpose, format,
key ID and credential version are authenticated. Independent 32-byte root keys
remain host-managed. Existing OAuth-token encryption format and key are preserved.

Settings shows configured/update metadata only. Explicit replacement creates a new
credential version; browser storage, audit, logs and responses must never retain
the value or ciphertext. Failed checks leave the previous active credentials intact.

Webhook rotation accepts the current secret plus one prior secret only before the
stored five-minute deadline. Update the sender separately through its approved
procedure and manually resynchronize missed deliveries. Rollback must not extend
the old deadline or revive a retired signing secret.

Root-key rotation is a protected host operation. Keep old keys for every surviving
backup set. Provision a matching, expiring `rotate-key` operator authority using the
approved host secret mechanism. Stop all application processes before running, using
the exact observed revision:

```powershell
node --env-file=.env.local scripts/instance-operator.mjs rotate-key --instance-id <INSTANCE_UUID> --revision <REVISION> --processes-stopped
```

The command generates and durably records a new independent key ID before it enters
maintenance, retaining every prior key. It re-encrypts the active, previous and
candidate bundles, including prior webhook envelopes; verifies decryption from the
persisted keyring and Mongo record; then reopens the gate. If interrupted, keep
processes stopped and resume with the same original `--revision`; the protected
rotation marker lets the operator finish without generating another key. A completed
database commit can also clear its marker on retry. The host keyring is bounded to
eight keys, so rotation stops at that limit until old backup sets can be retired
safely. Restart and verify decryption/health before declaring success. Do not remove
old keys merely because current traffic works. No operator command prints plaintext
credentials or root keys.
