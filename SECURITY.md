# Security Policy

## Scope

This is a public source-only monorepo for local MCP components and Windows runtime tooling. Security
reports may concern source code, authentication/authorization, filesystem containment, MCP tool
permissions, local HTTP exposure, tunnel configuration, lifecycle ownership, privacy, or data
integrity.

Runtime data is never part of the public source archive.

## Supported versions

The repository currently has no versioned GitHub releases or long-term support branches. Security
fixes are evaluated against the current `main` source and the component versions recorded in their
manifests. Older local installations may need to update before a fix applies.

## Private reporting

Prefer GitHub's private vulnerability-reporting or Security Advisory flow when it is available for
this repository. Include the smallest reproducible description needed to identify the issue.

If no private reporting channel is available, open a minimal public issue that contains no exploit,
secret, personal data, internal path, tunnel identity, or vulnerable runtime detail, and ask the
maintainer to establish a private channel. Do not publish proof-of-concept exploitation before a
coordinated fix can be prepared.

There is no guaranteed response-time SLA. A useful report clearly states severity, affected
component/version, required preconditions, trust-boundary impact, and a safe reproduction using
synthetic data.

## Never include in a report

- API keys, tokens, cookies, passwords, private keys, authorization headers, or DPAPI ciphertext;
- tunnel ids, generated tunnel profiles, control-plane responses, or private endpoint URLs;
- `.env`, `.secrets`, `.local`, runtime configuration, logs, PIDs, caches, or executables;
- SQLite databases, WAL/SHM, exports, backups, manifests, or private attachments;
- personal memory, study material, financial data, account/institution names, transaction details,
  job content, worktree diffs, or company-confidential information;
- unrestricted directory listings, full environment dumps, or broad process inventories.

Use synthetic fixtures and redact user/machine-specific values. Hashes of secrets or private data
can still be sensitive and should not be included unless they are synthetic.

## Component security boundaries

| Component | Primary boundary |
| --- | --- |
| `project_reading` | Explicit read-only root/asset allowlists, realpath containment, deny policy, bounded output |
| `OMI_search` | Thin read-only adapter; OMI backend owns market facts, freshness, evidence, and decisions |
| `Memory Core` | Scoped API, candidate/reviewer separation, restricted data, revisions/audit, loopback-only runtime |
| `japanese_study` | Bounded adapter over authoritative Hub API; exact ids and idempotent practice writes |
| `codex_bridge` | Project allowlist, app-only dispatch/approval, local App Server, private runtime job store |
| `personal-asset-os` | Local immutable ledger, read-only MCP, loopback API, verified backups, ingest-only mobile staging |
| `mcp_control_center` | Orchestration/observability only; component-owned lifecycle and exact-path process ownership |

Each component's tracked README and security/design documents define its public boundary. Local
Agent or Codex instruction files are checkout-specific operator state and are intentionally not
part of the public source contract.

## Public source rules

The following must stay out of Git:

- local credentials and any usable example value;
- runtime state, private data, logs, PIDs, generated profiles, dependencies, builds, and downloaded
  executables;
- local Agent/Codex instructions, sessions, memories, remote attachments, and agent-run notes;
- private paths or identifiers embedded in documentation/screenshots;
- ignored files force-added with `git add -f`.

Before a public commit or push, inspect the staged file list, staged diff, secret patterns, large
files, and ignored/runtime artifacts. Publication requires explicit user authorization.

## Operational incident guidance

For a suspected local compromise or credential leak:

1. stop exposing the affected external/tunnel path without broad-killing unrelated processes;
2. rotate the affected credential through its owning control plane or local client workflow;
3. preserve minimal local forensic evidence outside Git;
4. verify exact executable/listener/process ownership before stopping a PID;
5. check database integrity and audit/revision state where applicable;
6. restore only from a verified backup into a new path;
7. refresh host action schemas after deploying a corrected MCP contract.

Do not treat HTTP 200, a new PID, or tunnel readiness alone as proof that an incident is resolved.

## Security non-guarantees

These components are local tools, not hardened multi-tenant cloud services. Loopback binding,
allowlists, scopes, redaction, and tunnel isolation reduce risk but do not protect against an
already compromised Windows account, malicious administrator, unsafe custom reverse proxy, or
authorized user intentionally disclosing private data.
