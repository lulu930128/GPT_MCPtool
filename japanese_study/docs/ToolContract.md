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
| `study_search_items` | Read | Search item-level candidates across canonical content, proposals, aliases, and components; limit 1–50 |
| `study_get_item` | Read | Fetch one exact item with bounded canonical/proposal/alias/component detail |
| `study_preview_item_creation` | Read | Compute identity and return exact/possible duplicates |
| `study_create_item` | Idempotent write | Create the unchanged previewed vocab/grammar draft |
| `study_preview_item_revision` | Read | Compare editable meaning/content/tags before and after |
| `study_apply_item_revision` | Idempotent write | Append the confirmed revision and audit metadata |
| `study_preview_item_lifecycle` | Read | Preview reversible retire/restore and replacement relation |
| `study_apply_item_lifecycle` | Idempotent write | Apply confirmed retire/restore without deletion |
| `study_get_quality_inbox` | Read | List missing/incomplete/proposed meaning/alias/component/unresolved quality work |
| `study_get_due_reviews` | Read | List bounded SRS due items without marking reviewed |
| `study_list_study_lists` | Read | List imported, inbox, and custom lists |
| `study_create_study_list` | Idempotent write | Create one typed custom list |
| `study_add_study_list_items` | Idempotent write | Add exact same-kind item ids to a list |
| `study_preview_question_candidates` | Read | Generate deterministic candidate payloads |
| `study_save_question_candidate` | Idempotent write | Save a candidate in pending state |
| `study_promote_question_candidate` | Idempotent write | Promote one manually reviewed candidate |
| `study_retire_question_candidate` | Idempotent write | Retire a rejected candidate while preserving audit |
| `study_get_plan` | Read | Return prioritized study items with optional explicit catalog `targetLevels`; limit 1–50, default 20 |
| `study_get_learner_policy` | Read | Read the current learner-owned generation and recording policy |
| `study_set_learner_policy` | Idempotent write | Replace that policy after an explicit user request and stable `operationId` |
| `study_get_learning_context` | Read | Return bounded item targets, skill weaknesses, strengths, observations, recent practice, and explicit level scope |
| `study_get_diagnosis_catalog` | Read | Search up to 100 Hub-owned canonical diagnosis definitions without mutation |
| `study_set_manual_labels` | Idempotent write | Upsert known/unknown/uncertain/suspended labels for exact item ids |
| `study_record_attempt` | Idempotent write | Append one attempt using a caller-stable event id |
| `study_preview_practice_record` | Read | Validate and score a complete practice submission without writing |
| `study_record_practice` | Idempotent write | Atomically save the complete previewed submission using `submissionId` |
| `study_record_practice_revision` | Idempotent write | Atomically save a complete corrected submission and supersede the original |
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

Under `learning-content-v8.1`, `meaning_tc` remains canonical. A
`meaning_tc_proposal` is always accompanied by proposal status and must not be
presented as accepted content. Verified aliases may resolve exact grammar
identities; proposed aliases and all search matches remain candidate-only.
Component detail is bounded and preserves stable `component_key` values for
sense/collocation evidence.

## Item authoring and lifecycle

Use `study_preview_item_creation` before `study_create_item`. The preview fingerprint covers the
normalized stable identity and complete draft. Exact duplicates cannot be created; possible
duplicates must be shown to the user. Proposed ChatGPT or external content remains explicitly
proposed and appears in the quality inbox.

Use the revision preview/apply pair only for meaning, content, and tags. Title, reading, grammar
pattern, and sense identity are stable. Correct a bad identity by creating the right item, then
previewing and applying retirement of the old item with an optional same-kind replacement.

All lifecycle operations retain the item and revision history. They are not delete tools.

## Lists, due review, and question bank

Custom lists declare one `kind`; adding mismatched item ids is rejected. The due tool only reads
the Hub-owned SRS projection. Attempts and practice evidence update schedules through the Hub;
MCP callers do not calculate intervals.

Question generation is staged: preview deterministic candidates, save selected candidates as
`pending`, then promote only after a human review note. Retirement records rejection without
deleting the candidate. No model-generated candidate becomes formal merely because it was saved.

## Manual labels

`study_set_manual_labels` changes only the explicitly supplied stable item ids and labels. It does
not infer labels from search rank, practice evidence, score, or answer result. Retry the same
operation with the same idempotency input; changed content requires a new operation.

## Learner policy and generation context

`study_get_learner_policy` is the single learner-owned source of truth for question-generation and
automatic-recording preferences. `study_set_learner_policy` requires an explicit user request;
the adapter must not infer a policy change from one answer, score, or generated exercise.

`study_get_learning_context` is the bounded input for AI question generation. It returns policy,
item-level recommended targets, Hub-calculated cross-item skill weaknesses, strengths,
observations, explicit canonical/proposal status, verified components, and active recent practice.
`requestedLevel` remains a practice profile. Explicit `targetLevels` override it; when omitted, the Hub
expands a known profile such as `N4_N3_BRIDGE` to canonical catalog levels. Unknown planning profiles
fail explicitly instead of becoming an unrestricted catalog. The context read does not
dump the full catalog, generate questions inside the Hub, or authorize a later write. Generated
practice is recorded only when the returned policy and the current user instruction allow it.

`study_get_diagnosis_catalog` is an optional bounded lookup for canonical diagnosis codes. The Hub
returns code, skill, polarity, severity, planning default, title, and active state. The adapter only
forwards filters and never creates aliases or decides diagnosis semantics. Unknown submitted codes
remain safe non-planning observations when a client skips the lookup.

## Attempts

`study_record_attempt` appends one explicit attempt with a caller-stable event id. The event id
prevents duplicate counting after an uncertain response. An attempt does not silently change
manual labels.

## Complete practice submissions

Use `study_preview_practice_record` before `study_record_practice`. Preserve the complete question
set, void/partial outcomes, answers, targets, scoring evidence, and the same `submissionId` on
retry.

For practice contract v2, set `practiceContractVersion=2`, use question-scoped
`diagnosisEvents`, and provide an `assessment` for every target, including an explicit
`unassessed` result when no target judgment exists. Only target-specific, planning-eligible
assessments create item evidence or reach SRS. Legacy v1 remains readable but multi-target v1
questions do not fan one overall result across every item.

If `answerResult` and `awardedPoints` disagree with the default score policy, recording requires a
non-empty per-question `gradingOverrideReason`. The adapter must not synthesize that reason.

See [PracticeLifecycle.md](PracticeLifecycle.md) for the complete flow.

When a correction is already known, use `study_record_practice_revision` with the full corrected
submission. The Hub records the replacement, creates the supersession link, and rebuilds affected
SRS projections in one transaction. Do not call `study_record_practice` first for that correction.
The older record-then-supersede pair remains for compatibility and deliberate administration.

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
- read the exact item/list/candidate after workbench mutations;
- verify target refs and evidence after override;
- confirm health `contractVersion`, `toolCount`, and `buildId` when a schema changed.
