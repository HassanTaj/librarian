# Initial local DEV setup

This guide prepares a Windows developer checkout for Librarian. Provider consoles
and configuration fields were checked on 2026-10-12. Recheck them when their UI changes.
The application is still under implementation; credentials alone do not enable login or ingestion.
See the [current validation status](https://github.com/HassanTaj/librarian/blob/main/specs/001-librarian-v1-portal/quickstart.md).

## 1. Keep configuration and credentials separate

Run commands from the repository root. Use a Node version allowed by `package.json`
(Node 22.18 or newer within the supported 22.x line, or 24.11 or newer within 24.x).
The coverage instrumenter's Babel dependency requires this minimum; Node 22.17 is insufficient.
Install the pinned application dependencies with `npm ci` when setting up a new checkout.
Do not run source documentation repositories' scripts or install their dependencies.

- `.env.local`: server URLs, IDs, database name, and secret-file paths.
- `.local/secrets/`: raw secret values in UTF-8 files, without surrounding quotes.
- `.local/content/`: runtime snapshots, outside `public`.
- `lib/config.ts`: the loader and validator; never hard-code credentials here.

[Next.js loads `.env.local`](https://nextjs.org/docs/app/guides/environment-variables)
and gives it precedence over `.env`. Keep a single authoritative local configuration.
Standalone Node commands need to load the environment explicitly. Existing shell
environment variables can also override file values. Never use `NEXT_PUBLIC_` for credentials.

```powershell
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
New-Item -ItemType Directory -Force .local/secrets, .local/content | Out-Null
git check-ignore .env.local .local/secrets/auth-secret .local/content
```

All three paths must be ignored before storing credentials. Do not overwrite an existing
environment file, expose secret contents in logs/chat, or commit them. Ignored files still
need private local storage. Production uses scoped Swarm secrets, not these DEV files.

## 2. Map every configuration value

Copy the names from [`.env.example`](https://github.com/HassanTaj/librarian/blob/main/.env.example). The runtime loader requires every
setting except the optional public approval manifest path. Application entry points read the
validated configuration at runtime; production build does not need provider credentials.

| Setting | Source or local DEV value |
| --- | --- |
| `AUTH_URL` | `http://localhost:3000`; change the port and provider redirects together if necessary |
| `AUTH_TRUST_HOST` | `true` for this controlled local origin; review trusted-proxy behavior for deployment |
| `AUTH_SECRET_FILE` | `.local/secrets/auth-secret`, generated below |
| `AUTH_ZITADEL_ID` | OIDC **Client ID** in the Zitadel application, not its internal Application ID |
| `AUTH_ZITADEL_SECRET_FILE` | `.local/secrets/zitadel-client-secret`, issued by a secret-authenticated Zitadel client |
| `AUTH_ZITADEL_ISSUER` | HTTPS instance origin, without `/ui/console` or another path |
| `ZITADEL_PROJECT_ID` | Project ID of the project containing the Web application |
| `ZITADEL_API_AUDIENCE` | `urn:zitadel:iam:org:project:id:zitadel:aud`, the audience-request scope for Zitadel's own APIs |
| `MONGODB_DATABASE` | `librarian_dev` for the separate DEV database |
| `MONGODB_URI_FILE` | Path to the credentialed URI file; use `.local/secrets/mongodb-dev-uri` for the provisioned DEV user |
| `GITHUB_APP_ID` | Numeric **App ID** from GitHub App settings, not its Client ID |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Path to the downloaded RSA PEM; keep its header, footer, and line breaks |
| `GITHUB_WEBHOOK_SECRET_FILE` | `.local/secrets/github-webhook-secret`, generated below |
| `OAUTH_TOKEN_ENCRYPTION_KEY_FILE` | `.local/secrets/oauth-token-encryption-key`, canonical base64 of exactly 32 random bytes |
| `CONTENT_ROOT` | `.local/content`, which must already exist outside `public` |
| `PUBLIC_CATALOG_APPROVALS_FILE` | Optional path to the read-only owner approval manifest; keep it outside `public` and `CONTENT_ROOT` |

Relative file paths are resolved from the working directory. Secret files must be nonempty
and at most 64 KiB. Auth and webhook secrets must each contain at least 32 UTF-8 bytes.
The optional approval manifest is also limited to 64 KiB; when configured, the loader requires
it to exist outside `public` and `CONTENT_ROOT`. Without it, public catalog registration fails
closed while private catalogs remain available. The loader does not connect to any provider.
Make the manifest readable by the Next.js Node server. In v1, Next instrumentation starts the
sync worker inside that same application process and container, so restarting the server process
restarts both the API and worker after changing `PUBLIC_CATALOG_APPROVALS_FILE`. The worker
captures the configured path at startup and reads the manifest contents during approval checks.
In development, it starts only when `LIBRARIAN_WORKER_ENABLED=1`; in production, it starts unless
`LIBRARIAN_WORKER_ENABLED=0`.

### Owner-approved public catalogs

Public visibility requires owner approval for the exact source scope and reviewed content. The
GitHub App installation grants read access; it does not approve publication. Follow the
[Public catalog approval guide](public-catalog-approval.md) before creating a public catalog,
switching a private catalog to Public, or changing a public catalog's source, branch, docs folder,
or slug. The guide covers the manifest, matching rules, operator steps, and recovery from
`public_approval_required`.

## 3. Generate application-owned secrets

This PowerShell command writes three independent keys without printing their values or
replacing existing files. Run it after creating the ignored secrets directory:

```powershell
@'
const fs = require('node:fs');
const crypto = require('node:crypto');
for (const name of ['auth-secret', 'github-webhook-secret', 'oauth-token-encryption-key']) {
  const path = `.local/secrets/${name}`;
  if (!fs.existsSync(path)) {
    fs.writeFileSync(path, crypto.randomBytes(32).toString('base64'), { flag: 'wx' });
  }
}
'@ | node
```

Keep the encryption key stable once tokens are stored. Rotation then requires an explicit
token migration or reauthentication strategy. A random locally generated value is not a
replacement for a provider-issued Zitadel client secret.

## 4. Configure Zitadel and obtain its client secret

PKCE and client authentication are separate settings. A public client configured with
authentication method **None / PKCE** has no client secret; the missing secret is expected.
Librarian's current configuration contract uses a confidential server-side Web client.
[Zitadel documents the available authentication methods](https://zitadel.com/docs/apis/openidoauth/authn-methods).

1. In the Zitadel Console, select the intended organization, open **Projects**, and select
   the DEV project. Copy its **Project ID** to `ZITADEL_PROJECT_ID`.
2. Open the dedicated Librarian DEV application. Confirm its application type is **Web**.
   If it is a Native or User Agent application, create a separate Web application in the
   same project; preserve any existing client that other applications use.
3. In its OIDC configuration, choose **Basic / client_secret_basic** client authentication
   and save. Some console versions label the creation preset **Code**. Use Authorization
   Code; the application must still send a PKCE challenge when login is implemented.
4. Copy the actual **Client ID** into `AUTH_ZITADEL_ID`. IDs can include `@`.
5. Copy the generated secret into `.local/secrets/zitadel-client-secret`. If it is not
   shown, use the application's **Generate/Regenerate Client Secret** control. Regeneration
   invalidates an old secret, so use a dedicated DEV client and preserve shared clients.
6. Set the exact redirect URI to `http://localhost:3000/api/auth/callback/zitadel` and
   enable **Development Mode** for this client's local HTTP redirect. Do not use wildcards.
7. Set `AUTH_ZITADEL_ISSUER` to the HTTPS instance origin. The discovery document at
   `<issuer>/.well-known/openid-configuration` identifies the expected issuer.

The console can change an authentication method but cannot change an application's type.
See [Zitadel application settings](https://zitadel.com/docs/guides/manage/console/applications-overview)
and [the Auth.js Zitadel provider](https://authjs.dev/reference/core/providers/zitadel).
Federated logout is not implemented yet; its final post-logout URI must match that implementation.

Set `ZITADEL_API_AUDIENCE=urn:zitadel:iam:org:project:id:zitadel:aud`. This field stores the
documented audience-request scope, to be included in the OAuth scope request when identity
integration is implemented. It is a fixed string; do not replace `zitadel` with the Librarian
Project ID. It is distinct from the token's raw `aud` claim, which identifies the API project
added by this scope. Live token issuance and API compatibility remain unverified. The planned role refresh uses
the logged-in user's token and current own assignments; do not provision an administrator
service account merely to fill this setting.
[Zitadel API audience and Auth API guidance](https://zitadel.com/docs/guides/integrate/zitadel-apis/access-zitadel-apis).

Project role keys include `librarian-admin` for catalog administration and explicitly chosen
reader roles for private repositories. Grant readers their repository role separately;
administrator status does not grant private reading. Repository role/visibility/branch/folder
settings belong to the future catalog, not new environment variables. Freshness and role-removal
behavior still require live DEV verification.

## 5. Configure the GitHub App

Use a dedicated DEV App or a suitable existing one. Open **Settings → Developer settings →
GitHub Apps** under the owning personal account or organization. Create an App with a unique
name and your project/account URL as its homepage. Set **Contents: Read-only** repository
permission, leave other optional permissions unset, and leave user OAuth authorization and
device flow disabled. Choose account visibility that permits installation on your selected
repository owners. Keep webhooks inactive until a reachable handler exists.
[GitHub registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

- Copy the numeric **App ID** from App settings to `GITHUB_APP_ID`.
- Under **Credentials → Key pairs → New key**, download the RSA PEM and move it to an
  ignored file. Older consoles show **Generate a private key**. Set
  `GITHUB_APP_PRIVATE_KEY_FILE` to that exact relative path, including any existing filename.
  GitHub retains only the public key; an existing private key must come from your secure storage.
  [GitHub private-key guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).
- Open **Install App**, choose the repository owner, and use **Only select repositories**.
  Record the source owner/name, branch and docs folder for later catalog setup.
  [GitHub installation guide](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

Later, enable **Push** events, keep SSL verification enabled, and paste the locally generated
webhook secret into the App's webhook-secret field. The planned route is `/api/webhooks/github`;
verify it exists before configuring delivery. GitHub cannot reach your Windows `localhost`.
A reachable DEV URL or approved forwarding arrangement is required; do not fabricate one.

## 6. Use the hosted MongoDB with a separate DEV user

An existing database is not an application credential. Create a user with `readWrite` only
on `librarian_dev`; never put administrator credentials in the application's URI.
The user authenticates against the database where it was created.

An authorized operator can inspect the actual server without printing its environment:

```bash
docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}'
docker service inspect --format '{{json .Endpoint.Ports}}' <mongo-service>
```

For standalone Docker rather than Swarm, inspect `.NetworkSettings.Ports` instead.
Use the real container name, administrator username and authentication database:

```bash
docker exec -it <mongo-container> mongosh --username <admin-user> --authenticationDatabase admin
```

Preserve required TLS options. Enter the administrator password privately at the prompt.
Inside `mongosh`, inspect first; create only if absent and explicitly authorized:

```javascript
const dev = db.getSiblingDB('librarian_dev');
dev.getUser('librarian_dev', { showCredentials: false });
// If the result was null and provisioning is authorized:
dev.createUser({
  user: 'librarian_dev',
  pwd: passwordPrompt(),
  roles: [{ role: 'readWrite', db: 'librarian_dev' }]
});
```

Existing user passwords cannot be recovered as plaintext from MongoDB. Use approved secret
storage; do not reset a shared user's password to make setup work. Protect administrative
transport as required by the deployment.
[MongoDB user provisioning](https://www.mongodb.com/docs/manual/reference/method/db.createuser/).

For a standalone server with an existing host port, forward it privately over SSH:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:27019:127.0.0.1:<published-mongo-port> <ssh-alias>
```

Leave that terminal open while the application connects. This does not require opening
a new firewall port or updating a service. A URI file for this standalone tunnel has this shape:

```text
mongodb://librarian_dev:<percent-encoded-password>@127.0.0.1:27019/librarian_dev?authSource=librarian_dev
```

Percent-encode the credential components and match the URI database to `MONGODB_DATABASE`.
Retain existing TLS/replica-set options when applicable; a single tunnel does not automatically
make replica-set discovery or certificate hostname verification work.
[MongoDB connection strings](https://www.mongodb.com/docs/manual/reference/connection-string/).

### Provisioned development checkout

On 2026-10-12, the operator authorized provisioning through `ssh contabo`. Inspection
confirmed an existing standalone server and `librarian_dev` database. The new `librarian_dev`
user has exactly `readWrite` on that database. Windows connectivity, authenticated role scope,
and denial of admin collection access passed through a temporary SSH tunnel. No application
data was written during verification. The temporary tunnel was closed.

The credential is stored only in this checkout's ignored files:

- `.local/secrets/mongodb-dev-password`: generated DEV password.
- `.local/secrets/mongodb-dev-uri`: credentialed URI for local port 27019.

The old `mongodb-uri` file was preserved. The local environment now points to the new URI.
Another checkout must obtain its own approved credential; these files are not distributed in Git.
For this inspected host, run:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:27019:127.0.0.1:27017 contabo
```

Revalidate service ports/topology if the server changes. Database user removal is the rollback
for this provisioning, requires explicit approval, and must follow a check for active consumers.
Do not delete the database or its data as a rollback. Infrastructure descriptors remain owned
by the infrastructure repository.

## 7. Validate without exposing secrets

Check that environment and credential files remain ignored:

```powershell
git check-ignore .env.local .local/secrets/mongodb-dev-uri .local/secrets/zitadel-client-secret
git status --short
```

After dependencies are installed, this optional format check loads the DEV environment
and prints only setting names on validation errors. It does not verify provider connectivity
or verify token audience or API permissions:

```powershell
@'
try {
  const { loadConfig } = await import('./lib/config.ts');
  await loadConfig();
  console.log('Configuration format accepted; provider integration is not verified.');
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Invalid server configuration:')
    ? error.message : 'Configuration validation failed.');
  process.exitCode = 1;
}
'@ | node --env-file=.env.local --experimental-strip-types --input-type=module
```

Missing secret: check the path and UTF-8 file without printing contents. Invalid Zitadel
secret: confirm the application's authentication method and whether its secret was regenerated.
Generic validation failure: confirm `npm ci` installed the root dependencies; an older
dependency tree can be missing `zod` or `mongodb`. Do not install arbitrary versions individually.
MongoDB connection refused: open the tunnel and revalidate the published port. Authentication
failure: verify the user, password and `authSource` privately. Do not disable authorization/TLS
checks or use root credentials as a workaround.

Start the scaffold with `npm run dev`. Run the actual applicable test/type/lint/build scripts
when implementing features; the scaffold loading is not login or ingestion acceptance evidence.
Automated integration tests must use disposable local MongoDB, never the shared VPS database.
Live DEV checks, performance, recovery, full coverage and deployment remain separate gates.

For an LLM handoff, report only ready/pending setting names and nonsecret connectivity facts.
Do not return environment-file contents, private keys, passwords, connection strings, tokens,
or private document bodies. Changes to shared identity clients, users, infrastructure or
deployment need explicit authorization beyond a read-only setup review.
