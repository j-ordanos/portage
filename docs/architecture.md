# Architecture

The browser communicates only with the Hono server. The server uses shared core
clients to read Coolify and create/read Dokploy resources. Core modules contain
no Hono or React dependencies.

```text
Browser -> Hono API/SSE -> core engine -> Coolify/Dokploy APIs
                         -> SQLite + sealed vault
```

The migration pipeline is:

```text
Discover -> transform -> plan -> apply -> verify -> cutover/rollback
```
