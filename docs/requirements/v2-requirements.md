# Codex Mission: Librarian First-Run Setup Wizard and Instance Settings Management

## Role

You are acting as a Principal Software Engineer, Application Security Architect, and Senior Full-Stack Engineer.

Your task is to extend the existing **Librarian** application with a secure, production-quality, first-run setup wizard and a persistent instance settings management system.

**Repository:** `HassanTaj/librarian`

This is an open-source, self-hostable documentation platform using Fumadocs, MongoDB, Zitadel authentication, GitHub App integration, and repository-based documentation synchronization.

The objective is to make Librarian easier for third parties to deploy and configure without editing numerous environment variables, Docker secrets, or configuration files.

You must inspect the current implementation before changing anything.

This is a feature implementation request, not merely an architecture proposal.

---

# 1. Existing Architecture

The application currently uses technologies including:

- Next.js App Router
- React and TypeScript
- Fumadocs and MDX
- MongoDB
- Auth.js / NextAuth
- Zitadel as an OIDC identity provider
- GitHub App authentication and webhooks
- Repository-based documentation synchronization
- MongoDB-backed synchronization jobs
- Server-side configuration validation with Zod
- Docker and self-hosted deployment patterns
- Existing unit, integration, container, and Playwright testing infrastructure

The application is designed to ingest documentation from designated repository paths, such as `docs/`, rather than clone and publish entire source repositories.

Preserve this behavior.

## Existing configuration implementation

Inspect these files first:

- `lib/config.ts`
- `auth.ts`
- `lib/mongo.ts`
- `.env.example`
- `package.json`
- The existing GitHub integration code
- The existing sync job and worker implementation
- The catalog and authorization code
- Current deployment manifests
- Existing tests and setup documentation

The current configuration includes settings such as:

