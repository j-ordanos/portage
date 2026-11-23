# Migration runbook

## Before

- Create temporary read-only/sensitive-read Coolify credentials.
- Create a temporary Dokploy API key.
- Inventory databases, volumes, cron tasks, webhooks, backups, and notifications.
- Take verified source backups.
- Lower DNS TTL before cutover.

## Migration

1. Accept the security notice.
2. Connect and test both platforms.
3. Discover and review the inventory.
4. Select resources and target settings.
5. Resolve compatibility decisions and secret values.
6. Generate and review the dry-run plan.
7. Explicitly apply resources; apply never deploys.

## Verify and cutover

- Restore database and volume data separately.
- Relink Git and registry credentials.
- Deploy only on temporary domains.
- Verify configuration and health.
- Freeze source writes, perform final sync, switch DNS, and monitor.

## Rollback

- Revert DNS first.
- Use rollback only for resources created by this tool.
- Adopted resources are never deleted.
- Rollback requires exact typed confirmation.
