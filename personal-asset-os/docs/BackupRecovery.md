# Personal Asset OS Backup and Recovery

## Backup guarantees

A verified backup is created with SQLite's online backup API and includes:

- a new `.db` backup file;
- SHA-256 digest;
- creation time and file size;
- `PRAGMA integrity_check` result;
- representative table counts used by verification.

This proves the copied database is structurally readable. It does not prove the backup is recent,
complete for the user's intended recovery point, encrypted, or stored off-device.

## Create a backup

```powershell
cd C:\GPT_MCPtool\personal-asset-os
uv run --frozen personal-asset-os backup
```

The default destination is the configured backup directory under
`%LOCALAPPDATA%\PersonalAssetOS`. The dashboard/tray backup action uses the same verified service.

Do not copy a live SQLite file with a generic file-copy command as the primary backup method; WAL
state can make such a copy inconsistent.

## Verify an existing backup

```powershell
uv run --frozen personal-asset-os verify-backup --source "<backup.db>"
```

Reject a backup when the integrity result is not `ok`, the hash/manifest is unexpected, the file is
truncated, or representative counts are implausible.

## Restore to a new path

Restore never overwrites the active database by default:

```powershell
uv run --frozen personal-asset-os restore-backup `
  --source "<backup.db>" `
  --destination "<new-data-dir>\personal_asset_os.db"
```

The destination must not already exist. Restore verifies the source, copies through a temporary
file, checks integrity again, and then atomically places the new destination.

## Recovery acceptance

Before switching `PAOS_DATA_DIR`:

1. preserve the current data directory and configuration;
2. verify the backup and restore into a new directory;
3. run migrations only after reading them and only against the restored copy;
4. start a temporary loopback server using the new directory;
5. compare account, transaction, posting, trade, price, Financial Event, snapshot, reconciliation,
   device, and audit counts;
6. open the dashboard and inspect representative balances, month close, prices, warnings, and
   pending events;
7. run a read-only MCP smoke and confirm no ledger mutation;
8. switch the configured data directory only after explicit user confirmation.

A successful server start or matching total net worth alone is insufficient recovery proof.

## Migration and downgrade safety

Create a verified backup before applying migrations. Runtime does not justify destructive schema
recovery. A migration may refuse downgrade when it would discard paired device credentials,
pairing audit state, or mobile Financial Events; use a verified earlier backup instead of deleting
those rows to force downgrade.

## Storage and retention

Backups contain private financial data and device credential digests. Keep them:

- outside Git and source folders;
- encrypted at rest;
- access-controlled to the user;
- on at least one storage location independent of the active database;
- retained according to a deliberate policy that includes recent and period-close recovery points.

Do not attach backups to public issues or general cloud chats.

## Failure handling

| Failure | Response |
| --- | --- |
| Integrity check fails | Quarantine the file; do not restore it |
| Destination exists | Choose a new empty destination; do not overwrite |
| Restored counts differ | Stop and investigate migration/version/source backup |
| Dashboard totals differ | Compare postings, prices, as-of time, and snapshot quality |
| Mobile device state missing | Verify migration revision and mobile tables before switching |
| Active DB corrupt | Preserve evidence, restore to a new directory, and keep the old files untouched |

## Periodic drill

A backup strategy is accepted only after a restore drill. Periodically restore the newest backup to
a new path and verify the same surfaces used for a real recovery. Record the date and result outside
the public repository without including balances or private paths.
