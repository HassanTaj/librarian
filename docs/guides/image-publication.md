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

## GitHub Actions secrets

Before the first run, provision these repository secrets under **Settings → Secrets
and variables → Actions → Secrets**. All examples below are synthetic placeholders.

| Secret | Required value | Example format |
| --- | --- | --- |
| `REGISTRY_HOST` | Registry host used for Docker login; no scheme or path. An explicit port is allowed. | `registry.example.com` |
| `REGISTRY_NAMESPACE` | One image namespace path component, without slashes or a tag. | `namespace` |
| `IMAGE_NAME` | One image repository path component, without slashes or a tag. | `repository` |
| `REGISTRY_USERNAME` | Registry login username with permission to publish the target image. | `<registry-user>` |
| `REGISTRY_PASSWORD` | Registry password or token with permission to publish the target image. | `<registry-token>` |

Registry host, namespace, image name, and login credentials come exclusively from
`secrets`, with no `vars` lookup or fallback. The publish job maps the three image
name secrets to environment variables and validates them before login/build. It does
not read GitHub Actions Variables or a local `.env` file. Never put actual credentials
in tracked files, documentation, logs or chat.

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
