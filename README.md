# Coolify to Dokploy Migrator

Migrates Coolify v4 projects into Dokploy v0.31 through official APIs.
It inventories resources, previews a plan, creates target resources undeployed,
verifies configuration, generates cutover/report artifacts, and supports
rollback of resources created by this tool.

## Quick start

```bash
cp .env.example .env
# Set MASTER_KEY and ADMIN_PASSWORD_HASH in .env
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://localhost:3001>.

## Docker

```bash
docker build -t coolify-dokploy-migrator:0.1.0 .
docker run -d --name migrator \
  -e MASTER_KEY='...' \
  -e ADMIN_PASSWORD_HASH='...' \
  -v migrator-data:/data \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  -p 3000:3000 \
  coolify-dokploy-migrator:0.1.0
```

Use HTTPS and a private network or VPN. The UI does not replace backups or
production data-migration procedures.

## Environment

| Variable | Required | Default | Purpose |
|---|---:|---:|---|
| `MASTER_KEY` | yes | — | 32-byte base64 AES-256-GCM key |
| `ADMIN_PASSWORD_HASH` | yes | — | Argon2id password hash |
| `DATA_DIR` | no | `/data` | SQLite data directory |
| `PORT` | no | `3000` | HTTP port |
| `PUBLIC_URL` | no | — | HTTPS public origin |
| `UPSTREAM_ALLOW_PRIVATE` | no | `true` | Allow private upstream networks |
| `UPSTREAM_ALLOWED_HOSTS` | no | — | Comma-separated host allowlist |
| `RUN_RETENTION_DAYS` | no | `30` | Run metadata retention |

Generate an admin password:

```bash
pnpm hash-password 'choose-a-strong-password'
```

Generate a master key:

```bash
openssl rand -base64 32
```

## Known limitations

- Data and volume contents are not copied.
- Git, registry, SSH, and S3 credentials require manual relinking.
- Coolify/Dokploy live endpoints must be verified against disposable lab instances.
- Apply never deploys resources.
- Source Coolify resources are never deleted or modified.
