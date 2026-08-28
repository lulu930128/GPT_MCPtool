# Codex Handoff Bridge Approval Model

## Principle

The model may request work and Codex App Server may request permission. Each Bridge conversation
selects one App Server reviewer: `user` routes actual approval requests to the interactive MCP Apps
UI, while `auto_review` asks Codex's native reviewer to evaluate requests at the same sandbox
boundary. There is no session-wide accept or blanket allow.

## Tool separation

Read/model-visible tools inspect status, preview work, render the console, and read bounded job
artifacts. Actions that can start, alter, interrupt, or authorize work are app-only:

- `codex_job_dispatch`
- `codex_conversation_send`
- `codex_job_steer`
- `codex_job_cancel`
- `codex_approval_decide`
- text-bundle begin/append/finalize and artifact chunk reads used by the widget

The host integration must not expose app-only actions as autonomous model tools. A textual request
from the model is not an approval decision. The Bridge never converts `auto_review` into a
`codex_approval_decide` call and never accepts an approval on the user's behalf.

## Dispatch approval

Before dispatch, `codex_job_preview` normalizes the work package and produces a digest without
creating a job. The widget shows the project, objective, context, constraints, acceptance criteria,
execution mode, approval reviewer, model/effort, and attached bundle metadata.

Dispatch requires the reviewed preview and a retry-stable idempotency key. If the form changes,
preview again. Do not dispatch a digest produced for earlier content.

## Execution modes

| Mode | Codex permission profile | Approval behavior |
| --- | --- | --- |
| `plan` | Read-only | File-change approval cannot be accepted |
| `workspace_write` | Workspace-scoped | Exact command/file-change requests may be accepted individually |

Both modes use one server-resolved exact project path: either a configured allowlist entry or an
app-only App Server discovery that passed the protected-path gate. Network access remains disabled
by default. The Bridge never selects a full-access profile.

## Approval reviewers

| Reviewer | Behavior | Permission effect |
| --- | --- | --- |
| `auto_review` | Codex's native reviewer evaluates approval requests | None; sandbox, network, filesystem, workspace roots, and `approvalPolicy=on-request` stay unchanged |
| `user` | Bridge displays each App Server request for an explicit Widget decision | None; each accepted decision is bound to one request |

New conversations default to `auto_review`. The reviewer is sticky for that thread and can be
changed only between turns. Historical jobs without the field fall back to `user` so an upgrade
cannot silently change their approval behavior. Auto-review can deny a high-risk operation; it is
not a promise that every turn will finish without intervention.

## Per-request user-review lifecycle

```text
Codex App Server requests permission
  -> Bridge stores pending approval under one job
  -> job status becomes awaiting_approval
  -> widget displays kind and exact request details
  -> user selects accept / decline / cancel
  -> codex_approval_decide(jobId, approvalId, decision)
  -> controller replies to that exact App Server request
```

This lifecycle applies when reviewer is `user` and App Server emits a request. The decision is bound
to one `jobId` and one UUID `approvalId`. Unknown, already resolved, expired, or wrong-job ids are
rejected.

## Decision meanings

- `accept` — authorize this exact pending request only.
- `decline` — deny this exact request and let the active turn handle the denial.
- `cancel` — cancel this exact approval request; it is not permission to run a substitute command.

None of these decisions authorizes future requests, another command, another file change, another
turn, or another job.

## Restart and stale approval behavior

On Bridge restart:

- every pending approval is marked `expired`;
- active jobs are marked `interrupted`;
- unfinished turns are not automatically replayed;
- an old UI decision cannot approve the restarted process's future request.

The user must inspect current job state and explicitly start or resume appropriate work. Do not
convert expired approvals into new pending approvals without a new App Server request.

## Steering and cancellation

Steering adds user direction to a running turn. It does not grant permission for an approval
request. Cancellation interrupts the running turn; it does not roll back file changes already made
inside the workspace.

After cancellation or failure, inspect the aggregated diff and Git status before starting another
turn.

## Review checklist

When using `user` review, before accepting a command or file-change request:

1. Confirm the selected project and job.
2. Read the exact command or change summary and affected path.
3. Check that the action matches the objective and execution mode.
4. Reject broad process termination, destructive Git, secret access, publishing, or unrelated
   paths unless those actions were separately and explicitly authorized.
5. Prefer `plan` when the intended diff is not yet understood.
6. After completion, inspect the reported diff and verification evidence.

## Known limitation

In `workspace_write`, Codex's workspace permission profile determines which file operations require
App Server approval. With `user` review, the Bridge displays requests that App Server actually
emits; it cannot promise that every file edit receives a separate prompt. With `auto_review`, the
native reviewer may reject operations without presenting an accept button. Strict staged-patch
review is not implemented.
