# Disposable lab

This directory is for local or throwaway Coolify and Dokploy instances only.
Never use production credentials or customer data here.

## Required lab instances

- Coolify v4.x with temporary read-only API tokens
- Dokploy v0.31.x with a temporary API key and Swagger enabled

Keep credentials in a local, ignored `.env.lab` file. Do not commit it.
Record sanitized API responses under `lab/fixtures/<platform>/<version>/`.

The lab should contain the fixtures described in `10-TESTING-AND-LAB.md`:
public Git, Docker image, Compose, Postgres, Redis, mounts, collisions, and
multiple environments.

## Sanitizing fixtures

After recording responses, run:

```bash
pnpm fixtures:sanitize
```

The sanitizer replaces likely secrets, hostnames, IP addresses, emails, and
UUIDs before fixtures are committed.
