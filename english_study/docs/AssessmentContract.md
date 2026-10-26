# IELTS Assessment v2

English Study MCP 0.4.0 provides 17 tools. Hub 0.3.0 uses schema 2.
The additive `english-learning-v1` envelope is retained so historical generic
practice fingerprints remain compatible. Nested assessment documents use the
Hub's canonical snake_case fields; existing practice envelopes use camelCase.

## Recording and score meaning

Use `english_preview_practice_record` then `english_record_practice` with the
same input and returned fingerprint. Supply exactly one of:

- `submission`: the existing session/questions object plus optional `assessments`.
- `listeningResult`: the completed `listening-result-v2` object retrieved from Trainer.

An assessment has stable `assessment_id`, `system=IELTS`, `module`, `skill`,
`scope=task|section|skill`, exact `question_keys`, completeness, source kind/ref,
scoring method, assessor/model version, `estimated`, rubric/version, metrics,
diagnostics, feedback, grading policy version and timezone-aware `assessed_at`.
Band values are nullable or finite half bands from 0 to 9. A missing band is
not zero. Generic practice remains independent of assessments.

Writing task assessments distinguish Task 1 `task_achievement` from Task 2
`task_response`; both require the other three rubric criteria when a rubric is
provided. Task 1 applies to Academic and General Training. A complete Writing
skill practice requires both task assessments. No task-to-skill rounding policy
or four-skill overall score is invented. Scores are supplied by the named
assessor; this feature stores and validates assessments, it does not call a model.

Rubric-only questions use `answerResult=unscored`, `awardedPoints=0`,
`maxPoints=0`. Desktop shows unscored instead of treating this as an incorrect
answer. Essays remain in `answer`, for example `{ "text": "..." }`.
Reported official results remain **caller-supplied**; there is no certification
or external verification. All other assessment methods require `estimated=true`.

`diagnostics` require `kind=observed|hypothesis`, question references and a
bounded evidence explanation. They do not create study items or alter mastery.

## History and progress

`english_list_practice_sessions` supports practiceType, assessmentSystem, skill,
module, dateFrom/dateTo, limit (1–100) and offset. Date bounds require a timezone
and use `[from, to)`. Sorting is completion instant descending then stable
session ID descending. The response has total/count/limit/offset/has_more.
List projections contain no essays or answer keys; exact detail includes them.

`english_get_ielts_progress` groups evidence by module, skill, scope, source,
assessor and policy. It returns latest evidence, bounded history, sample counts,
diagnostics and descriptive score differences. It does not equate differences
with ability gains or average incompatible tasks. A truncated result reports
`has_more`; callers can narrow the date window. Missing evidence is explicit.

## Listening integration and failure recovery

Trainer owns raw grading and immutable completed attempts. The caller obtains
`listening_get_attempt_result` and passes the completed result unchanged to
English Study preview/record. Hub derives stable session/submission IDs from
set/attempt identity and stores a unique source link in the same transaction.
If saving times out, retrieve the attempt and retry: the per-batch submission ID
is excluded from the normalized result identity. Changed results conflict.
The Hub validates result totals, identity and times; it does not authenticate
the caller as Trainer and records `verification=caller_supplied` explicitly.

Generated sets are not calibrated IELTS papers, even when they contain 40 marks.
They therefore save raw scores and `overall_score=null`. A separately supplied
assessment may carry an explicitly estimated band with its named policy/source.
Audio, models and cache remain with Trainer/Voice Runtime.

## Migration and immutability

Schema 1→2 takes a SQLite backup under the personal database directory's
`backups/` before additive DDL, checks integrity and foreign keys, and records a
migration report. Failure rolls back schema and user_version. Re-running does
not repeat the migration. Existing session/question/response rows are retained.
Absent assessments/source are omitted from canonical hashing to preserve v1 retries.

Sessions and assessment snapshots are immutable. Revision linkage columns are
reserved for a future separately reviewed reassessment workflow; this release
does not expose a score-editing endpoint or silently replace historical grades.
Rollback after new writes requires preserving those writes; do not overwrite a
live database with the pre-migration backup. An old Hub refuses schema 2.

## Verification

Run `npm test`, `npm run smoke:http`, and `npm run smoke:ielts`.
Before the last command build Listening Audio, then set `IELTS_HUB_ROOT`,
`IELTS_TRAINER_ROOT`, and `IELTS_TEST_PYTHON` to the installed source projects
and an existing Python with Hub dependencies. The test creates two ephemeral
loopback APIs and real MCP adapters; data stays under `english_study/.tmp`.
It never writes production study data or synthesizes audio by default.

Scoring references: [IELTS scoring](https://ielts.org/take-a-test/your-results/ielts-scoring-in-detail)
and [Writing format](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-writing).
