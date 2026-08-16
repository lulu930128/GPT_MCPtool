# Japanese Study MCP Architecture

## Role

`japanese_study` is a bounded MCP adapter for the authoritative Japanese Study Hub. It exposes a
curated tool contract to ChatGPT and other MCP clients without giving them direct access to study
files, Anki, SQL, imports, or the Hub database.

```text
MCP client
  -> japanese_study adapter
  -> versioned Japanese Study Hub HTTP API
  -> Hub services and authoritative database
```

The adapter is not a second study system and must not copy Hub domain rules or persistence.

## Ownership

| Concern | Owner |
| --- | --- |
| MCP schemas, annotations, HTTP/STDIO transport | `japanese_study` adapter |
| Tool-to-API field mapping | `japanese_study` adapter |
| Vocabulary/grammar/question data | Japanese Study Hub |
| Stable item ids and search semantics | Japanese Study Hub |
| Practice scoring, atomic submission, idempotency | Japanese Study Hub |
| Learner policy, learning context and question-selection evidence | Japanese Study Hub |
| Practice target evidence and fingerprint | Japanese Study Hub |
| Practice revision linkage and SRS projection rebuild | Japanese Study Hub |
| Database, migrations, imports, Anki integration | Japanese Study Hub |
| Tunnel/tray process lifecycle | Adapter component scripts |

The adapter preserves Hub domain error `code`, HTTP `status`, `retryable`, and bounded `details`.
It must not replace them with guessed success or generic transport messages.

## Runtime topology

Default loopback endpoints:

| Role | Default |
| --- | --- |
| Hub API | `http://127.0.0.1:18791` |
| MCP endpoint | `http://127.0.0.1:18790/mcp` |
| MCP health | `http://127.0.0.1:18790/health` |
| Tunnel readiness | `http://127.0.0.1:18792/readyz` |

The Hub API is not exposed through the tunnel. The tunnel forwards only the MCP endpoint.

The MCP listener defaults to loopback. A non-loopback MCP bind requires
`JSTUDY_MCP_HTTP_TOKEN`; a remote Hub URL must use HTTPS and must not embed credentials in the URL.

## Deployment identity

MCP health reports:

- `contractVersion` — the adapter/Hub contract identity;
- `toolCount` — the currently loaded public tool count;
- `buildId` — the core artifact identity.

Launchers compare all three. HTTP 200 alone does not prove the latest `dist` or schema is loaded.
After a build or tool change, validate health identity and raw MCP `tools/list`.

## Data and write boundary

Read tools may query bounded Hub views. Write tools are limited to explicit, retry-safe domain
operations:

- set manual labels for exact stable item ids;
- append one attempt with a caller event id;
- record one complete previewed practice submission with a stable `submissionId`;
- replace the learner-owned policy after explicit confirmation with a stable `operationId`;
- atomically record and supersede one corrected complete practice submission;
- apply explicitly confirmed practice target overrides bound to a preview fingerprint and stable
  `operationId`;
- supersede an immutable practice session with an explicit corrected revision for compatibility.

The bounded learning-context read may guide an AI-generated exercise, but generation remains in
the client. Context retrieval does not authorize recording and never exposes the full catalog.

Search and resolution previews return candidates only. They never authorize a mutation.

## Excluded capabilities

The adapter intentionally has no arbitrary filesystem, SQL, shell, HTTP proxy, delete, reset,
bulk import, catalog administration, evidence rebuild, general resolver, Anki write, or legacy
migration tools.

Those operations remain in the authoritative Hub CLI or local administration workflow, where
their data and review boundaries can be enforced.

## Secret and logging policy

- Hub API token, MCP HTTP token, tunnel id, control-plane key, generated profile, DPAPI ciphertext,
  PID, and logs stay out of Git.
- Do not log authorization headers, tokens, full study content, or complete tool payloads.
- STDIO mode must keep stdout reserved for JSON-RPC and use stderr for diagnostics.
- `.env.example` documents variable names only; the adapter does not automatically load `.env`.

## Change rule

A new Hub capability should first receive a versioned Hub API contract and domain tests. The
adapter may then add the narrowest useful MCP projection, with explicit annotations, stable ids,
bounded output, error preservation, and retry semantics. It must not implement missing Hub logic
locally.
