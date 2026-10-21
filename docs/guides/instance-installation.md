# Install an instance locally

This guide describes local DEV. Production Swarm, Traefik, networks and scoped
secret provisioning remain in the infrastructure repository and need explicit approval.
Use the Node version allowed by `package.json` and the locked dependencies.

Create a dedicated disposable loopback Mongo database and a persistent content
directory outside `public`. Put database URI, independent Auth.js and OAuth token
keys in protected ignored files. Set the host variables described in
[configuration](instance-configuration.md). Never paste their contents into logs,
commands, issues or chat. Confirm `.local` is ignored before generating files.

With host prerequisites available in an ignored `.env.local`, prepare fresh storage:

```powershell
node --env-file=.env.local scripts/instance-operator.mjs prepare --root .local/instance --origin https://docs.example.test
```

Preparation accepts only empty dedicated storage and loopback Mongo. It writes
protected root/operator files and seals installation intent before creating the
singleton. Import the generated `.local/instance/instance.env` into the local server
environment, preserving the existing host prerequisites, then run `npm run dev`.
Use locally trusted HTTPS for secure setup cookies. Configure the local hostname
and certificate through your existing local proxy; this guide makes no proxy changes.

Open `/instance/setup`. Enter the protected bootstrap credential directly into the
authorized page, then follow Database, Zitadel, GitHub App, Preferences, Owner
verification and Review. Secrets persist only as encrypted server-side envelopes.
Register both displayed OIDC callback URLs before owner login. Assign the dedicated
project role `librarian-instance-admin` to the intended owner; the role alone does
not confer ownership. Explicitly confirm finalization and wait for adoption.

Missing installation or signed webhook delivery remains a warning until actually
observed. Register a first private catalog at `/repositories` using a separately
authorized `librarian-admin` account, synchronize it, and read it using its configured
reader role. Instance administration grants neither permission implicitly.

The [Compose example](examples/instance.compose.yml) is local-only packaging input.
Build `librarian:local` locally first. All referenced secret files must be provisioned
outside source control; the example supplies no credentials or provider accounts.
The container runs as UID/GID 1001. Give that identity access to the content volume
and protected marker, preserving private host-file permissions. Compose paths are
relative to the example file; the application URI file uses its `mongo` service,
while host preparation uses the separate loopback URI. A trusted HTTPS proxy is
still required in front of the loopback application port.
See [administration](instance-administration.md) for later changes.
