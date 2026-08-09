# Memory Core MCP Tool Reference

## Registration model

All tools use closed-world annotations (`openWorldHint=false`). Read tools are non-destructive.
Proposal tools create pending candidates and are idempotent but do not write formal memory.
Approval is the only outward tool category marked destructive because it can commit reviewed
changes.

Reviewer tools appear only when a separate reviewer credential is configured. The legacy
`memory_create_candidate` tool is hidden by default and should remain disabled outside a temporary
migration window.

## Stable identifiers

- Record: `record:<id>`
- Entity: `entity:<id>`
- Update/archive operations also require the exact current version returned by `fetch`.
- Historical revision reads use a record ref plus explicit revision number.
- Collection membership returns record refs; use `fetch` for full content.

## Read-only tools

| Tool | Purpose and important limits |
| --- | --- |
| `search` | Search authorized Records/Entities with bounded filters and diagnostics; default limit 20 |
| `fetch` | Read one stable ref with bounded external projection and explicit truncation metadata |
| `memory_fetch_record_revision` | Read one immutable Record revision and report requested/current version |
| `memory_list_record_links` | Read current inbound/outbound Record Link projection, optionally including removed links |
| `memory_overview` | Return counts, taxonomy, schema/index status, and reviewer-visible candidate counts without memory bodies |
| `memory_detect_duplicates` | Return bounded duplicate candidates and reasons; never merge or archive automatically |
| `memory_list_collections` | List visible Collection metadata; default limit 50, maximum 100 |
| `memory_get_collection` | Read bounded Collection membership; default limit 100, maximum 500 |

Search and fetch enforce the caller's scopes. Archived stable refs remain fetchable when authorized
and are explicitly marked archived.

## Generic proposal tools

These tools create one pending candidate:

- `memory_propose_record_create`
- `memory_propose_record_update`
- `memory_propose_record_archive`
- `memory_propose_entity_create`
- `memory_propose_entity_update`
- `memory_propose_entity_archive`

Update/archive require exact target ref and base version. Archive may include a reviewed
same-type `merged_into_ref`. Record proposals may include reviewed Entity links; Entity proposals
may include reviewed relations.

## ChangeSet tools

- `memory_propose_change_set`
- `memory_propose_cocktail_change_set`

A ChangeSet proposes multiple Record create/update operations. Only schema-registry reference
fields may use `op:<op_id>`. Approval applies the set atomically and returns one result per
operation.

## Typed Cocktail tools

- `memory_propose_cocktail_recipe_create`
- `memory_propose_cocktail_recipe_update`
- `memory_propose_cocktail_tasting_create`
- `memory_propose_cocktail_tasting_update`
- `memory_propose_cocktail_preference_create`
- `memory_propose_cocktail_preference_update`

These expose fixed typed payloads and reuse backend validation. Recipe, Tasting, and Preference
remain Records under `domain=lifestyle.cocktail`; a Tasting may pin an immutable Recipe revision.
Invalid typed input is rejected before a candidate is created.

## Typed Batch tool

`memory_propose_media_experience_batch` accepts 1 to 50 typed `galgame`, `anime`, or `manga`
experience Items. It creates one pending Batch; it does not create formal Records until review and
approval. Ambiguous identity and same-batch duplication are blocked rather than guessed.

## Conditional reviewer tools

| Tool | Effect |
| --- | --- |
| `memory_list_candidates` | List bounded candidate summaries, default limit 20, maximum 100 |
| `memory_get_candidate` | Read exact/redacted review projection and review digest |
| `memory_get_batch_candidate` | Read Batch metadata and a paginated Item page, maximum 50 items per page |
| `memory_prepare_candidate_review` | Prepare a short-lived challenge for one exact digest; not approval |
| `memory_approve_candidate` | Apply the reviewed candidate and return verifiable result refs/versions |
| `memory_reject_candidate` | Reject the reviewed candidate without writing formal data |

See [CandidateReview.md](CandidateReview.md) before exposing reviewer tools to a host.

## Result semantics

- Tool results provide MCP `structuredContent` plus a text JSON fallback.
- Expected validation, temporal, conflict, not-found, redaction, and review-gate failures are
  structured results; callers should use their error codes and fields.
- Formal proposal tools return pending candidate identity and review metadata, not a claim that the
  data was saved.
- Batch approval may partially succeed by Item. Inspect aggregate state and every Item result.
- A transport success is not persistence proof; fetch and verify result refs after approval.

## Tool selection guidance

- Use `search` to obtain stable refs, then `fetch` exact items.
- Use revision/link/collection tools only when the question needs those explicit relationships.
- Use the narrowest typed proposal tool available; use generic proposal tools only for registered
  schemas that lack a typed facade.
- Use ChangeSet when cross-operation references or all-or-nothing semantics are required.
- Use Batch when many typed Items need independent decisions and item-level retry.
- Never request reviewer tools simply to bypass a local-review requirement.
