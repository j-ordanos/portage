# Security

Portage holds keys to your infrastructure, so it keeps as little as possible for as short a time as possible.

## What is stored, and how

| Data | Storage |
|---|---|
| Account password | argon2id hash. |
| Saved Coolify tokens and Dokploy keys | AES-256-GCM, sealed with `MASTER_KEY` (or the generated key file). The API never returns them. |
| Variable values and passwords read from Coolify | Sealed while a migration is in progress, erased when it applies. |
| Sessions | Random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie. Only its SHA-256 is stored. |
| Migration records | Names, ids and step results. No secrets. |

## Guarantees

- Coolify is only ever read.
- Nothing is deployed. Rollback deletes only what Portage created.
- Each account sees only its own connections and migrations.
- Secrets are redacted from logs, progress events, error responses and exports.
- Requests to cloud metadata addresses are always refused. Redirects from Coolify/Dokploy are never followed.
- State-changing requests need a custom header and a matching `Origin`.

## Limits you should know

- Whoever administers the host can access Portage while it runs. Run it on infrastructure you control, behind HTTPS.
- By default the encryption key lives next to the data. Set `MASTER_KEY` to keep them apart.
- Use temporary tokens: a Coolify token with the sensitive permission can read every secret on that Coolify.
- There is no email, so there is no password reset link.

## Reporting a vulnerability

Please open a private security advisory on the repository, or contact the author through the GitHub profile. Do not post secrets in public issues.
