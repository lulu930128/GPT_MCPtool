# Codex Handoff Bridge Job Recovery

## Persisted job state

Each job receives a server-generated UUID directory under `CODEX_BRIDGE_DATA_DIR`:

```text
jobs/<job_id>/
  request.md
  response.md
  manifest.json
  messages.jsonl
  events.jsonl
  inbox/
  diff.patch
  result.json
```

Text staging uses a separate server-generated bundle directory. These files are private runtime
state and are not part of Git.

## Job states

The persisted state model includes:

- active: `queued`, `preparing`, `running`, `awaiting_approval`;
- terminal or recovery-relevant: `completed`, `failed`, `interrupted`, `cancelled`.

Messages and events are append-oriented. Artifact reads are bounded and return metadata including
size and SHA-256 so the widget can retrieve content without injecting it into the model transcript.

## Restart semantics

When the Bridge starts and finds an active job from an earlier process:

- the job becomes `interrupted`;
- pending approvals become `expired`;
- the unfinished Codex turn is not replayed;
- no command, message, or approval is resent automatically.

This avoids duplicate side effects after an uncertain shutdown. It also means restart recovery
requires a user decision.

## Recovery workflow

1. Open the job with `codex_job_get` or the interactive console.
2. Read recent bounded events and messages.
3. Inspect `request`, `response`, `diff`, and `result` artifacts that exist.
4. Inspect the actual allowlisted worktree with trusted local Git tools.
5. Determine whether the earlier turn made partial file changes.
6. Decide whether to continue the same conversation, create a new turn with corrective context, or
   leave the job interrupted.
7. Treat every new approval request as independent; expired approval intent does not carry over.

Do not infer rollback from `interrupted` or `cancelled`. Those states describe controller/turn
state, not filesystem reversal.

## Failure cases

| Symptom | Check | Safe response |
| --- | --- | --- |
| Job remains `preparing`/`running` after restart | Bridge startup events and persisted manifest | Expect conversion to `interrupted`; do not replay automatically |
| Approval disappeared | Approval list and restart time | It should be `expired`; wait for a new exact request |
| Response missing but diff exists | Worktree status and `diff.patch` | Review partial changes before continuing |
| Result exists but UI did not update | Job snapshot/state version and bounded events | Reload snapshot; do not dispatch duplicate job |
| Duplicate user message | `clientMessageId` history | Reuse the same id for identical retry; changed content needs a new id |
| Staged bundle incomplete | Bundle manifest, chunk count, size, SHA-256 | Re-upload/finalize; never dispatch incomplete text |
| App Server unavailable | `doctor:app-server`, same-user Codex login | Repair local App Server launch; do not expose a public listener |

## Runtime validation

```powershell
cd C:\GPT_MCPtool\codex_bridge
npm test
npm run widget:check
npm run smoke:http
npm run doctor:app-server -- "C:\GPT_MCPtool"
```

`smoke:http` does not spend a real Codex turn. The live Codex smoke is opt-in because it consumes a
turn and may create job state:

```powershell
npm run smoke:codex -- --confirm-live-codex
```

## Retention and cleanup

The current version does not automatically remove old job or staging history. Before manually
archiving or removing runtime data:

1. stop the Bridge so files are not active;
2. verify the exact repo-external data directory;
3. preserve jobs that contain needed audit, response, or diff evidence;
4. use a recoverable archive or backup when practical;
5. never copy runtime data into this public repository.

There is no tool that lets an MCP caller delete history.

## Evidence handling

Share only the minimum bounded job metadata needed for diagnosis. Redact project paths, user
messages, source text, diffs, commands, environment data, tokens, tunnel ids, and approval payloads.
Sanitized error class, job state, build id, and event sequence are usually sufficient for first
triage.
