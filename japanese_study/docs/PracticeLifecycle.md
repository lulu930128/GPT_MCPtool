# Japanese Study Practice Lifecycle

## Goals

Practice records are immutable, complete, retry-safe evidence. A client must preserve the user's
questions, answers, scoring provenance, target resolution, and correction history rather than
rewriting earlier attempts in place.

## Record a practice session

```text
completed session
  -> study_preview_practice_record
  -> show validation, score, void/partial state, and warnings
  -> explicit save request
  -> study_record_practice with stable submissionId
  -> study_get_practice_session readback
```

### Preview

Preview is read-only. It validates the full Hub submission contract and may report:

- missing or malformed question data;
- unresolved target candidates;
- score totals and policy mismatch;
- void, partial, or completed result state;
- duplicate or idempotency-relevant information.

Preview does not create a session or change item labels.

### Record

Recording is atomic. Reuse the same `submissionId` when retrying the same complete payload after a
timeout or uncertain response. The same id with different content is an idempotency conflict and
must be shown to the user.

Do not retry by generating a new id until the existing submission has been queried; otherwise the
same practice may be counted twice.

### Score provenance

`answerResult` and `awardedPoints` normally follow the Hub score policy. When they differ, the
specific question must carry a non-empty `gradingOverrideReason`. This is human provenance, not an
adapter-generated explanation.

## Resolve or repair practice targets

Search selectors are candidate-only. They may not directly mutate a session.

```text
existing session
  -> study_preview_practice_target_resolution
  -> inspect unresolved targets, candidates, evidence impact, duplicates, fingerprint
  -> user confirms exact item ids
  -> study_apply_practice_target_overrides
       expected fingerprint + stable operationId + exact itemId values
  -> study_get_practice_session readback
```

The preview fingerprint binds the apply request to the exact session state that was reviewed. If
the session changes, preview again. The adapter must not ignore a stale fingerprint.

An override can fill an unresolved target; it cannot replace an already resolved target, perform a
catalog search during apply, or guess from the highest-ranked candidate.

## Correct an immutable session

Do not update a recorded session in place. Create the corrected complete session, then use
`study_supersede_practice_session` to link it as the current revision of the earlier session.

```text
old immutable session
  -> corrected immutable session
  -> explicit supersede link
  -> list/get shows correction lineage and current revision
```

Superseding is not deletion. Historical evidence remains available for audit and scoring lineage.

## Single attempts versus practice sessions

`study_record_attempt` is for one explicit item attempt with a stable caller event id.
`study_record_practice` is for an entire multi-question session with atomic, complete scoring
context. Do not decompose a complete session into unrelated single-attempt calls when the Hub
practice contract applies.

Neither operation synthesizes manual known/unknown labels.

## Retry matrix

| Situation | Safe action |
| --- | --- |
| Preview validation fails | Correct input; no write occurred |
| Record request times out | Query by session/idempotency context, then retry same `submissionId` and payload |
| Same `submissionId`, different payload | Stop and surface conflict |
| Target fingerprint stale | Run preview again and request confirmation again |
| Override request times out | Retry same `operationId`, fingerprint, and overrides |
| Candidate search ambiguous | Ask for exact selection; do not auto-apply |
| Score policy mismatch | Require a per-question human `gradingOverrideReason` |
| Correction required | Record corrected immutable session, then explicitly supersede |

## Write-test safety

`npm run smoke:practice` and other Hub write smoke commands change data. They refuse to run unless
the explicit write-test environment flag is set. Run them only against a loopback Hub backed by a
disposable database, never against the user's authoritative study data by default.
