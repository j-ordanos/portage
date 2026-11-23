# Compatibility rules

This catalog documents implemented rule identifiers. Messages and fix hints
remain centralized in the compatibility rule runner.

| Rule | Effect |
|---|---|
| R-002 | Sensitive-read secret values unavailable |
| R-011 | Static build needs target verification |
| R-012 | Railpack fallback is unverified |
| R-013 | Unknown build pack requires manual configuration |
| R-020 | Private Git credentials require relinking |
| R-030 | Secret or environment value unavailable |
| R-032 | Team-level shared variables need manual handling |
| R-033 | Unknown shared-variable reference |
| R-034 | Invalid environment key |
| R-050 | Mount copied as definition only |
| R-060 | Database data is not copied |
| R-061 | Database password unavailable |
| R-063 | Unsupported database engine |
| R-070 | Compose contains Coolify magic variables |
| R-071 | Compose contains Coolify/Traefik labels |
| R-072 | Compose contains Coolify/external networking |
| R-073 | One-click template requires manual re-entry |
| R-074 | Compose YAML is invalid |