- `AUTH_URL`
- `AUTH_TRUST_HOST`
- `AUTH_ZITADEL_ID`
- `AUTH_ZITADEL_ISSUER`
- `ZITADEL_PROJECT_ID`
- `ZITADEL_API_AUDIENCE`
- `MONGODB_DATABASE`
- `MONGODB_URI_FILE`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY_FILE`
- `GITHUB_WEBHOOK_SECRET_FILE`
- `AUTH_SECRET_FILE`
- `AUTH_ZITADEL_SECRET_FILE`
- `OAUTH_TOKEN_ENCRYPTION_KEY_FILE`
- `CONTENT_ROOT`
- `PUBLIC_CATALOG_APPROVALS_FILE`

Currently, `loadConfig()` validates a largely complete configuration before normal application functionality can start.

Introduce a controlled bootstrap/configuration lifecycle that supports an unconfigured installation.

Do not simply remove validation.

The existing security boundaries, authentication behavior, synchronization protections, and configuration validation must be preserved or strengthened.

---

# 2. Primary Objectives

Implement two integrated features.

## Feature A — First-Run Setup Wizard

When Librarian is first deployed without completed instance configuration, authorized installation operators should be guided through a setup process.

The wizard should:

1. Detect an unconfigured installation.
2. Require a secure bootstrap authorization mechanism.
3. Configure the MongoDB-backed instance.
4. Configure Zitadel authentication.
5. Configure the GitHub App.
6. Configure instance-level preferences.
7. Validate integrations before finalization.
8. Establish the first instance administrator.
9. Mark the instance as initialized.
10. Transition to normal Librarian operation.

After successful initialization, the setup wizard must not be publicly accessible.

## Feature B — Persistent Settings Dashboard

Create a new administrator-only settings section where configuration can be reviewed and modified after installation.

Settings must persist across:

- Application restarts
- Container recreation
- Redeployments
- Image upgrades
- Normal application updates

Configuration changes must not require editing source code or rebuilding the application image.

Some fundamental host-managed settings may still require operator-level changes or restarts.

Make those limitations explicit in the interface.

---

# 3. Mandatory Preliminary Audit

Before implementation:

- Map the current application initialization process.
- Trace every use of `loadConfig()`.
- Identify module-level configuration dependencies.
- Identify how MongoDB connections are initialized.
- Trace authentication initialization and callback handling.
- Inspect webhook signature validation.
- Inspect background worker configuration loading.
- Review GitHub App token generation and permissions.
- Review the current authorization model.
- Examine existing environment-variable conventions.
- Identify mutable configuration currently assumed to be immutable.
- Identify settings that must remain host-managed.
- Check existing secret encryption for OAuth tokens.
- Inspect the deployment and automated tests.

Produce a concise architecture assessment identifying necessary changes.

Then implement the solution.

Avoid replacing existing working systems unnecessarily.

---

# 4. Bootstrap Configuration Model

Separate configuration into three categories.

## 4.1 Bootstrap configuration

These settings exist before the application can access its database.

Examples:

- MongoDB connection URI
- MongoDB database name
- Instance secret-encryption master key or KEK
- Bootstrap operator credential or one-time token
- Persistent content storage location
- Other irreducible infrastructure paths

Prefer existing Docker secrets and file-based configuration conventions.

Keep bootstrap requirements minimal.

Do not embed deployment credentials in frontend code.

Never commit credentials into the repository.

The application must be able to display a secure setup experience when its optional integrations have not yet been configured.

## 4.2 Instance configuration

Store eligible settings in MongoDB.

Examples:

- Instance display name
- Site description
- Public application URL
- Zitadel issuer
- Zitadel OIDC client ID
- Zitadel project ID
- Zitadel API audience
- GitHub App ID
- GitHub webhook configuration metadata
- Default documentation source path
- Branding preferences
- Supported synchronization preferences
- Selected security and access preferences

Only persist configuration supported by the actual application.

Do not introduce unused configuration fields for speculative features.

## 4.3 Sensitive configuration

Examples:

- Zitadel client secret
- GitHub App private key
- GitHub webhook secret
- Other provider credentials

Secrets stored in MongoDB must be encrypted using authenticated encryption.

Use a standard authenticated algorithm, such as AES-256-GCM, with a carefully designed key-management boundary.

The encryption key must remain outside MongoDB, preferably in a Docker secret or host-managed secret file.

Do not implement custom cryptographic algorithms.

Preserve the existing OAuth token encryption boundary.

If using a shared key-management component, clearly document the implications of key reuse and apply appropriate separation.

Do not expose decrypted secrets to the browser.

Settings APIs should return only values such as:

- Configured
- Missing
- Last updated
- Validation status
- Masked identifier where appropriate

Never return actual client secrets or private key contents after storage.

---

# 5. Instance Configuration Service

Create a centralized configuration service.

Possible conceptual modules:

- `lib/config/bootstrap.ts`
- `lib/config/instance.ts`
- `lib/config/secrets.ts`
- `lib/config/validation.ts`
- `lib/config/configuration-service.ts`

These filenames are suggestions.

Follow existing repository conventions.

The service must support:

- Reading instance configuration
- Validating configuration
- Applying default values
- Updating configuration
- Managing encrypted secrets
- Reporting integration status
- Versioning configuration
- Checking initialization state
- Auditing configuration changes

Avoid spreading direct MongoDB configuration queries throughout route handlers.

Use typed schemas and explicit configuration contracts.

## Configuration schema

Define a strict validated schema.

Include:

- Configuration schema version
- Instance identifier
- Initialization state
- Configuration revision
- Relevant integration settings
- Created and updated timestamps
- Secret metadata
- Non-sensitive display preferences

Support forward-compatible migrations.

Do not silently overwrite newer schemas or unknown settings.

## Configuration updates

Use atomic, revision-aware updates.

Two administrators editing settings simultaneously must not silently overwrite each other's changes.

Use optimistic concurrency or another appropriate mechanism.

On a conflict:

- Reject the stale update.
- Return a safe error.
- Ask the user to refresh.

---

# 6. Setup Lifecycle

Implement an explicit setup state machine.

Suggested states:

- `uninitialized`
- `configuring`
- `awaiting_admin_verification`
- `ready`
- `maintenance_required`

Avoid excessive state complexity where possible.

The final design should describe allowed transitions.

## Initial state

When no valid instance configuration exists:

- The application must not crash merely because Zitadel or GitHub credentials are absent.
- Public documentation publishing and privileged operations must remain disabled by default.
- The setup interface must not expose secrets or database internals.
- Background synchronization must not start.
- GitHub webhook processing must not accept operational events.
- Normal protected application areas must not become publicly accessible.

## Setup authorization

The first-run wizard must not be an unauthenticated administrative interface.

Implement a secure bootstrap credential mechanism.

Requirements:

- A high-entropy bootstrap token generated or supplied out of band.
- The token is delivered through a protected startup channel or secret file.
- Never print the token to public application logs.
- Never embed it in public HTML or JavaScript.
- Protect against repeated guessing.
- Avoid token values in URLs.
- Store only a verifier where possible.
- Enforce setup-specific session expiry.
- Use secure, HttpOnly session cookies.
- Apply CSRF protection.
- Enforce same-origin checks.
- Rate-limit authentication attempts.
- Invalidate bootstrap access after successful setup.
- Prevent setup-token replay.

For an open-source deployment, document how operators retrieve the bootstrap credential securely from their deployment environment.

Do not depend on a fixed default username or password.

## Multiple replicas

Consider concurrent startup and setup requests.

Ensure that two application replicas cannot initialize the same instance independently.

Use MongoDB atomic operations, unique records, and revision checks as appropriate.

---

# 7. Setup Wizard UI

Create a clean, professional, responsive setup interface.

Suggested route:

`/setup`

Use the project's current UI system, components, conventions, and design language.

Do not introduce another UI framework without justification.

## Step 1 — Welcome

Explain what Librarian does.

Display:

- Application name
- Version
- Setup status
- Installation requirements
- Bootstrap authorization

Show whether the required host-managed prerequisites are available.

Never expose secret values.

## Step 2 — Database

Explain MongoDB requirements.

If MongoDB is already connected through host bootstrap configuration, display:

- Connected status
- Database name
- Appropriate sanitized connection details
- Test result

Do not expose credentials.

If database connection information is missing, provide a secure operator-assisted setup path.

A database credential entered through the browser must never be persisted as plaintext in MongoDB or silently written into an unsafe application directory.

If the deployment cannot securely persist bootstrap database credentials from the wizard, explicitly require the operator to set the MongoDB secret on the host.

Then offer a **Retry Connection** action.

Do not pretend that MongoDB credentials are fully database-managed.

## Step 3 — Zitadel Authentication

Provide fields for:

- Zitadel issuer URL
- OIDC client ID
- OIDC client secret
- Project ID
- Required API audience or scope
- Redirect/callback URL display

Explain that Zitadel must be configured separately as an identity provider.

Display the exact callback URL derived from the configured public origin.

Provide helpful configuration instructions.

Validate:

- Issuer URL format
- OIDC discovery availability
- Issuer identity consistency
- Required OAuth endpoints
- Client configuration
- Expected token authentication behavior
- Required application scopes

Preserve the existing Auth.js security configuration:

- PKCE
- State
- Nonce
- Database sessions
- Secure cookies
- Existing token protection

Do not weaken authentication to simplify setup.

Provide a safe test-authentication workflow.

Never mark Zitadel as fully verified merely because its discovery endpoint responds.

## Step 4 — GitHub App Integration

Provide fields for:

- GitHub App ID
- GitHub App private key
- Webhook secret
- App slug or relevant metadata if required

Display the expected webhook URL.

Provide instructions explaining how an operator creates and installs a GitHub App.

Validate:

- App ID format
- RSA private key format
- Signing capabilities
- GitHub authentication
- Required API permissions
- Webhook endpoint configuration
- Installation access where possible

Preserve the existing GitHub permission boundaries.

Do not request broad repository write permissions if read-only ingestion is sufficient.

Do not generate fake success states.

Distinguish:

- Credentials structurally valid
- Authentication successful
- GitHub App reachable
- Installation detected
- Webhook delivery verified

The wizard must communicate which checks have actually passed.

## Step 5 — Instance Preferences

Provide only useful configuration options.

Suggested initial settings:

- Instance display name
- Public application URL
- Site description
- Default documentation directory, such as `docs`
- Supported MDX rendering preferences
- Branding options supported by existing UI
- Relevant catalog visibility defaults

Do not expose private infrastructure settings unnecessarily.

Validate all fields.

## Step 6 — Administrator Ownership

Establish the first trusted administrator.

Do not automatically grant administrator permissions to the first random user who signs in.

Use the bootstrap-authorized setup flow to establish the first administrator.

Require successful authentication through the configured Zitadel provider.

Bind the verified Zitadel issuer and subject to an instance-owner record.

Account identity must use stable provider identifiers, not email alone.

Protect against:

- Account takeover during setup
- Race conditions
- Unverified user identities
- Repeated owner registration
- Provider substitution
- Privilege escalation

The implementation must be compatible with the application's existing user and authorization model.

## Step 7 — Review and Finalize

Show a complete non-sensitive configuration summary.

Include:

- Database connection status
- Authentication status
- Administrator verification status
- GitHub integration status
- Instance preferences
- Outstanding warnings

Require explicit confirmation before initialization.

On finalization:

1. Revalidate required configuration.
2. Confirm ownership.
3. Atomically transition the instance to ready.
4. Invalidate bootstrap authorization.
5. Initialize or enable normal runtime components.
6. Redirect to the appropriate authenticated application area.

A failed finalization must leave the application in a recoverable state.

Do not claim success until the committed configuration and startup checks succeed.

---

# 8. Admin Settings Dashboard

Create a new route:

`/settings`

This route must require authentication and explicit instance-administrator authorization.

Do not rely on the visibility of navigation links for access control.

Protect all server endpoints independently.

Suggested settings navigation:

### General

- Instance name
- Site description
- Public URL
- Supported branding fields

### Authentication

- Zitadel issuer
- OIDC client ID
- Project ID
- API audience
- Client secret replacement
- Authentication health status

### GitHub Integration

- GitHub App ID
- App connection status
- Private key replacement
- Webhook secret rotation
- Installation validation
- GitHub permissions summary

### Documentation

- Default docs directory
- Supported publication defaults
- Supported synchronization settings

Preserve per-catalog settings separately where appropriate.

### Security

- Administrator ownership information
- Session/security status
- Relevant secret rotation operations
- Audit history

### System

- Application version
- Setup state
- Database connection health
- Configuration revision
- Integration diagnostics

Do not expose raw environment variables, private paths, secret files, or credentials.

---

# 9. Settings Editing Experience

The settings interface should offer:

- Readable grouped sections
- Inline validation
- Save and Cancel actions
- Unsaved changes warnings
- Clear connection test results
- Accessible form controls
- Responsive layouts
- Helpful error messages
- Loading states
- Explicit confirmations for dangerous operations

Secrets must behave differently from ordinary fields.

For existing secrets, display a configured indicator.

To replace a secret, the administrator must explicitly initiate replacement.

An empty password or private-key field must never accidentally delete an existing secret.

Do not implement a reveal-secret button.

For sensitive changes, display warnings explaining service impact.

---

# 10. Configuration Activation and Runtime Safety

Some changes affect active application services.

Identify those dependencies before implementing update behavior.

Examples:

- Changing Zitadel issuer affects authentication identity.
- Changing the OIDC client secret affects future sign-ins.
- Changing the GitHub App private key affects API authentication.
- Rotating webhook secrets affects GitHub deliveries.
- Changing application origin affects redirect URLs.
- Changing documentation defaults may affect future catalogs.

Implement controlled activation.

Requirements:

- Validate candidate settings before activation.
- Keep previously working settings available until replacement is ready.
- Avoid partially applying multi-field updates.
- Provide clear error messages when validation fails.
- Preserve active sessions where safely possible.
- Deliberately invalidate sessions when security boundaries require it.
- Ensure background workers and web processes resolve the same active configuration revision.
- Handle configuration changes across multiple replicas.
- Prevent stale in-memory configuration from remaining active indefinitely.
- Ensure failures do not silently activate broken credentials.

Do not assume existing `loadConfig()` caching or singleton initialization will automatically support runtime settings updates.

Pay particular attention to `auth.ts`, where authentication configuration is initialized and cached.

Implement a safe mechanism for refreshing or reconstructing runtime configuration without introducing authentication races or allowing stale authorization decisions.

If a setting genuinely requires application restart, state that honestly in the UI.

## Secret rotation

For sensitive credentials:

- Validate replacement before activation where possible.
- Support transition/overlap when the external provider supports it.
- Provide rollback or recovery procedures.
- Do not silently destroy previously working credentials.
- Never store plaintext previous secrets in audit records.

For webhook secrets, account for the sender and receiver needing to agree on the active secret.

Do not claim a rotation is seamless without implementing that coordination.

---

# 11. Authorization and Security

Apply defense in depth.

Administrative endpoints must enforce:

- Valid authenticated sessions
- Instance administrator authorization
- Appropriate CSRF defenses
- Origin validation
- Strict request schemas
- Request size limits
- Rate limits where appropriate
- Safe error messages
- Auditable changes

Prevent SSRF when validating arbitrary provider URLs.

In particular:

- Do not fetch arbitrary internal HTTP endpoints from user-provided URLs.
- Validate URL schemes.
- Handle DNS rebinding and redirects safely.
- Restrict outbound validation requests appropriately.
- Avoid leaking internal connection information through test results.

Protect against stored XSS in instance branding or descriptions.

Never interpolate administrator-supplied content into executable configuration.

Avoid using client-provided identifiers as proof of permissions.

Use the existing authorization layer and strengthen it where necessary.

---

# 12. MongoDB Persistence Design

Use MongoDB for durable instance settings.

Suggested logical collections:

- `instanceConfiguration`
- `instanceSecrets`
- `instanceAuditEvents`
- `instanceAdministrators`

These are conceptual suggestions.

Reuse existing collections where that is cleaner.

Do not duplicate authorization records unnecessarily.

For each persistent entity, define:

- Typed schema
- Validation
- Appropriate unique indexes
- Revision or version
- Timestamps
- Ownership restrictions
- Backup/restore implications

The configuration must be instance-scoped.

A self-hosted deployment should not accidentally share settings with another deployment merely because both connect to the same MongoDB server.

Use a dedicated database or explicit instance identity boundary as appropriate.

No normal user or catalog administrator should automatically gain instance-level administrative privileges.

---

# 13. Existing Installation Compatibility

This requirement is critical.

The existing deployment currently uses environment variables and secret files.

Do not break it.

Implement a safe migration path.

Requirements:

1. Detect a valid legacy installation.
2. Do not automatically display an open bootstrap wizard.
3. Import existing settings safely where appropriate.
4. Require authorized owner confirmation before activating migrated instance settings.
5. Preserve existing authentication and catalog data.
6. Preserve existing OAuth token encryption behavior.
7. Preserve GitHub App installation mappings.
8. Preserve synchronization queues and operational records.
9. Provide a clear rollback strategy.
10. Avoid requiring users to reinstall Librarian.

Do not automatically overwrite a valid existing configuration with empty database settings.

Document any legacy environment variables that remain required.

Once migrated, establish clear precedence between host-managed bootstrap values and database-managed settings.

Do not silently merge conflicting values.

---

# 14. Error Handling and Recovery

Support these failure scenarios:

- MongoDB unavailable during startup
- MongoDB disconnects during setup
- Invalid Zitadel issuer
- Invalid Zitadel client credentials
- GitHub App credentials rejected
- GitHub App not installed
- Webhook secret mismatch
- Encryption key missing
- Encryption key changed unexpectedly
- Browser closed midway through setup
- Two setup processes running simultaneously
- Two administrators editing settings simultaneously
- Container restarted during finalization
- Invalid configuration update
- Failed credential rotation
- Instance restored from backup
- Configured provider becomes unavailable

Security-sensitive failures must fail closed.

Preserve previously valid settings where possible.

The system should never silently reset itself to an unconfigured public installation after a database or decryption failure.

A previously initialized installation must require an explicit, authenticated recovery procedure.

Do not provide an unauthenticated reset endpoint.

---

# 15. Testing Requirements

Extend the existing test infrastructure.

## Unit tests

Cover:

- Bootstrap configuration validation
- Instance schema validation
- Encryption and decryption
- Invalid encryption keys
- Configuration revisions
- Setup state transitions
- Secret replacement semantics
- Authorization checks
- Configuration precedence

## Integration tests

Cover:

- MongoDB persistence
- Setup initialization
- Concurrent setup attempts
- Atomic configuration updates
- Migration from legacy configuration
- Authentication provider configuration
- GitHub App credential validation
- Worker configuration revision handling
- Safe activation and rollback behavior

## Security tests

Cover:

- Unauthorized setup access
- Bootstrap credential brute-force restrictions
- Bootstrap replay attempts
- Missing CSRF protection
- Non-admin settings access
- Direct API authorization bypass
- Secret exposure through API responses
- Secret exposure in logs
- Malicious provider URLs
- Invalid private keys
- Invalid credential rotations
- Cross-instance configuration access
- Concurrent administrator modifications

## End-to-end tests

Using Playwright, test:

1. Fresh installation
2. Bootstrap authorization
3. Wizard navigation
4. MongoDB validation
5. Zitadel configuration
6. GitHub App configuration
7. Administrator verification
8. Finalization
9. Normal application access
10. Opening Settings
11. Updating normal preferences
12. Replacing an integration secret
13. Restarting the application
14. Verifying settings persistence
15. Confirming setup wizard cannot be reused

Use test fixtures and mocked external providers where appropriate.

Separate mocked verification from genuine external integration testing.

---

# 16. Open-Source Self-Hosting Experience

Update the project's installation documentation.

A new self-hosting user should be able to:

1. Clone Librarian.
2. Configure minimal bootstrap secrets.
3. Start the application and MongoDB.
4. Open the setup page.
5. Authorize setup.
6. Connect Zitadel.
7. Configure the GitHub App.
8. Establish administrator ownership.
9. Complete initialization.
10. Create a documentation catalog.
11. Connect an eligible GitHub repository.
12. Synchronize a `docs/` directory.
13. View published MDX documentation.
14. Reopen Settings later to change eligible configuration.

Document a Docker Compose example that demonstrates the process.

Reuse existing production deployment conventions.

Do not place credentials into example Compose YAML.

Provide:

- Installation guide
- Administrator guide
- Configuration reference
- Secret-management guide
- Upgrade/migration guide
- Troubleshooting and recovery guide

Include screenshots or diagrams only where they genuinely improve comprehension.

---

# 17. Explicitly Out of Scope

Do not implement the following unless strictly required by an existing dependency:

- Redis
- A replacement database
- A new identity platform
- Multi-tenant hosting of unrelated Librarian instances
- A complete GitHub synchronization redesign
- A new documentation renderer
- New GitHub repository write permissions
- Automatic infrastructure provisioning
- Kubernetes support
- Unrelated UI redesign
- New paid cloud dependencies

Keep MongoDB as the configuration and synchronization persistence layer.

Keep Zitadel as the primary identity provider.

Keep the existing GitHub App integration.

Maintain the existing Fumadocs/MDX behavior.

Do not replace stable components merely to accommodate the wizard.

---

# 18. Implementation Phases

Execute the work in manageable phases.

### Phase 1 — Audit

Inspect the repository and produce the migration and implementation plan.

### Phase 2 — Configuration foundation

Implement the bootstrap split, typed instance schemas, MongoDB persistence, and secret encryption.

### Phase 3 — Setup security

Implement bootstrap authorization and controlled initialization state.

### Phase 4 — Wizard UI

Build and connect the first-run setup pages.

### Phase 5 — Integration validation

Integrate Zitadel, GitHub App validation, and administrator verification.

### Phase 6 — Settings dashboard

Implement administrator-only configuration viewing and editing.

### Phase 7 — Runtime activation

Support safe configuration updates and revision-aware runtime behavior.

### Phase 8 — Compatibility

Implement and validate migration from existing deployments.

### Phase 9 — Security and testing

Run the relevant automated suites and resolve failures.

### Phase 10 — Documentation

Update self-hosting, administrator, migration, and recovery documentation.

Complete each phase with tests before progressing.

Avoid unnecessary architectural changes.

Do not modify a running production deployment.

Use an isolated development environment.

Do not deploy, merge, or push production-impacting changes without explicit approval.

---

# 19. Acceptance Criteria

The implementation is acceptable only when:

- A fresh deployment can reach the setup flow without Zitadel and GitHub credentials.
- The setup flow is protected by a secure bootstrap credential.
- MongoDB persistence works.
- Sensitive credentials are encrypted.
- Encryption keys remain outside the database.
- Zitadel authentication works after setup.
- First administrator ownership is securely established.
- GitHub App integration works after setup.
- Documentation synchronization continues to function.
- Setup cannot be reopened after initialization.
- An instance administrator can access Settings.
- Non-administrators cannot access Settings or its APIs.
- Eligible settings can be updated without rebuilding the image.
- Changed runtime settings are activated safely.
- Failed updates do not corrupt working configuration.
- Settings survive restart and redeployment.
- Existing installations can be migrated safely.
- Private credentials never appear in client responses or logs.
- Unit, integration, and end-to-end tests pass.
- Security checks pass.
- Installation and recovery documentation is complete.

---

# 20. Final Deliverables

Provide:

1. Completed implementation.
2. Summary of architectural changes.
3. Files created and modified.
4. Configuration migration explanation.
5. Settings schema documentation.
6. Setup and recovery instructions.
7. Tests added and test results.
8. Security review findings.
9. Known limitations.
10. Any deployment actions requiring owner approval.

Include a concise example of the new installation workflow.

Document which settings are:

- Bootstrap-only
- Editable at runtime
- Editable with restart
- Immutable after initialization
- Security-sensitive

Do not claim any test passed unless it was actually executed successfully.

Do not claim external integrations are verified unless genuine integration tests were performed.

## Execution instruction

Begin by inspecting the actual repository, not by creating files from assumptions.

Preserve the existing architecture and security guarantees.

Prioritize a secure, maintainable implementation over a superficially convenient setup experience.

Proceed with implementation in the working branch after completing the repository audit, while keeping production deployment and merging subject to explicit approval.
