# Codex Handoff Bridge Approval Model

## Principle

The model may request work and Codex App Server may request permission. Each Bridge conversation
selects one App Server reviewer: `user` routes actual approval requests to the interactive MCP Apps
UI, while `auto_review` asks Codex's native reviewer to evaluate requests at the same sandbox
boundary. There is no session-wide accept or blanket allow.

## Tool separation

Read/model-visible tools inspect status, preview work, render the console, and read bounded job
artifacts. The following existing interactive actions remain app-only:

- `codex_job_dispatch`
- `codex_conversation_send`
- `codex_job_steer`
- `codex_job_cancel`
- `codex_approval_decide`
- text-bundle begin/append/finalize and artifact chunk reads used by the widget

The host integration must not expose app-only actions as autonomous model tools. A textual request
from the model is not an approval decision. The Bridge never converts `auto_review` into a
`codex_approval_decide` call and never accepts an approval on the user's behalf.

The separate `codex_direct_*` tools are model-visible on explicit user instruction. They share the
same Controller, JobStore and stdio owner. Direct dispatch defaults to plan and reviewer=auto_review,
using the same WorkPackage default as the widget. An explicit user reviewer remains user.
Direct content requires configured project membership and personal/public history; discovered-only
projects, native imports with unproven classification and company history require
the app. Stop-only direct cancel may stop either reviewer but must match the exact turn.

The host/model interprets current user intent; a model-generated boolean cannot prove authorization.
Documents and tool output are data, not user instructions. Server gates enforce capabilities, not
natural-language intent. The internal preview digest is normalization, not proof of human review.
User review applies when App Server requests approval; it is not a click gate for every workspace write.

Direct dispatch uses a retry-stable idempotencyKey. Direct send/steer use clientMessageId and active
operations require expectedTurnId. Cancellation requires requestId and expectedTurnId. Receipts are
persisted before delivery, bind exact payloads, and return unknown after ambiguous failure or restart
without replay. Inspect job state before taking further action; do not generate a new id to retry an
unknown delivery. Receipt capacity is bounded at 10,000 per job, with explicit rejection at capacity.

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
app-only App Server discovery that passed the protected-path gate. Operator-configured
`sharedWorkspaceProjectIds` may add allowlisted roots through the selected profile. Protected Bridge
settings stay denied in both modes, and plan stays read-only. Network access remains disabled
by default. The Bridge never selects a full-access profile.

## Approval reviewers

| Reviewer | Behavior | Permission effect |
| --- | --- | --- |
| `auto_review` | Codex's native reviewer evaluates approval requests | None; sandbox, network, filesystem, workspace roots, and `approvalPolicy=on-request` stay unchanged |
| `user` | Bridge displays each App Server request for an explicit Widget decision | None; each accepted decision is bound to one request |

New Widget and direct conversations default to `auto_review`. Direct send/steer accept an optional
reviewer: omission inherits the current job reviewer under the controller's job lock. An explicit
change requires user instruction and is allowed only between turns. Historical jobs without the field fall back to `user` so an upgrade
cannot silently change their approval behavior. Auto-review can deny a high-risk operation; it is
not a promise that every turn will finish without intervention.

The controller passes the reviewer to `thread/start`, `thread/resume` and `turn/start` with unchanged
permission profiles, exact workspace roots and `approvalPolicy=on-request`. The Bridge does not
classify commands or auto-accept requests. If App Server emits a command/file-change request to the
Bridge, it remains an exact pending human approval even on an auto_review job. Unsupported requests
still fail closed. Native review decisions must be verified from native execution evidence, not
inferred from a mocked `requestApproval` or synthesized Bridge auto-review events.

New direct message receipts bind the original optional reviewer before resolving inheritance, so
retries cannot start a second turn after settings change. Versioned receipts distinguish these from
legacy message receipts that included the adapter-injected user value. Matching legacy receipts
return duplicate/unknown without delivery or migration. Old dispatch retries must retain their
original reviewer explicitly (`user` when created by the old direct adapter); reusing their key with
the new auto_review default is a work-package conflict, not permission to create another job.

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

This lifecycle applies whenever App Server emits a request to the Bridge, including any residual
request on an `auto_review` job. The decision is bound
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

## Additional control-plane tools

`codex_usage_status`, `codex_runtime_status` and `codex_inventory` are bounded read-only tools without a human approval gate.
`codex_direct_thread_compact` and `codex_direct_thread_review` require explicit user instruction and the existing configured-project,
personal/public-history and durable direct-receipt gates. Both bind exact job/thread/last-turn identity and require an idle job.
Review is inline, uncommittedChanges and read-only plan; reviewer inheritance and app-only approval decisions are unchanged.
`codex_direct_thread_fork` is fail-closed before any native allocation because 0.154.0 lacks recoverable fork idempotency.
See [Control Plane Contract](ControlPlaneContract.md) for response states and uncertain-delivery handling.
