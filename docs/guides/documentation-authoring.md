---
title: Author documentation for Librarian
description: Supported Markdown, static MDX, navigation, links, assets and AI prompts for compatible source documentation.
---

# Author documentation for Librarian

Use this guide when writing documentation or asking an AI assistant to prepare a
repository for Librarian. Librarian reads a configured GitHub repository, branch
and documentation folder. Keep authoring in that source repository; Librarian
does not edit it or run its scripts, install its dependencies or execute its MDX.

These rules describe the current importer and validator. A general Fumadocs site
can use features that Librarian deliberately does not accept. Formatting a page
correctly does not grant repository access or authorize public publication.

## 1. Choose a documentation folder

Keep the selected folder focused on reader content. A small starting layout is:

```text
docs/
  meta.json
  quickstart.md
  notes.mdx
  assets/
    screenshot.png
```

Use lowercase kebab-case filenames and directories as a portable convention.
Use lowercase `.md` or `.mdx` extensions. Files must be ordinary non-executable
Git files (`100644`); symlinks, executable files and submodules are rejected.
Keep application source, packages, build output and secrets outside this folder.
Unsupported ordinary file extensions are skipped by the GitHub importer, so they
will not become downloadable portal assets. Unsafe tree entries can still reject
the import even when their extensions would otherwise be skipped.

Do not use traversal segments, backslashes, Windows device names, trailing dots
or spaces, encoded path tricks or special punctuation in filenames. Keep each
path within 1,024 UTF-8 bytes and 32 segments. Reserve the root `manifest.json`
name for Librarian's generated snapshot manifest.

Each page needs a unique route. `index.md` maps to its containing directory;
`README.md` is an ordinary page, not the directory index. Do not create both
`topic.md` and `topic.mdx`, or `topic.md` and `topic/index.md`: their routes collide.
Renaming a page changes its route; update links and navigation together.

## 2. Write Markdown with frontmatter

Prefer `.md` for normal prose, headings, lists, GFM tables, task lists, links,
images and fenced code. Use descriptive headings, meaningful link text and image
alt text. Put commands and configuration examples in labelled code fences.
Examples must use placeholders rather than live credentials or private data.

For example, `quickstart.md`:

```markdown
---
title: Quickstart
description: Prepare a local documentation workspace.
---

# Quickstart

## Prepare the workspace

Create a dedicated documentation folder and keep credentials outside it.

## Next steps

Review the documentation with its owner before publication.
```

Frontmatter is optional, but include `title` and `description` for clear page and
navigation metadata. Only these keys are accepted:

| Key | Type and limit |
| --- | --- |
| `title` | Non-blank string, at most 120 Unicode characters |
| `description` | String, at most 500 Unicode characters |
| `full` | Boolean; optional full-width page layout |

Put the YAML block at the very beginning of the UTF-8 file. Use simple YAML
scalars, without duplicate keys, aliases, anchors, custom tags or control
characters. Do not copy frontmatter fields such as `icon`, `sidebar_position`,
`draft`, `slug` or `tags` from another documentation system; unknown keys fail
validation. If title is omitted, Librarian uses the first level-one heading or
the filename as a fallback.

## 3. Use only the supported static MDX subset

Use `.mdx` only when a supported component improves the page. Components are
provided by Librarian; do not add imports. The current allowlist is:

| Component | Permitted attributes |
| --- | --- |
| `Info`, `Note`, `Warning` | None |
| `Columns` | Required `cols`; literal integer 1–4, such as `cols={2}` |
| `Card` | Required `title`; optional `icon`, `description`, `href`; literal strings |
| `Steps` | None |
| `Step` | Required `title`; literal string |

For example, `notes.mdx`:

```mdx
---
title: Author notes
description: A static callout and link to the quickstart.
---

# Author notes

<Info>
Review the selected source folder before enabling a catalog.
</Info>

<Columns cols={2}>
  <Card title="Quickstart" href="quickstart.md" description="Prepare the workspace." />
  <Card title="Review" description="Ask the owner to review the intended audience." />
</Columns>
```

Do not use imports, exports, JavaScript expressions, custom components, raw HTML,
JSX fragments, event handlers, spread attributes, dynamic values or executable
diagrams/widgets. Apart from the bounded literal `Columns` count, attribute
expressions are rejected. `Card` links follow the same link policy as Markdown
and cannot target attachments. Prefer omitting `icon` unless its rendering has
been checked; it is a literal string, not an imported React icon.

Show syntax such as template expressions or HTML in fenced code or inline code
rather than executable page markup. Mermaid fences are code examples; do not
assume an interactive diagram renderer is available. Replace unsupported visual
widgets with prose, tables or local supported raster images. Do not simply rename
executable MDX to `.md`; remove or safely rewrite the unsupported content.

## 4. Add Fumadocs navigation

Use optional `meta.json` files in the folders whose navigation you want to name
or order. For the sample folder above:

```json
{
  "title": "Documentation",
  "pages": ["quickstart", "..."]
}
```

Use extensionless page names relative to that metadata folder. Every explicitly
named page or folder must exist and contain an accepted page. `...` includes
remaining pages. Allowed keys are `title`, `description`, `pages`, `root` and
`defaultOpen`; the last two are booleans. `title` and `description` are strings
of at most 120 characters, and `pages` is an array of strings. Use valid JSON
without comments or trailing commas. Do not assume other Fumadocs navigation
syntax, separators or external-link entries are supported by Librarian's validator.

## 5. Keep links and assets inside the content boundary

