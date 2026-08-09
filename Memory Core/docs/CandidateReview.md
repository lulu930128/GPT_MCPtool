# Memory Core Candidate Review

## Principle

A candidate is a reviewable proposal, not formal memory. Creating, listing, viewing, editing,
summarizing, or preparing a candidate does not approve it.

```text
explicit save request
  -> proposal tool creates pending candidate
  -> reviewer reads exact content and review_digest
  -> reviewer prepares short-lived challenge
  -> user explicitly approves that exact candidate
  -> reviewer applies candidate
  -> client fetches every result_ref and verifies id/type/version
```

If content changes, create a new candidate and review digest. Do not approve replacement content
under an earlier digest.

## Credential separation

- Proposal clients use `candidates:create` and normal read scopes.
- Reviewer clients use a separate token with `candidates:review`.
- The normal MCP token must not contain review authority.
- Reviewer authority does not grant direct record/entity write access.
- `restricted` content requires separately designed and assigned restricted scopes.

Reviewer tools are registered only when the MCP process receives a separate reviewer token.

## Candidate states

The common terminal transitions are:

```text
pending -> applied
        -> rejected
        -> conflict
        -> expired
```

Candidates normally expire after seven days. A conflict or expiry must be surfaced; it must not be
silently converted into a fresh proposal or automatic retry.

## Review surface

Before any approval:

1. Read the candidate with `memory_get_candidate` or, for a Batch,
   `memory_get_batch_candidate`.
2. Confirm status is pending and the full page of relevant content is visible.
3. Inspect operation type, target/base version, proposed content, warnings, risk flags, references,
   and `review_digest`.
4. Check `display_mode`, `redacted_fields`, and `remote_approval_allowed`.
5. For paginated Batch detail, load all items. A partial page is not an approvable full review.

When content is redacted or cannot be shown exactly, remote review must stop and route to the
trusted local reviewer.

## Prepare is not approval

`memory_prepare_candidate_review(candidate_id, expected_review_digest)` creates a reviewer-bound,
short-lived challenge. The challenge normally expires after ten minutes.

Prepare verifies that the candidate and digest are still current. It does not mutate formal memory
and must not be described to the user as approval, save, apply, or completion.

## Approval

`memory_approve_candidate` requires:

- the same candidate id;
- the exact expected review digest;
- the prepared challenge;
- a retry-stable review idempotency key;
- optional bounded review note.

Approval does not accept replacement content. Generic candidates, ChangeSets, and Batches keep
their own executor semantics, but all are bound to the reviewed content.

After success, verify:

- `result_id`, `result_type`, and `result_version`;
- each `result_ref` with `fetch`;
- every ChangeSet `results[]` entry;
- every Batch item result, `verified_at`, aggregate execution state, and failed-item retry policy.

Do not report completion from HTTP 200, candidate status alone, or the existence of a result id.

## Rejection

`memory_reject_candidate` uses the same digest/challenge discipline. Rejection does not create
formal memory. Retry the same rejection with the same idempotency key; do not reuse that key for a
different action, candidate, or review note.

## Idempotency and concurrency

- Proposal tools require retry-stable idempotency keys.
- Same client, same key, same payload returns the prior candidate.
- Same key with different content is a conflict.
- Update/archive proposals use an exact target ref and base version.
- Approval/rejection retries reuse the same review idempotency key.
- A changed target version, digest, challenge, action, or note must not be hidden by retry logic.

## ChangeSet semantics

A ChangeSet groups multiple Record operations in one candidate. Registered `op:<op_id>` references
may connect operations within the same set. The executor validates references and dependency
cycles, then applies the ChangeSet atomically: all operations commit or all roll back.

The result contains one entry per operation. Verify all entries rather than only the first result.

## Batch semantics

A Batch contains 1 to 50 typed Items. Each Item has its own normalization, decision, operation,
claim, result, post-commit readback, and retry state.

Batch application is item-atomic, not whole-batch atomic. One Item may commit while another fails.
Review the aggregate fields and every item:

- `batch_execution_state` and per-state counts;
- `any_item_committed`;
- successful result refs and versions;
- `failed_items[]` and each retry policy;
- verification timestamps.

Do not retry successful Items or imply that partial success was a rollback.

## Failure handling

| Condition | Required response |
| --- | --- |
| Digest changed | Re-read the candidate; do not reuse the old challenge |
| Challenge expired | Prepare a new challenge after reviewing the still-current candidate |
| Candidate expired | Create a new candidate only after the user restates the save intent |
| Version conflict | Fetch current target state and present the conflict; do not auto-merge |
| Redacted review surface | Route to trusted local review |
| Batch partial failure | Verify successful Items and follow each failed Item's retry policy |
| Network uncertainty after approval | Query candidate/result state before retrying with the same idempotency key |

## Host integration rule

A host must never let the same model silently propose and approve its own content. The user-facing
flow must clearly separate proposal, exact review, prepare, explicit approval/rejection, and
post-commit verification.
