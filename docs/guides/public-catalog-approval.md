---
title: Public catalog approval
description: Owner review and operator setup for publishing a repository catalog in Librarian.
---

# Public catalog approval

This guide explains how an owner approves a documentation catalog for public reading and how an
operator makes the matching approval available to Librarian. A public GitHub repository does not
automatically become a public Librarian catalog: GitHub access and permission to publish are
separate checks.

## What the approval covers

Approval is bound to one GitHub repository, branch, documentation folder, Librarian slug, reviewed
commit, and candidate content digest. It covers the selected documentation pages, Fumadocs
`meta.json` navigation files, and supported assets under that folder. The administrator cannot
create or edit approval records through the admin API; the API only checks the operator-managed
manifest.

Use this process when creating a public catalog, changing a private catalog to Public, or changing
the repository, branch, docs folder, slug, or approval reference of a public catalog. Before
starting, make sure:

- The owner has authority to approve the selected content for public reading and has reviewed the
  exact pages and assets in the candidate commit.
- The GitHub App is installed on the repository and grants **Contents: Read-only** access. Use the
  [GitHub App setup in the local DEV guide](initial-setup.md#5-configure-the-github-app) if it is
  not installed.
- The selected branch and docs folder exist, the folder contains at least one `.md` or `.mdx` page,
  and its Fumadocs navigation references only pages in that folder. Librarian rejects unsupported
  content, unsafe paths, and files beyond its configured limits.
- The catalog slug is the intended Librarian URL and is included in the owner's approval scope.

## 1. Freeze and review the candidate

Choose the repository, branch, `docsPath`, and catalog slug before the owner reviews. Record the
branch's exact 40-character commit SHA. The selected documentation folder is the candidate root;
files elsewhere in the repository are outside this catalog.

The owner reviews all candidate pages, navigation metadata, and supported assets at that commit,
including content reachable through Fumadocs navigation and local links. Check for secrets,
private information, and material the owner does not intend to publish. If any in-scope file changes,
review and approve the new candidate again unless the owner explicitly approves future updates for
this same scope.

## 2. Prepare the approval manifest

Set `PUBLIC_CATALOG_APPROVALS_FILE` in the server's environment to an existing JSON file. For local
DEV, the ignored `.env.local` can contain:

```dotenv
PUBLIC_CATALOG_APPROVALS_FILE=.local/public-catalog-approvals.json
LIBRARIAN_WORKER_ENABLED=1
```

Paths are resolved from the Librarian working directory. The file must be readable by the Next.js
Node process, no larger than 64 KiB, and outside both `public/` and `CONTENT_ROOT`. Keep it as an
operator-managed, read-only application input; Librarian never writes approval records. In v1 the
sync worker runs in the same process and container as the API. Development starts it only when
`LIBRARIAN_WORKER_ENABLED=1`; restart the server process after changing the configured manifest
path so both API and worker load that path. The worker reads the manifest contents during approval
checks, so provision or replace records in the same file without changing the configured path.

The file schema is `formatVersion: 1` with an `approvals` array. Each record uses these fields:

| Field | Required value |
| --- | --- |
| `approvalId` | Unique, operator-assigned reference; enter this exact value in **Owner approval reference**. |
| `version` | Positive integer. Start a new record at `1`. |
| `approvedAt` | ISO 8601 UTC timestamp, such as `2026-10-13T00:00:00.000Z`. |
| `ownerReference` | Non-empty reference to the owner's review record, such as a ticket or approval note. |
| `repositoryId` | Numeric GitHub repository ID from GitHub's repository record. This is **not** the GitHub App `installationId`. |
| `branch` | Exact branch name, without `refs/heads/`. |
| `docsPath` | Exact repository-relative documentation folder, such as `docs`. |
| `slug` | Exact Librarian catalog slug. |
| `reviewedCommit` | Exact 40-character commit SHA reviewed by the owner. |
| `candidateManifestDigest` | 64-character SHA-256 digest of the selected candidate files. |
| `allowFutureUpdates` | `false` for the reviewed commit only; `true` only when the owner approves future content on the same scope. |

Example structure (replace every sample value with the approved source values):

```json
{
  "formatVersion": 1,
  "approvals": [
    {
      "approvalId": "owner-review-2026-001",
      "version": 1,
      "approvedAt": "2026-10-13T00:00:00.000Z",
      "ownerReference": "review-ticket-123",
      "repositoryId": 123456789,
      "branch": "main",
      "docsPath": "docs",
      "slug": "example-docs",
      "reviewedCommit": "0123456789abcdef0123456789abcdef01234567",
      "candidateManifestDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "allowFutureUpdates": false
    }
  ]
}
```

### Obtain the candidate digest

Do not use the Git commit SHA, repository ID, Installation ID, or a digest of only the Markdown
files as `candidateManifestDigest`. Librarian computes it over the files selected for the configured
`docsPath`: each file's relative path, Git mode, byte size, and SHA-256 of its bytes, sorted by path
and serialized with `formatVersion: 1`. This includes supported assets and `meta.json` files as well
as Markdown/MDX pages.

The value must be produced from the exact candidate returned by Librarian's GitHub candidate reader
and the `candidateManifestDigest` function in `lib/public-approvals.ts`; the candidate reader is in
`lib/sync/github.ts`. Use a trusted operator workflow to calculate it for the reviewed commit and
verify that the branch still points to that commit before registering a new public catalog. The
admin API does not expose an approval-writing or digest-preview endpoint. If the operator cannot
verify the digest from the same candidate files, keep the catalog Private until that verification
is available.

Set `allowFutureUpdates` to `true` only when the owner's approval explicitly covers future commits
on the same repository, branch, docs folder, and slug. With `false`, a later branch commit requires
a new owner review and matching record before Librarian can publish it. Changing any scope field
requires a record for the new scope regardless of this setting.

## 3. Add the catalog in Librarian

1. Confirm the approval file is present at the configured path and readable by the running
   application process. For a local DEV setup, use the paths and secret handling in the
   [initial setup guide](initial-setup.md).
2. In the admin page, select the installed GitHub App installation and the approved repository,
   branch, and documentation folder. The installation ID lets Librarian read the repository; the
   approval manifest separately matches GitHub's numeric repository ID.
3. Enter the approved slug and catalog details. Set **Visibility** to **Public** and paste the exact
   `approvalId` into **Owner approval reference**.
4. Save, then run the catalog's initial sync. Confirm the catalog appears as Public in the directory
   and its sync status is successful before sharing the Librarian URL.

Librarian verifies the repository ID and branch head through GitHub, reads the selected candidate,
and checks the approval's scope, commit, and digest before creating or changing a public catalog.
The same approval is checked during sync, so failed approval checks prevent publication of changed
content.

## Troubleshoot `public_approval_required`

The same error intentionally covers an absent or unreadable manifest, malformed JSON, missing
approval ID, and a record whose scope or candidate does not match. Check, in this order:

1. `PUBLIC_CATALOG_APPROVALS_FILE` points to the intended file in the process that runs the API and
   sync worker; the file exists, is readable, and is outside `public/` and `CONTENT_ROOT`.
2. The manifest parses as v1 JSON and has no duplicate `approvalId` values.
3. **Owner approval reference** exactly equals the record's `approvalId`.
4. `repositoryId` is the numeric GitHub repository ID, not the app installation ID; branch,
   `docsPath`, and slug exactly match the catalog.
5. The candidate commit and digest match the owner's reviewed candidate. Recompute the digest if
   any page, `meta.json`, or supported asset changed.

If the catalog should remain private, set **Visibility** to **Private** and clear **Owner approval
reference**. Approval validation runs before a catalog update: a rejected edit preserves the
previous settings, and a rejected new registration creates no catalog.

Implementation references: `lib/public-approvals.ts` (validation and digest),
`app/api/admin/repos/route.ts` (public catalog creation), and `lib/config.ts` (manifest path).
