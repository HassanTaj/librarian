# Librarian

Git-connected runtime documentation reader and catalog administration application.
Source repositories remain the authoring system. The application uses Next.js,
Fumadocs, Auth.js/Zitadel, MongoDB, a read-only GitHub App and persistent snapshots.

Operator guides:

- [Install an instance](docs/guides/instance-installation.md)
- [Administer instance settings](docs/guides/instance-administration.md)
- [Configuration sources](docs/guides/instance-configuration.md)
- [Provider secrets and root keys](docs/guides/instance-secrets.md)
- [Upgrade a legacy installation](docs/guides/instance-upgrade.md)
- [Recovery and limitations](docs/guides/instance-recovery.md)

The active implementation ledger is
[002 tasks](specs/002-instance-configuration/tasks.md). Unchecked acceptance and
release gates remain open. These guides describe the developing implementation;
they are not evidence of live provider compatibility, verified recovery, performance
or production deployment. Original v1 specifications remain preserved.
