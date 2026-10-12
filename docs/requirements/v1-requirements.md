# Librarian — Git-connected documentation portal

## 1. Goal and confirmed decisions

Build **`librarian`**, a separate Next.js application using Fumadocs, at **[docs.perspective-v.com](https://docs.perspective-v.com/)**.

The portal will:

- List configured repositories on its homepage, including private repositories with a **Restricted** badge.
- Serve documentation at `/{repo-slug}/{doc-page-path}`, for example:
  - `/contabo-server-setup/runtime/ci`
  - `/homelab-server/getting-started`
- Allow anonymous reading of public documentation.
- Require Zitadel login **and the assigned repository role** for private documentation.
- Ingest documentation from selected GitHub repositories and update it after pushes.
- Provide search within the currently selected repository.
- Include a small administration interface for repository configuration and sync status.

Developers continue writing documentation in their source repositories. The portal needs no documentation editor.

**Chosen stack:** Next.js, Fumadocs, Auth.js with Zitadel, the existing MongoDB instance, a GitHub App, and persistent local content storage. No upstream Fumadocs fork is needed.

## 2. UI direction from the showcase

I reviewed the [Fumadocs showcase](https://www.fumadocs.dev/showcase) and inspected the live Prisma, Better Auth, and Turborepo documentation layouts.

**Recommended direction: Prisma-style project discovery, Better Auth-style reading, and a Turborepo-style project selector.**

| Reference | What Librarian should take from it |
|---|---|
| [Prisma documentation](https://www.prisma.io/docs) | Clear entry points with a title, short description, and direct documentation link. Adapt these into repository cards. |
| [Better Auth documentation](https://better-auth.com/docs/installation) | Grouped sidebar navigation, clear active-page styling, readable article width, code blocks, callouts, and an “On this page” panel. |
| [Turborepo documentation](https://turborepo.dev/docs) | Compact header, prominent project identity, a project menu, and restrained navigation. |
| [Fumadocs showcase](https://www.fumadocs.dev/showcase) | Consistent cards and spacing for a directory of independent projects. |

### Homepage

- Header: **Perspective V / Docs**, theme control, and sign-in/account menu.
- Small heading: **Project documentation**, followed by a brief explanation.
- Repository cards with configured title, safe public description, route, and Public or Restricted badge.
- A name filter for finding repositories; this searches the directory, not document contents.
- Responsive grid: three columns on wide screens, two on tablets, one on phones.
- Private cards remain visible. Opening one starts login when necessary and returns the reader to the requested page.

### Repository reader

- Project selector listing the configured repositories, with restricted entries visibly marked.
- Sidebar containing only the selected repository’s document tree.
- Main article with breadcrumbs, headings, code-copy controls, and previous/next navigation.
- Right-side table of contents on desktop; collapsible navigation on mobile.
- Search labelled **Search this project**, with keyboard access.
- A clear access-denied screen for authenticated users without the required role.

Use the standard Fumadocs components, neutral surfaces, subtle borders, and one Perspective V accent colour. Support system, light, and dark themes. Use original branding and assets.

### Administration

At `/admin`, provide a compact repository table and configuration form:

- GitHub repository, branch, documentation folder, route slug.
- Display title and public description.
- Public/private setting and required Zitadel reader role.
- Enable/disable control.
- Collapsed repository summaries with an Edit action and a confirmed Delete action.
- Last successful sync, published commit, current status, and readable error.
- **Sync now** action.

## 3. Application, ingestion, and access control

### Project separation and storage

Create the application in **`D:\Repos\VPS & Homelab Infrastructure\librarian`**, with its own Git repository.

Reuse suitable layout and container patterns from the existing application at **`contabo-server-setup/docs`**. Keep infrastructure documentation in its source repository; move application ownership into Librarian.

Use the existing MongoDB deployment with a dedicated database and scoped application user:

- **Repository records:** source identifiers, configuration, visibility, required role, published generation, and sync status.
- **Sync jobs:** pending work, webhook delivery identifiers, lease information, and failures.

Use the official MongoDB driver. Store document snapshots and their assets on a persistent volume outside Next.js’s `public` directory. Credentials belong in Swarm secrets, not repository records.

### GitHub ingestion

Register a GitHub App installed only on selected repositories, with read-only Contents access and the necessary webhook subscriptions.

Flow:

1. An administrator configures a repository and requests its initial sync.
2. GitHub sends a push webhook.
3. Librarian verifies the signature, deduplicates the delivery, and checks the configured repository and branch.
4. A durable MongoDB job is queued; the webhook returns promptly.
5. One background worker fetches the configured documentation folder using a short-lived installation token.
6. The worker validates the candidate content and prepares an immutable snapshot.
7. Only a successful snapshot becomes the published generation.
8. Subsequent requests use that generation and refresh their Fumadocs loader and search cache.

Run the worker in the same container, started with the Node server. Use MongoDB leases to serialize ingestion and recover abandoned jobs after restart, including during overlapping Swarm updates.

A failed sync keeps the last successful documentation available. Manual resync recovers missed webhooks. GitHub App removal or loss of repository access disables serving that catalog until an administrator resolves it.

**Documentation updates must not require an application image rebuild.**

### Content format and rendering

For v1, support:

- `.md` files with YAML frontmatter.
- GitHub Flavored Markdown, headings, tables, lists, links, and fenced code blocks.
- Optional Fumadocs `meta.json` navigation configuration.
- Local images and attachments from the configured documentation folder.

Convert existing MDX content where necessary. Reject executable MDX/JSX, imports, expressions, unsafe HTML, symlinks, and paths escaping the documentation folder. Do not execute repository scripts or install repository dependencies.

Use Fumadocs’ **`@fumadocs/local-md` with `dynamicLoader`**, with one source per repository and its own base URL. Fumadocs documents this integration as working at runtime without a content bundle. [Fumadocs Local Markdown](https://www.fumadocs.dev/docs/integrations/content/local-md)

Resolve relative document links and assets under the repository’s route. Build search indexes on the server and cache them per repository generation, with bounded cache retention.

### Zitadel authentication and authorization

Use Auth.js’s Zitadel integration following the official Next.js integration guidance. Pin a compatible dependency set and prove login, refresh, and logout before production. [Zitadel Next.js integration](https://zitadel.com/docs/sdk-examples/nextjs)

- Zitadel manages identities and role assignments.
- Use `librarian-admin` for catalog administration.
- Use `docs:{repo-slug}:reader` for each private repository.
- A portal administrator does not automatically receive private reader access.
- GitHub retains writer permissions; Librarian has no content-writing role.

Read verified role claims for the configured Zitadel project. [Zitadel role claims](https://zitadel.com/docs/guides/integrate/retrieve-user-roles)

**Role freshness:** refresh verified roles on the first protected request after a maximum of 15 minutes. Renewing a session must not indefinitely preserve stale roles. If refresh fails after that deadline, deny protected access until authentication succeeds.

Enforce authorization in the server content boundary for pages, navigation, search, metadata, and assets. Private content must never enter publicly downloadable indexes, static bundles, sitemaps, or shared public caches. Serve protected images directly through the authorized asset handler.

The homepage exposes only explicitly configured directory metadata for private repositories.

### Interfaces

| Route | Purpose |
|---|---|
| `/` | Repository directory |
| `/{repoSlug}/[[...page]]` | Repository overview and documentation |
| `/api/search/{repoSlug}` | Authorized, repository-scoped search |
| `/api/assets/{repoSlug}/[...path]` | Authorized local asset delivery |
| `/api/webhooks/github` | Signed GitHub event intake |
| `/api/auth/[...nextauth]` | Zitadel authentication |
| `/admin` and `/api/admin/repos` | Authorized catalog configuration |
| `/api/admin/repos/{id}` | Optimistic settings update or confirmed catalog removal |
| `/api/admin/repos/{id}/sync` | Queue manual resync |
| `/api/health` | Container health without sensitive details |

Reserve application route names so repository slugs cannot collide with them. Require CSRF/origin protection for session-authenticated administration mutations.

## 4. Implementation and deployment sequence

1. **Create Librarian:** scaffold the separate app, reuse Fumadocs components, and implement the directory and reader against fixtures.
2. **Prove the private boundary:** integrate Zitadel and test one public fixture and one private fixture, including search and assets.
3. **Add ingestion:** implement MongoDB registration, GitHub App webhooks, durable sync jobs, snapshot publication, and administration.
4. **Prepare source repositories:** establish their documentation folders and explicitly approve which content is public. Private GitHub sources default to private.
5. **Package the app:** produce a standalone container and push versioned images to the existing Gitea registry using the established build/push pattern.
6. **Update infrastructure descriptors:** keep Swarm, Traefik, secrets, networks, and deployment scripts in `contabo-server-setup`.

The current docs manifest uses Traefik HTTPS, port 3000, Watchtower’s fast scope, and limits of **0.5 CPU / 512 MB**. Add the MongoDB network, scoped secrets, and a persistent content volume. Keep one replica and place it on the node holding that volume.

Build images outside the VPS. Validate ingestion and rendering within the current limits before proposing any resource increase.

Trial on a separate DEV hostname before replacing the existing service at `docs.perspective-v.com`. Retain the previous image and configuration for rollback. Back up the application database and content volume together.

Before deployment, revalidate the live service, Gitea authentication, Zitadel settings, MongoDB connectivity, and the checkout reported at `/home/repo/contabo-server-setup`. Perform the approved deployment through `ssh contabo`, then verify it in the browser.

## 5. Acceptance criteria and handoff boundaries

The implementation is ready for production only when these checks pass:

- The homepage lists configured public and private repositories at the correct paths.
- Anonymous readers can access public docs; private access returns through Zitadel to the original URL.
- A logged-in user without the repository role cannot retrieve its pages, search results, navigation, metadata, or assets.
- Role removal takes effect within the agreed 15-minute freshness window.
- Signing out and browser back navigation do not expose private content through application caches.
- Updating source documentation refreshes pages, links, navigation, assets, and search without rebuilding the app image.
- Invalid signatures, duplicate deliveries, unrelated branches, and concurrent events behave correctly.
- Invalid content, GitHub failures, and worker restarts retain the last successful snapshot and expose an actionable admin status.
- Disabling a catalog stops serving it.
- Mobile layouts, keyboard navigation, focus states, themes, and empty/error states are usable.
- Representative repositories fit the VPS limits during both ingestion and reading.
- Deployment health checks and rollback work.

**Defaults:** GitHub sources only; one configured branch and docs folder per catalog; Markdown authoring; repository-scoped search; explicit public publication; no web editor, AI Q&A, page-level ACL, or automatic GitHub-contributor-to-Zitadel mapping.

**Not checked:** full live Zitadel/GitHub acceptance, ingestion performance, production resource usage, and deployment. Local application implementation and verification exist in the feature worktree; nothing was deployed or published.
**Main risk:** private-content leakage through an unguarded delivery or cache path; production rollout depends on proving that boundary.
