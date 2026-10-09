# Codex Handoff Bridge Threat Model

## Purpose and boundary

Codex Handoff Bridge is a private, allowlist-first engineering handoff channel. It lets a user move
an explicitly reviewed text work package from ChatGPT to a local Codex App Server and review the
result, diff, and individual approval requests.

It is not a mechanism for bypassing employer policy, workspace restrictions, upload controls,
network policy, or data-classification requirements.

## Protected assets

- Allowlisted project paths and their source worktrees.
- Job requests, user messages, Codex responses, events, diffs, results, and approval state.
- Staged text bundles, job inbox copies, and read-only `codex-inbox` handoff copies.
- Codex login/session inherited by the local App Server.
- MCP HTTP token, tunnel credential/profile, local configuration, logs, and runtime metadata.

Runtime assets live under `CODEX_BRIDGE_DATA_DIR` and are not source archive content.

## Trust zones

```text
ChatGPT host
  -> MCP Apps widget
  -> Bridge HTTP MCP :18828
  -> project capability gate + job/staging stores + ignored codex-inbox
  -> local controller
  -> Codex App Server over stdio
  -> selected project + optional operator-configured shared roots + read-only codex-inbox
```

- ChatGPT and the widget are outside the local filesystem trust boundary.
- Public tools accept a configured `project_id`; the app-only widget may use an opaque project id
  resolved from Codex App Server history. Neither surface accepts a caller-supplied path.
- Codex App Server is local and stdio-only; it is not exposed through a public WebSocket.
- The Secure MCP Tunnel reaches the Bridge MCP endpoint, not the App Server or job directory.

## Accepted data classifications

Text bundles require one explicit classification:

- `personal` — content the user owns and may transfer;
- `public` — public information suitable for the channel;
- `company_approved` — company-related content whose transfer was explicitly authorized.

Unapproved company data does not have an accepted classification. A checkbox or label does not
override an employer or workspace policy.

## Main threats and controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| Arbitrary local path access | Ignored project allowlist, validated project ids, realpath directory checks, filesystem-root rejection, and a fixed server-generated handoff root | An overly broad approved project still exposes that workspace to Codex |
| Model exceeds user intent or approves its own work | Direct actions require explicit user intent, configured projects and personal/public history; user reviewer uses app-only decisions, auto_review delegates to Codex's separate native reviewer with unchanged sandbox | Host/model interprets natural language; server cannot prove user intent from tool arguments. Native auto-review is not a deterministic security guarantee; app-only visibility requires host enforcement |
| Session-wide approval | Exact `jobId` + `approvalId`; no session-wide accept | A user can still approve a risky exact request without reading it |
| Replay or duplicate dispatch | Preview digest and idempotency key | A compromised widget session may replay still-valid exact input |
| Text corruption during upload | Per-chunk and whole-bundle SHA-256, length, MIME, filename, project, and classification checks | SHA-256 proves transport integrity, not that content is safe |
| Secret upload | Hard-secret pattern rejection and stored/logged-value redaction | Novel or unstructured secrets may evade patterns |
| Path traversal in filenames | Server-generated ids; filenames reject separators, `..`, controls, and unsupported extensions | Malicious plain text can still contain misleading instructions |
| Public App Server exposure | Controller starts App Server over local stdio only | A custom unsupported launcher could weaken the boundary |
| Stale approval after restart | Pending approvals become expired; active jobs become interrupted and are not auto-replayed | User must decide how to resume or replace interrupted work |
| Hidden network activity | Bridge selects Codex permission profiles with network disabled by default | Workspace code or an approved command can still have side effects within granted policy |
| Runtime data enters Git | Repo-external data directory and ignored local configuration | Manual copying or support bundles can still leak data |

## Text bundle controls

- At most eight input bundles may be attached to one turn.
- One bundle is limited to 500,000 characters and 2,000,000 UTF-8 bytes.
- The accepted extensions are `.txt`, `.md`, `.log`, `.json`, `.yaml`, `.yml`, `.diff`, and
  `.patch`.
- Each chunk is bounded and indexed; finalization checks declared size, complete chunk set, and
  full SHA-256.
- Staging, job, and handoff paths are server-generated. Callers cannot choose a local destination.
- Codex receives a server-generated `.tmp/codex-inbox/<job_id>/...` path plus the same validated text
  as an inline fallback. The selected profile makes the handoff root read-only; staging and job directories
  remain inaccessible and the handoff root is not a runtime workspace root.

Plain text remains untrusted. The local Codex instruction hierarchy and project `AGENTS.md` still
govern whether text is treated as context or a request.

## Execution modes

- `plan` uses `codex-bridge-read-only`, which inherits `:read-only` and adds exact read access to the
  handoff root. A file-change approval cannot be accepted in this mode.
- `workspace_write` uses `codex-bridge-workspace`, which inherits `:workspace`, adds the same exact
  read access, and keeps approval policy `on-request` with network access disabled by default.
- The Bridge never selects `danger-full-access`.

The optional `sharedWorkspaceProjectIds` setting adds only validated allowlist paths as profile-defined
workspace roots. It applies to every Bridge job; it does not make plan mode writable. Both profiles deny
the component's `.local`, `.env`/`.env.*`, `.secrets`, `.tunnel-client`, the actual projects file,
the job data directory, and the shared `project_reading/.secrets` tunnel credential store. These protected
directories cannot be selected through native workspace discovery. Source files remain editable.
Native Windows requires the elevated sandbox backend, selected only for the Bridge child process.
Deny globs are expanded before sandbox startup; newly created secret files require a reload before new work.
Profiles constrain sandboxed local execution; separately approved escalations and external MCP tools have
their own controls. Editable Bridge source is trusted operator code, not an immutable security boundary.

`workspace_write` does not guarantee a prompt before every individual file edit. Use `plan` first
when strict diff-before-apply review is required.

## Secret and telemetry policy

The Bridge redacts known secret-shaped keys and strings before storage or display, bounds event
content, and does not retain model reasoning/token streams. It stores user messages, final
responses, bounded technical events, and artifacts needed for the job record.

Do not place credentials in a bundle or rely on redaction. Do not share `.local/projects.json`,
`.tmp/codex-inbox`, job folders, staging content, tunnel profiles, tokens, logs, or full environment variables.

## Deployment checklist

1. Allowlist only projects authorized for remote handoff.
2. Keep App Server local over stdio.
3. Keep Bridge and tunnel listeners loopback-bound where applicable.
4. Use a dedicated tunnel id; do not reuse another component's id.
5. Keep interactive dispatch and manual approval tools app-only; direct tools cannot decide approvals.
6. Use `plan` for first inspection of unfamiliar work.
7. Review exact command/file-change approval text before accepting.
8. Treat job, staging, and `.tmp/codex-inbox` folders as private data and back them up only when necessary.

## Out of scope

This threat model does not make unauthorized data transfer acceptable, does not sandbox arbitrary
approved commands beyond the Codex permission profile, and does not replace host OS account,
filesystem, Git, backup, or endpoint security.
