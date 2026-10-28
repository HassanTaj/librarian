---
title: Publish the application image
description: Configure GitHub Actions secrets and publish versioned Librarian images to the registry.
---

# Publish the application image

The repository's `.github/workflows/publish-librarian.yml` workflow runs on pushes
to `deploy/feed`. Its `publish` job requires the `verify` job to succeed first.
Pushing that branch can publish images; obtain explicit approval for the concrete
publication scope before pushing or running the workflow.

## GitHub Actions secrets

Before the first run, provision these repository secrets under **Settings → Secrets
and variables → Actions → Secrets**. All examples below are synthetic placeholders.

| Secret | Required value | Example format |
| --- | --- | --- |
| `REGISTRY_URL` | Registry host used for Docker login; no scheme or path. An explicit port is allowed. | `registry.example.com` |
| `REGISTRY_IMAGE` | Full image name using the same host, including namespace and repository; no tag or digest. | `registry.example.com/namespace/repository` |
| `REGISTRY_USERNAME` | Registry login username with permission to publish the target image. | `<registry-user>` |
| `REGISTRY_PASSWORD` | Registry password or token with permission to publish the target image. | `<registry-token>` |

Registry configuration comes exclusively from `secrets`, with no `vars` lookup or
fallback. The validation step's `env` mapping passes secrets into its shell process;
it does not read GitHub Actions Variables or a local `.env` file. Never put actual
credentials in tracked files, documentation, logs or chat.

If an older setup stored `REGISTRY_URL` as an Actions variable, provision the secret
of the same name before running this workflow. The variable is no longer read.
Provision `REGISTRY_IMAGE` as well; the namespace and repository are no longer
hardcoded in the workflow.

## Image tags and validation

The workflow logs in using `REGISTRY_URL`, then appends these tags to `REGISTRY_IMAGE`:

- `latest`
- The full `${{ github.sha }}` commit identifier
- `v1.0.${{ github.run_number }}`

Registry validation fails before login/build when the host is empty or includes a
scheme or path, or when the image name does not use that host, has an empty path,
ends in `/`, or contains whitespace, a tag or a digest. Missing or invalid login
credentials prevent registry authentication. Do not print secret values to diagnose
configuration failures.

Local configuration checks do not prove that GitHub secrets are provisioned, registry
credentials work, or an image has been published. Record those results only after
an approved run. Image publication is separate from deployment; infrastructure
changes and production rollout follow the infrastructure repository's approval,
DEV verification and rollback procedures.