- Prefer relative source links, such as `quickstart.md#next-steps`. From a nested
  folder, `../quickstart.md` is valid when it stays within the selected docs folder.
- Root-relative links start at the selected content folder, not the application
  or GitHub repository root. Avoid hardcoding a catalog slug or generation query.
- Keep linked pages and attachments within the selected folder. A link to a
  repository file outside it cannot become a portal download. Use an inline file
  path, or an approved external HTTPS link, when referring to application source.
- Local document links may include one heading fragment, but no query string.
  Attachment and image links cannot include fragments or queries.
- External text links support HTTPS and mailto. HTTP, protocol-relative URLs,
  embedded URL credentials, data URLs and JavaScript URLs are rejected.
- Images must be local PNG, JPEG, GIF or WebP files; remote images and SVG are
  unsupported. Link downloadable PDF, TXT, CSV and JSON files using ordinary links.
  JSON must parse, text must be valid UTF-8, and image/PDF bytes must match the
  expected format. Renaming an extension does not convert a file.

Check that targets and heading anchors actually exist. Successful syntax validation
alone is not proof that every link target is present or every fragment resolves.

## 6. Stay within current ingestion limits

| Input | Maximum |
| --- | --- |
| Accepted files per candidate, including metadata and assets | 1,000 |
| Pages per candidate | 500; at least one page required |
| Markdown or MDX file | 256 KiB |
| Frontmatter or `meta.json` | 16 KiB |
| Individual asset | 5 MiB |
| Snapshot | 50 MiB, including normalized content and generated manifest |
| Metadata nesting | 8 levels |
| Parsed page syntax tree | 50,000 nodes |

Leave headroom below the snapshot limit because normalization and the generated
manifest add bytes. These are current implementation limits, not a promise about
future releases. Split oversized material or optimize assets instead of assuming
the operator will raise limits.

## 7. Give an AI assistant a compatible authoring prompt

Copy this prompt and replace its placeholders before use:

```text
Prepare documentation for ingestion by Librarian.

Source repository: <repository>
Selected branch: <branch>
Selected documentation folder: <docs-folder>
Intended audience: <private readers or owner-approved public readers>
Requested topics or existing files: <scope>

First inspect the existing files, links, navigation and project instructions.
Follow Librarian's documentation-authoring guide and the current validator when
available. Make the smallest complete documentation change within the scope.

Use UTF-8 Markdown (.md) by default. Add YAML frontmatter containing title and
description; full is the only other supported key. Keep title within 120 Unicode
characters and description within 500. Use clear headings and labelled code fences.

Use .mdx only for these static components: Info, Note, Warning (no attributes),
Columns (literal cols 1-4), Card (required title, optional icon/description/href,
all strings), Steps (no attributes), Step (required string title). Add no imports,
exports, expressions, raw HTML, custom components or dynamic attributes. The only
expression exception is a literal Columns count such as cols={2}.

Use lowercase kebab-case paths and unique routes. Treat index.md as a directory
index; README.md is an ordinary page. Keep links and assets inside the selected
docs folder. Prefer relative source-page links; local links cannot use queries,
and only document links may have heading fragments. External text links may use
HTTPS or mailto; use only local PNG/JPEG/GIF/WebP images. Attachments may be PDF,
TXT, CSV or JSON. Do not invent missing assets or assume unsupported files import.

Use optional meta.json with only title, description, pages, root and defaultOpen.
Use existing extensionless page names and "..." to include remaining pages.
Preserve existing navigation and update all affected links when renaming files.

Stay below 500 pages, 1000 accepted files, 256 KiB per page, 16 KiB per metadata
block/file, 5 MiB per asset and 50 MiB per snapshot with headroom. Keep files
non-executable (Git mode 100644); do not add symlinks, submodules or manifest.json.

Use synthetic examples and placeholders. Do not copy secrets, live environment
values or private content into public material. Do not change catalog visibility,
credentials, ingestion rules or infrastructure. Do not commit, push or publish.

Validate frontmatter, Markdown/MDX, metadata, routes, paths and link targets using
the actual Librarian validator if available. Do not invent validation commands.
Report changed files, checks run, unsupported content and unresolved questions.
Distinguish static checks from successful sync, rendered review and publication.
```

For an audit before editing, prepend: “Inspect only. Report incompatible files,
their exact rejection reasons, affected links and a proposed conversion plan;
do not change files yet.” Never give an assistant production secret values to
help it format documentation.

## 8. Review and synchronize

Before handing the folder to an administrator, verify the page metadata, unique
routes, navigation entries, local targets, assets, limits and absence of private
values. Review AI rewrites for changed meaning, lost instructions and invented
commands. Use the actual Librarian validator when available; a generic Markdown
linter or successful Fumadocs build does not prove ingestion compatibility.

After an authorized source update, inspect the catalog's synchronization status
and published commit, then review navigation, pages, search and assets with the
intended reader permissions. A rejected candidate should leave the last valid
generation available; correct the source and request a resync instead of weakening
validation. Repository access loss and disabled catalogs can prevent serving.

See [initial setup](initial-setup.md) for GitHub App and operator prerequisites,
[public catalog approval](public-catalog-approval.md) for owner approval, and
[image publication](image-publication.md) for application image publishing.
Public GitHub visibility alone never authorizes public reading in Librarian.

Maintainers: recheck this guide when changing `lib/content/validate.ts`,
`lib/content/paths.ts`, `lib/sync/github.ts`, `lib/limits.ts` or `mdx-components.tsx`.
These are repository source paths, not portal content links.
