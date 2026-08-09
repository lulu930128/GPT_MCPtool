# Memory Core Security and Privacy

## Security objective

Memory Core is a local-first, single-user system of record. Its primary objective is to preserve
private data integrity and auditability while allowing bounded clients to search, fetch, and propose
changes without receiving direct database authority.

```text
MCP / Kuro / local UI
       -> scoped Memory Core API
       -> application services
       -> SQLite + FTS + revisions + audit
```

Clients must not open SQLite directly. API and application-service transactions are the only
formal persistence boundary.

## Protected assets

- Record, Entity, Tag, Relation, Revision, Audit, Candidate, Batch, Item, Collection, and search
  data.
- Client credential digests and scope assignments.
- SQLite database, WAL/SHM files, exports, backups, manifests, attachments, and runtime logs.
- Candidate proposed content, review digests, prepared challenges, review notes, and result refs.

The source repository may contain schema, migrations, tests, examples, and documentation. It must
not contain any protected runtime asset.

## Data that does not belong in Memory Core

Do not store passwords, API keys, tokens, cookies, private keys, raw company-confidential data, or
arbitrary secret blobs. Company-derived information must be separately authorized and reduced to a
human-reviewed, de-identified summary before proposal.

Kuro runtime state, model reasoning, thread state, transient briefing snapshots, and tool logs are
not long-term memory unless a user explicitly creates a reviewable candidate for suitable content.

## Authentication and scopes

Client tokens are shown once when created. The database stores only a SHA-256 digest. Tokens must
stay in a local secret store or process environment and must not appear in `.env`, Git, logs, audit
details, documentation, command history, or error payloads.

Use separate credentials for separate authority:

| Client purpose | Typical minimum scopes |
| --- | --- |
| Read-only client | `records:read`, `entities:read` |
| Proposal client | Read scopes plus `candidates:create` |
| Reviewer | `candidates:review` only |
| Restricted reader/writer | Explicit `restricted:read` or `restricted:write` in addition to the relevant operation scope |
| Administrative export/backup | Explicit `admin:export` or `admin:backup` |

The reviewer token must not reuse the normal MCP token. `candidates:review` does not grant general
record/entity read or write authority.

## Restricted data

`restricted` content requires a separate scope. A client without `restricted:read` must not learn
the body through search, fetch, historical revision, link traversal, duplicate detection, candidate
detail, error text, or count side channels beyond the API's authorized projection.

Do not add `restricted:write` to a remote reviewer unless a distinct trusted review flow has been
designed and tested.

## Candidate boundary

AI and ordinary MCP clients do not write formal records directly. They may create pending
candidates. Formal data changes only after a separate reviewer sees the exact review surface,
prepares a short-lived challenge, explicitly approves that same digest, and verifies the committed
result.

Redacted candidate output is not the exact digest input. When `display_mode=redacted` or
`remote_approval_allowed=false`, remote approval must fail with `candidate_requires_local_review`.
See [CandidateReview.md](CandidateReview.md).

## External projection

MCP output uses a bounded external projection:

- Windows absolute paths, user-home paths, and path-shaped fields are redacted.
- New MCP proposals containing machine-local paths are rejected before they reach the backend.
- `fetch` and candidate details have explicit size limits and truncation metadata.
- Search diagnostics remain bounded and must not expose secret query context.

Redaction reduces accidental disclosure but is not a data-classification engine. Do not submit
secret material and rely on redaction to make it safe.

## Network boundary

- Backend, MCP, viewer, and tunnel-admin listeners are loopback-only.
- The MCP settings reject non-loopback API targets and non-loopback MCP binds.
- ChatGPT access uses an outbound Secure MCP Tunnel; it does not require an inbound firewall port.
- The tunnel forwards the MCP target only. It must not expose the backend API, SQLite, viewer, data
  folders, backups, or admin endpoints.
- A public website, if built later, may read only a separate public snapshot. It must never connect
  to the private database.

## Backup and export sensitivity

JSON export excludes client credentials, but its memory content remains private. SQLite backups
contain all formal data and credential digests and must be encrypted and access-controlled like the
primary database.

Every backup must be created through SQLite's online backup API and pass `PRAGMA integrity_check`.
There is intentionally no remote restore endpoint. See [Operations.md](Operations.md).

## Threats and controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| Stolen client token | Scoped credentials, digest-only storage, separate reviewer token | A live token can act within its scope until revoked |
| AI self-approval | Candidate-only proposal tools and separate reviewer credential | A poorly designed host could still expose reviewer actions to the wrong user |
| Approval of unseen content | Exact review digest, short-lived challenge, redaction gate | Local reviewer integrity still matters |
| Direct SQLite mutation | API/service ownership and migrations | An OS-level user with file access can still alter local files |
| Path disclosure | External projection and proposal rejection | Novel path formats may require additional tests |
| Public network exposure | Loopback validators and outbound tunnel | Misconfigured external reverse proxies remain outside this control |
| Secret leakage through logs | Structured bounded errors and no-token policy | Operators must review external wrappers and support bundles |
| Corrupt backup | Online backup, hash/manifest, integrity verification | A valid but outdated backup can still lose newer changes |

## Operator checklist

1. Create least-privilege clients and keep reviewer credentials separate.
2. Keep `data/`, `.env`, exports, backups, logs, PIDs, tunnel profiles, and DPAPI files out of Git.
3. Bind only to loopback and use the reviewed tunnel path for remote MCP.
4. Inspect migrations before applying them; runtime never auto-migrates.
5. Review exact candidate content and digest before prepare/approve.
6. Verify every result ref and version after approval.
7. Create and verify a backup before risky maintenance.
8. Never paste a token, candidate secret, database, or private support bundle into a public issue.
