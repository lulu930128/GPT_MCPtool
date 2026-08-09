# Japanese Study MCP Tool Contract

## Contract principles

- Read tools are `readOnlyHint=true`, `destructiveHint=false`, `openWorldHint=false`.
- Retry-safe write tools are `readOnlyHint=false`, `destructiveHint=false`,
  `openWorldHint=false`, `idempotentHint=true`.
- Exact stable item ids are required for mutations.
- Search text and selectors produce candidates only; ambiguous matches never auto-apply.
- Hub error code, status, retryability, and bounded details cross the adapter unchanged.

## Public tools

| Tool | Kind | Contract |
| --- | --- | --- |
| `study_get_summary` | Read | Return bounded item, label, and attempt counts |
| `study_search_items` | Read | Search vocabulary/grammar/question candidates; limit 1–50, default 20 |
| `study_get_item` | Read | Fetch one exact stable item id |
| `study_get_plan` | Read | Return prioritized study items; limit 1–50, default 20 |
| `study_set_manual_labels` | Idempotent write | Upsert known/unknown/uncertain/suspended labels for exact item ids |
| `study_record_attempt` | Idempotent write | Append one attempt using a caller-stable event id |
| `study_preview_practice_record` | Read | Validate and score a complete practice submission without writing |
| `study_record_practice` | Idempotent write | Atomically save the complete previewed submission using `submissionId` |
| `study_preview_target_resolution` | Read | Normalize selectors and return bounded item candidates |
| `study_list_practice_sessions` | Read | List immutable sessions with filters, summaries, and cursor pagination |
| `study_preview_practice_target_resolution` | Read | Return session fingerprint, unresolved targets, candidates, evidence impact, and duplicates |
| `study_apply_practice_target_overrides` | Idempotent write | Apply exact item-id overrides bound to fingerprint and `operationId` |
| `study_supersede_practice_session` | Idempotent write | Link an immutable corrected session as the current revision |
| `study_get_practice_session` | Read | Read immutable questions, responses, targets, evidence, and score |

## Read behavior

Search output is not mutation authority. A client must show candidates and use an exact stable item
id in a later explicit write. List endpoints remain bounded; callers should use the returned cursor
or pagination fields instead of increasing output without limit.

`study_get_item` and `study_get_practice_session` are the exact readback tools after a write.

## Manual labels

`study_set_manual_labels` changes only the explicitly supplied stable item ids and labels. It does
not infer labels from search rank, practice evidence, score, or answer result. Retry the same
operation with the same idempotency input; changed content requires a new operation.

## Attempts

`study_record_attempt` appends one explicit attempt with a caller-stable event id. The event id
prevents duplicate counting after an uncertain response. An attempt does not silently change
manual labels.

## Complete practice submissions

Use `study_preview_practice_record` before `study_record_practice`. Preserve the complete question
set, void/partial outcomes, answers, targets, scoring evidence, and the same `submissionId` on
retry.

If `answerResult` and `awardedPoints` disagree with the default score policy, recording requires a
non-empty per-question `gradingOverrideReason`. The adapter must not synthesize that reason.

See [PracticeLifecycle.md](PracticeLifecycle.md) for the complete flow.

## Target repair

Target repair is intentionally two-stage:

1. `study_preview_practice_target_resolution` returns the current session fingerprint and bounded
   candidate evidence.
2. After explicit user confirmation, `study_apply_practice_target_overrides` accepts only exact
   item ids, the unchanged fingerprint, and a retry-stable `operationId`.

The apply tool cannot search, guess, rebuild evidence, or replace a target that is already resolved.

## Error classes

Clients should distinguish:

- validation or malformed input;
- unknown stable id or session;
- ambiguous/candidate-only resolution;
- stale fingerprint or version conflict;
- idempotency conflict;
- score-policy mismatch requiring an override reason;
- Hub authentication/authorization failure;
- Hub unavailable or timeout;
- adapter protocol/serialization failure.

Only the last category is inherently an MCP transport failure. Preserve the Hub's structured domain
error for expected business conditions.

## Verification after write

Do not treat HTTP success alone as completion:

- read the exact item after label/attempt changes;
- fetch the session after recording or superseding;
- confirm the same `submissionId` or `operationId` retry did not duplicate state;
- verify target refs and evidence after override;
- confirm health `contractVersion`, `toolCount`, and `buildId` when a schema changed.
