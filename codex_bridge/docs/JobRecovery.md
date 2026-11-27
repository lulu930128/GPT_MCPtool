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
  conversation.json
  conversation.json.bak
  conversation-events.jsonl
  conversation-events.jsonl.index   # derived checkpoint seek hint
  manifest.json.pending             # only while publishing a job event
  inbox/
  diff.patch
  result.json
```

Text staging uses a separate server-generated bundle directory. Validated attachments also have a
server-generated, read-only mirror under `.tmp/codex-inbox/<job_id>/` for Codex file-path access.
These files are private runtime state and are not part of Git.
Legacy `.local/codex-inbox` copies are retained but denied to sandboxed commands. On the next artifact
read, JobStore verifies the durable inbox content and recreates the mirror at the current handoff root.

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

Startup indexes job manifests. The first reader of a conversation checks the primary and backup,
then validates the contiguous journal from a verified checkpoint offset. Legacy journals and changed
or invalid hints are streamed from their beginning. A partial final record can be repaired by the store
owner. Middle corruption or a gap is reported for that job. A durable journal commit publishes the
cursor even when checkpoint promotion fails. The next flush can promote that same revision.
The index is disposable. History, event sequence numbers and job IDs stay in their original files.

A prepared manifest event binds the target job, original idempotency key, state version, sequence,
event bytes and file offset. After an interrupted write the same owner can finish an exact matching
prefix and publish the manifest. A different suffix leaves the job in reconciliation-required state.
Following a native disconnect or controller restart, a read of the exact original native turn can settle
its terminal outcome. A missing turn, a still-running detached turn, or an unavailable native process
leaves the Bridge interruption in place. Expired approvals require a fresh native request.

## Reading pipeline evidence

Use the existing `codex_runtime_status` tool with a configured project. The optional `pipeline` request
reads saved diagnostic samples through the Bridge. Supply the job and poll IDs to join a specific
Widget observation. Omit both IDs for process-level records. Each read returns up to 50 records from
the current retained generations. With an older installed version use its existing operational log.

```json
{"projectId":"<configured-project-id>","pipeline":{"jobId":"<job-uuid>","pollId":"<poll-uuid>","limit":10}}
```

The owner writes `diagnostics/runtime.jsonl` and suffixes `.1` through `.3` under the configured
data directory. On Windows the following local read isolates process evidence without dumping any job
files. Set `$dataDir` to the configured runtime data directory first.

```powershell
Get-Content -LiteralPath (Join-Path $dataDir 'diagnostics/runtime.jsonl') -Tail 5 -Encoding utf8 |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Select-Object at,event,instance,pid,buildId,monotonicMs,memory,gc,loopP99Ms,workload,groups
```

Match UTC time and build/instance/PID before comparing counters. Monotonic milliseconds and cumulative GC
counts are process-local. Heartbeat groups are one-minute windows. Anomaly or exit records can include a
running window, so adding all records will double count. Stage counts measure receipts at different
boundaries. Match poll, revision, thread and turn before attributing a lag. The HTTP byte delta measures
socket traffic during a response, including framing. GPU/render presentation, native service internals and
the Host's internal queue are outside that timer. Stream bytes are measured at ingress when supplied by
the transport, otherwise queued text uses a UTF-16 estimate. Projection/index estimates and process RSS
are distinct from retained heap. A heap snapshot would be required to attribute retained object size.

The Widget includes its previous observation on the next read. Local keys `bridge.poll.last`,
`bridge.poll.applied`, `bridge.poll.timeout`, `bridge.poll.transport_failed` and `bridge.poll.visibility`
can distinguish the last successful read, a failed read, and a suspended tab in the same session.
A fully disconnected or destroyed iframe may leave no server acknowledgment. Storage availability and
lifetime depend on the Host. The most recent sample per stage/reason/job is retained with aggregate counts.
Missing samples can reflect rotation, write failures, aggregate replacement, or a missing acknowledgment.
Read `overwrittenBytes`, `writeFailures`, `droppedGroups`, `evictedPollTraces` and `droppedHttpErrors`
alongside the samples. On abrupt process death the last window may be incomplete.

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
| Conversation checkpoint malformed | `conversationDiagnostics`, checkpoint/journal revisions | Recover from validated backup plus contiguous journal; never replace with an empty projection |
| Journal gap or middle corruption | Structured persistence error code | Fail closed, preserve files, and diagnose exact revision metadata without exposing transcript content |

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

The current version does not automatically remove old job, staging, or `codex-inbox` history.
Before manually archiving or removing runtime data:

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

## Native continuation and downgrade (V2.1 candidate)

A saved goal or queued submission can survive loss of the native writer. With the official 0.172.0 App Server, a new writer successfully resumed a thread and automatically executed the pending work using the new writer's model and effort. A resume can therefore have execution side effects before Bridge verifies the returned settings. Even resuming with the original model used low effort when the new writer omitted the effort. Supplying config.model_reasoning_effort restored high in both native controls. Bridge includes that override on a normal continuation with a selected effort. A pre-read of the goal and queue covers work already visible to Bridge. It cannot fence a concurrent native owner. Bridge omits queue submission and goal activation from its app controls until those turns have enforceable execution settings.

When a reply to thread/start or turn/start is lost, retain the job, thread if known, request phase and original client message ID. Use the owner's reconciliation loop or an exact late RPC reply. If no thread ID was recovered from thread/start, manual reconciliation can remain necessary. A second dispatch under a fresh ID can create a second job. For existing chat messages the retry receipt can show unknown while a local submission is waiting, failed when the original start failed, or duplicate after matching native acceptance.

The V2.1 manifest intent can include message bytes and terminal export effects. Before downgrading, close admission, drain writers and allow the candidate owner to finish outstanding manifest intents. Check durable requests and the exact native thread's queue/goal state separately. The old reader was tested on fully committed synthetic archives. Its recovery code cannot replay the candidate's additional side effects from an unfinished intent. Preserve a recoverable copy if the handoff stops partway. No live store was migrated during candidate verification.

## Continuation after a failed native turn (0.172.0)

The job event `codex.resume.verification` joins the local request, thread and previous native turn with the owner's observations. Read its phase, initial/resume/passive status, latest native turn ID/status, direct-input capability, writer evidence and permission field differences. Each settings stage reports its notification and readback count. An exact initial settings snapshot can authorize a no-op with zero additional settings readbacks. The event omits prompts, native error bodies and sandbox paths.

A loaded thread can remain in `systemError` after a quota failure. Continuation requires the exact previous failed native turn, a writable session for direct input, verified profile/sandbox/reviewer/policy and empty automatic-work checks. When the previous attempt failed before turn/start and the manifest has cleared its turn ID, Bridge uses the committed conversation projection to identify the prior turn. A readback reporting an in-progress turn, changed head, another writer, an unconfirmed status or inconsistent permissions stops the new action. An unloaded thread requires a verified rejoin. An unsubscribe receipt alone does not establish unload.

Use the original request ID to inspect the delivery outcome. `action_not_sent` describes a gate failure before the requested turn, compact or review. `settings_verified` records the gate result. The subsequent native request, exact turn ID and terminal history establish action delivery and completion. During unknown delivery, use V2.1 reconciliation and the original client message ID. Use the installed Workspace owner for maintenance after the active Bridge job has finished.
