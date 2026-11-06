---
title: Publish the application image
description: Configure GitHub Actions secrets and publish versioned Librarian images to the registry.
---

# Publish the application image

The repository's `.github/workflows/publish-librarian.yml` workflow runs on pushes
to `deploy/feed`. Its `publish` job requires the `verify` job to succeed first.
Pushing that branch can publish images; obtain explicit approval for the concrete
publication scope before pushing or running the workflow.

## Workflow roles and optional application checks

`publish-librarian.yml` is the primary automatic publication workflow. A push to
`deploy/feed` runs its verification job, then builds and pushes the image if those
checks pass. It publishes an image; deploying a running service is a separate step.

Verification first builds the app and validates feature documents without requiring
coverage evidence. Browser engines are installed before the test and coverage
steps, because coverage includes browser execution. Full artifact validation runs
after coverage and end-to-end tests, when the required evidence and reports exist;
missing evidence, failed coverage gates, and sensitive artifacts still block
publication. A clean checkout must generate this evidence rather than reuse local
reports. The ignored `.specify/feature.json` selector is local checkout state;
document CLI checks follow the selected feature or the default v1 feature.

Browser fixtures refresh synthetic role-cache timestamps before scenarios that
require current authorization. This keeps long serial engine runs independent of
fixture age without relaxing the application's 15-minute fail-closed deadline or
changing the fixture's role grants and deliberately expired sessions.

`.github/workflows/ci.yml` (**Application checks**) is manual-only. Automatic `push`
and `pull_request` triggers are disabled to conserve private-repository Actions
usage and avoid overlapping checks on publication pushes. To run it, open
**Actions → Application checks → Run workflow**, select the branch, and confirm the
run. This workflow runs checks without publishing an image.

Application checks includes container acceptance and a previous-revision image
rollback check that the publication workflow does not run. Obtain that evidence
through a manual run or the equivalent required local checks before declaring a
release complete. Manual-only CI does not waive the project's test, coverage, or
release gates.

Contributors who want automatic CI can restore these triggers in `ci.yml`:

```yaml
on:
  push:
  pull_request:
  workflow_dispatch:
```

If a branch protection rule requires the `application` check, align that rule with
the chosen CI triggers; a manual-only workflow does not automatically report a PR
check. Standard GitHub-hosted runners are free for public repositories. Private
repositories consume the owner's included usage and may incur charges beyond it;
see [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Disabling the separate CI workflow reduces usage, but does not remove any steps
from the publication workflow or guarantee a faster image push.

## MongoDB CI compatibility

Both workflows and the isolated local Compose example pin the official image
`mongo:8.0.34-noble@sha256:3c64937121b9437095921c4bb2569911084c05f7b88e4a263d62a8959d2b2399`.
The multi-platform digest was verified against Docker Hub on 2026-11-05. Both
verification jobs use `ubuntu-22.04` and expose the disposable database on host port
`27018`, matching the integration and browser test harnesses.

The previous publication run failed during service startup after `ubuntu-latest`
resolved to Ubuntu 26.04.1. MongoDB rejects affected host kernels before any tests
can run. Containers share the host kernel, so changing the image's Ubuntu base
does not resolve that restriction.

As checked on 2026-11-05, MongoDB's Ubuntu kernel-detection fix
[SERVER-131779](https://jira.mongodb.org/browse/SERVER-131779) is assigned to the
upcoming 8.0.37 release. The published 8.0.34 patch still needs a compatible host
kernel. GitHub's Ubuntu 22.04 image currently uses Linux 6.8; retain this runner pin
until a replacement image and runner combination has passed verification. See
[MongoDB 8.0 release notes](https://www.mongodb.com/docs/v8.0/release-notes/8.0/) and
[GitHub's Ubuntu 22.04 runner image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2204-Readme.md).

This pin applies to disposable CI and local DEV databases. Production database
upgrades require separate infrastructure planning and approval. When changing a
pin, verify the official tag and digest, test startup and database access, and run
the required application checks before claiming compatibility on a new runner.

## GitHub Actions secrets

Before the first run, provision these repository secrets under **Settings → Secrets
and variables → Actions → Secrets**. All examples below are synthetic placeholders.

| Secret | Required value | Example format |
| --- | --- | --- |
| `REGISTRY_HOST` | Registry host used for Docker login; no scheme or path. An explicit port is allowed. | `registry.example.com` |
| `REGISTRY_NAMESPACE` | One lowercase Docker image namespace component, without slashes or a tag. | `namespace` |
| `IMAGE_NAME` | One lowercase Docker image repository component, without slashes or a tag. | `repository` |
| `REGISTRY_USERNAME` | Registry login username with permission to publish the target image. | `<registry-user>` |
| `REGISTRY_PASSWORD` | Registry password or token with permission to publish the target image. | `<registry-token>` |

Registry host, namespace, image name, and login credentials come exclusively from
`secrets`, with no `vars` lookup or fallback. The publish job maps the three image
name secrets to environment variables and validates them before login/build. It does
not read GitHub Actions Variables or a local `.env` file. Never put actual credentials
in tracked files, documentation, logs or chat.

Image components must start and end with a lowercase letter or digit. Between
alphanumeric groups, Docker permits a single dot, one or two underscores, or one
or more hyphens. Uppercase letters, repeated dots, and leading/trailing separators
are rejected before login or build; secret values are never printed.

If an older setup used `REGISTRY_URL` and `REGISTRY_IMAGE`, split the former host and
image path into `REGISTRY_HOST`, `REGISTRY_NAMESPACE`, and `IMAGE_NAME`. The old names
are no longer read by this workflow.

## Image tags and validation

The workflow composes the image path as
`REGISTRY_HOST/REGISTRY_NAMESPACE/IMAGE_NAME`, logs in using `REGISTRY_HOST`, and
publishes these tags:

- `latest`
- The full `${{ github.sha }}` commit identifier
- `v1.0.${{ github.run_number }}`

Registry validation fails before login/build when the host is empty or includes a
scheme, path, user, digest, or whitespace, or when the namespace or image name is
empty, contains a slash, whitespace, tag, or digest. Missing or invalid login
credentials prevent registry authentication. Do not print secret values to diagnose
configuration failures.

Local configuration checks do not prove that GitHub secrets are provisioned, registry
credentials work, or an image has been published. Record those results only after
an approved run. Image publication is separate from deployment; infrastructure
changes and production rollout follow the infrastructure repository's approval,
DEV verification and rollback procedures.
