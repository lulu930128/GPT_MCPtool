# Personal Asset OS Security and Privacy

## Security objective

Personal Asset OS keeps formal personal financial data on the user's machine, maintains an
auditable ledger, and exposes only bounded read models to remote AI clients.

## Protected data

- accounts, transactions, postings, trades, prices, observations, snapshots, audits, and Financial
  Events;
- paired mobile-device identity, pairing state, token digests, sequence numbers, and event hashes;
- database, WAL/SHM, backups, manifests, logs, PIDs, `.env`, tunnel profiles, and credentials;
- dashboard/API responses and MCP results derived from the user's finances.

Formal data defaults to `%LOCALAPPDATA%\PersonalAssetOS`. None of these assets belongs in Git.

## Trust boundary

```text
Desktop UI / USB mobile ingest
  -> loopback REST API
  -> domain services
  -> local SQLite ledger

ChatGPT
  -> private outbound Secure MCP Tunnel
  -> read-only /mcp
  -> existing read models only
```

- Dashboard and REST API bind to loopback only.
- The tunnel forwards read-only `/mcp` and does not forward dashboard or REST write routes.
- Mobile writes use local USB/ADB reverse to the loopback API; they do not use the MCP tunnel.
- MCP and AI cannot create, edit, reverse, finalize, or approve transactions.

## Ledger integrity controls

- Formal truth is immutable `transactions + postings`.
- Every transaction is balanced and validated by the ledger service.
- Corrections use reversal/adjustment, not history overwrite.
- Idempotency protects retries; same key with changed content is a conflict.
- Financial Events remain staging until desktop finalization succeeds.
- Mobile input remains ingest-only and cannot finalize ledger entries.

See [LedgerModel.md](LedgerModel.md).

## Remote MCP boundary

The seven MCP tools are read-only and closed-world. Results preserve as-of time, price provider,
price quality, missing/stale warnings, and reconciliation state. They do not expose raw import
payloads or posting-level transaction details.

Tunnel readiness does not authorize a write route. Do not add a broad HTTP proxy or dashboard route
to the tunnel profile.

## Mobile security

- Pairing uses a single-use code that expires after ten minutes by default.
- Desktop stores only hashes of pairing codes and device tokens.
- The raw device token is returned once and stored in Expo SecureStore/Android Keystore.
- Requests require a Bearer token whose device id matches the payload.
- Canonical payload SHA-256, device id, local sequence, event id, and idempotency key protect retry
  and conflict handling.
- Revocation invalidates the token but does not delete historical event/audit evidence.
- Cleartext HTTP is permitted only for `127.0.0.1`/`localhost` through USB/ADB reverse.

See [MobileSync.md](MobileSync.md).

## Secrets

`.env.example` contains unusable placeholders only. Real OpenAI keys, tunnel credentials, device
tokens, pairing codes, authorization headers, and DPAPI files must not appear in source, docs,
commands, logs, screenshots, support bundles, or public issues.

The OpenAI readiness check sends a fixed synthetic marker and no personal finance payload. It may
consume API quota and runs only when explicitly invoked.

## Backup privacy

Backups contain full personal financial data. A valid hash and integrity check do not make them safe
to publish. Store them encrypted, outside Git, with access at least as strict as the live database.

Restore writes to a new destination and never overwrites the active database by default. See
[BackupRecovery.md](BackupRecovery.md).

## Threats and controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| AI modifies finances | Read-only MCP; no mutation schemas | A future proposal feature would require a new local approval design |
| Public dashboard/API | Loopback bind validation | A user-created reverse proxy could bypass this boundary |
| Duplicate capture/finalize | Idempotency, payload hash, device sequence, event version | Wrong new ids can still represent duplicate real-world events |
| Mobile token theft | SecureStore, digest-only desktop storage, revocation | An unlocked compromised phone may use its live token |
| Silent stale valuation | Provider/as-of/quality/age and explicit warnings | Manual prices can still be wrong |
| Ledger corruption | Service invariants, migrations, audit, verified backups | OS-level file access can still alter SQLite |
| Backup loss/disclosure | Online backup, hash, integrity, new-path restore | Storage encryption and retention remain operator responsibilities |
| Secret leakage in Git/support | Ignore rules, placeholder examples, bounded status | Manual copying or screenshots can still leak data |

## Public reporting checklist

Share only synthetic/demo data. Redact account names, institutions, descriptions, merchants,
amounts, timestamps, device ids, paths, tokens, tunnel ids, database files, backups, and logs. A
small error code and sanitized schema shape are preferable to a full runtime response.
