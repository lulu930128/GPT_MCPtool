# Memory Core Operations

## Runtime topology

Default local endpoints:

| Role | Endpoint |
| --- | --- |
| Backend health | `http://127.0.0.1:18765/health` |
| Backend API | `http://127.0.0.1:18765/api/v1` |
| Backend OpenAPI | `http://127.0.0.1:18765/docs` |
| MCP health | `http://127.0.0.1:8818/health` |
| MCP endpoint | `http://127.0.0.1:8818/mcp` |
| Tunnel readiness | `http://127.0.0.1:8800/readyz` |
| Tunnel local UI | `http://127.0.0.1:8800/ui` |

All listeners remain loopback-only. A custom launcher must keep the backend port, MCP API URL, and
viewer URL consistent; the stack does not rewrite private `.env` files.

## Installation and migration

```powershell
cd "C:\GPT_MCPtool\Memory Core"
Copy-Item .env.example .env
uv sync --all-groups
uv run alembic upgrade head
```

Runtime never applies migrations automatically. Before upgrading:

1. create and verify a backup;
2. read each pending migration;
3. stop writers using the component-owned lifecycle;
4. run `uv run alembic upgrade head` explicitly;
5. start the stack and verify version, health, MCP discovery, and representative reads.

Do not validate a migration by deleting or resetting the formal data directory.

## Starting the stack

Initial private tunnel setup:

```powershell
.\scripts\memory_core_stack.ps1 -Action Setup -TunnelId "tunnel_replace_me"
.\scripts\memory_core_stack.ps1 -Action SaveRuntimeKey
.\scripts\memory_core_stack.ps1 -Action Doctor
.\scripts\memory_core_stack.ps1 -Action Start
```

Enter the runtime key only through the masked local prompt. Do not put it in a command, `.env`,
README, profile, log, or issue.

Normal desktop operation uses the component tray entry. `Start` is non-destructive; after source
or migration changes, use the exact-path restart entry. Never kill all Python or PowerShell
processes by name.

## Layered readiness

Check in order:

1. backend listener and `/health`;
2. backend `/version` and representative authorized API read;
3. MCP `/health` and its configured backend URL;
4. MCP `initialize`, `tools/list`, and representative `search`/`fetch`;
5. tunnel `/readyz`;
6. ChatGPT tool discovery and one bounded call.

One HTTP 200, a PID change, or tunnel readiness alone is not end-to-end proof. After MCP schema
changes, ChatGPT may still require Refresh Actions, reconnection, or a new conversation.

## Safe lifecycle recovery

The stack uses bounded retries and component-owned PID metadata. Before stopping a process, verify
its executable, command line, listener PID, component path, and process start time. A stale or
reused PID must fail closed unless ownership can be re-established.

For startup failures:

- backend unavailable: inspect migration state, database access, loopback bind, and backend log;
- MCP unavailable: verify backend health, client token scope, MCP loopback settings, and MCP log;
- tunnel unavailable: verify MCP health first, then profile, DPAPI key status, and tunnel readiness;
- intermittent socket acceptance errors: require multiple consecutive readiness probes before
  declaring recovery;
- foreign listener: do not replace it automatically; identify ownership and resolve the port
  conflict explicitly.

Keep backend, MCP, tunnel, and tray shutdown ownership separate. Exiting the component tray should
stop only the processes it can prove it owns.

## Backup and export

Administrative API operations require explicit scopes:

- `POST /api/v1/admin/export` with `admin:export` writes a credential-free JSON export;
- `POST /api/v1/admin/backup` with `admin:backup` writes a SQLite online backup and manifest.

Verify a backup:

```powershell
uv run python .\scripts\memory_core_admin.py verify-backup `
  .\data\backups\memory-core-YYYYMMDDTHHMMSSffffffZ-xxxxxxxx.db
```

Verification opens the backup read-only and requires `PRAGMA integrity_check=ok`. A successful
integrity check proves database structure, not that the backup is recent enough for the intended
recovery point.

SQLite backups contain private data and credential digests. Encrypt and store them outside Git.

## Restore policy

There is no restore endpoint. Recovery must be an explicit local operation:

1. preserve the current data directory;
2. restore the candidate backup to a new path;
3. verify hash/manifest, SQLite integrity, migrations, and representative counts;
4. start a temporary loopback runtime against the restored copy;
5. verify records, entities, revisions, audit, candidates, collections, and search parity;
6. switch the configured data path only after user confirmation.

Never overwrite the current database as the first recovery step.

## Development validation

For source changes, follow the component AGENTS requirements. The standard suite is:

```powershell
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
```

Migration work also requires empty-database upgrade and downgrade/upgrade round-trip tests. Runtime
or tunnel changes require local protocol and readiness checks in addition to source tests.

## Operational evidence and privacy

Useful evidence includes version, build identity, health state, migration revision, listener role,
tool names, result counts, and bounded error codes. Redact record bodies, candidate content, tokens,
review challenges, tunnel ids, file paths, PIDs, and private logs before sharing.
