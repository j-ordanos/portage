# Security

This application holds infrastructure credentials and transient source secrets.
Run it only on infrastructure you control.

## Secrets

- `MASTER_KEY` is 32 bytes and is never stored in SQLite.
- Credentials and secret values use AES-256-GCM sealed records.
- Vault and credential records are scoped to a run.
- IR, plans, manifests, reports, logs, and browser storage must not contain secret values.
- The tool never changes or deletes Coolify resources.

## Authentication

- A single administrator uses an Argon2id password hash.
- Mutations require `X-Requested-With: migrator`.
- Cross-origin mutation requests require a matching `Origin` and `Host`.
- Session and credential TTL hardening are implemented as part of later release work.

## Upstream URLs

- HTTPS is required unless insecure HTTP is explicitly enabled.
- Redirects are rejected.
- Private addresses can be allowed for self-hosted deployments.
- Cloud metadata addresses and userinfo URLs are always blocked.
- Optional host allowlists override normal URL handling.

## Container

Run with a read-only root filesystem, `/tmp` tmpfs, `/data` volume, dropped
capabilities, and `no-new-privileges`. Never mount the Docker socket.
