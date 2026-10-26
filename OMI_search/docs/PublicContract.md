# OMI Search Public Contract

## Responsibility

`OMI_search` is a thin MCP adapter with read-only market tools and a narrow protected runtime-control exception. It owns MCP protocol handling, the public tool
surface, safe schema projection, compatibility aliases, HTTP transport, and forwarding to the OMI
backend.

```text
MCP client
  -> OMI_search
  -> GET  /api/ai/tools      (schema owner)
  -> POST /api/ai/ask        (decision owner)
  -> GET  /api/ai/refresh-status/{job_id} (redacted job status)
  -> unchanged omi.decision.v4 response
```

The OMI backend owns target resolution, market semantics, trading calendars, freshness,
provider fallback, evidence, limitations, warnings, decision logic, refresh orchestration, tool
budget enforcement, and response shaping. The adapter must not duplicate or reinterpret them.

## Public tools

`tools/list` exposes twenty tools: the existing seventeen remain compatible and exactly three adapter-owned runtime tools are additive, both online and in offline fallback.

| Tool | Mechanical mapping |
| --- | --- |
| `omi_ask` | Canonical caller-supplied question and target |
| `omi_read_refresh_status` | Positive `job_id` to the dedicated redacted refresh-status endpoint |
| `omi_read_market_overview` | `target.type=market` and `mode=data_only` |
| `omi_read_stock_context` | Market-specific stock target and `mode=data_only` |
| `omi_read_data_freshness` | `target.type=data_freshness` and optional market |
| `omi_read_source_health` | `target.type=source_health` plus explicit filters |
| `omi_read_capability_status` | `target.type=capability_status` plus explicit filters |
| `omi_read_tw_market_dashboard` | Cache-only `GET /api/market/tw-dashboard/snapshot` |
| `omi_open_tw_market_dashboard` | Render the complete prepared `omi.tw_market_dashboard.v1` snapshot without backend IO |
| `omi_search_tw_symbols` | Bounded local `GET /api/market/tw-dashboard/symbols/search` |
| `omi_read_tw_stock_dashboard_detail` | Cache-only focused OHLC, backend MA, and technical detail |
| `omi_read_tw_workspace_header` | Generated cache-only workspace header GET route |
| `omi_read_tw_workspace_watchlist` | Generated cache-only selected watchlist GET route |
| `omi_read_tw_workspace_hot_groups` | Generated cache-only hot groups GET route |
| `omi_read_tw_stock_chart` | Generated cache-only stock chart GET route |
| `omi_read_tw_stock_research` | Generated cache-only stock research GET route |
| `omi_open_tw_workspace` | Render-only shell with empty or optional initial selection; no backend IO |
| `omi_read_runtime_status` | Fixed `GET /api/system/runtime-control/status`; no arguments |
| `omi_restart_backend` | Fixed protected `POST /api/system/runtime-control/restart-backend`; exactly two UUIDs and literal confirmation |
| `omi_read_runtime_operation` | Fixed `GET /api/system/runtime-control/operations/{request_id}`; UUID only |

The runtime exception is specified in [RuntimeControl.md](RuntimeControl.md). Only an explicit user restart request
may invoke the disruptive tool. Management credentials are local environment only, never MCP inputs or outputs.
The adapter forwards to the existing backend controller and performs no OS/process control, DB access or provider calls.

`omi.search` remains callable only as a legacy compatibility alias and is omitted from
`tools/list`. Only that alias may translate `query`, `stock_id`, or `symbol` into canonical
fields.

## Fixed trust fields

Every forwarded `omi.ask` request fixes:

```json
{
  "contract_version": "omi.decision.v4",
  "caller_profile": "omi_search",
  "allow_llm": false,
  "allow_write": false
}
```

The caller cannot override those fields. The adapter accepts `mode=data_only|brief|full`, but it
does not expose backend analysis/report modes that require LLM execution or write permission.

`refresh_if_missing` defaults to `false`. Only the literal boolean `true` maps to
`allow_external_fetch=true`; strings, inferred intent, stale-looking output, or a question asking
for live data do not enable refresh.

### Caller choice for current Taiwan preopen quotes

For a user-authorized CURRENT Taiwan preopen single-stock quote question (盤前, 試撮,
or 試搓), the MCP AI caller should explicitly choose `quote.auction` as the primary
capability in `selection.include`. Supporting `quote.snapshot`, `quote.order_book`,
and `data.freshness` may be requested via `selection.optional`. Preserve the user's
original `question`; this is caller guidance, not adapter semantic routing.

When a live update is intended and both user authorization and policy permit it, make
the first `omi_ask` call explicit, for example:

```json
{
  "question": "台股 2221 現在盤前試撮報價？",
  "target": {"type": "tw_stock", "id": "2221"},
  "selection": {
    "include": ["quote.auction"],
    "optional": ["quote.snapshot", "quote.order_book", "data.freshness"]
  },
  "realtime_policy": "prefer_live",
  "refresh_if_missing": true,
  "tool_budget": {
    "max_calls": 3,
    "max_external_fetches": 2,
    "max_total_seconds": 20
  }
}
```

These budget values are a bounded caller example, not new adapter defaults or a
guarantee of completion. Keep `refresh_if_missing=false` for cache-only, retrospective,
or explicit no-refresh requests; use `realtime_policy=cache_only` for cache-only reads.
`prefer_live`, the question text, or missing cached evidence never grants fetch authority
by itself. The adapter mechanically maps only the explicit boolean alias; OMI owns
budget enforcement and refresh execution. No LLM, write, or broker permission is granted.

After `NO_SNAPSHOT`, callers must distinguish cached data not yet fetched from a provider
being unavailable or a valid indicative match being unavailable. The authoritative reason
comes from OMI v4 evidence and `execution.refresh_reconciliation`; a cache miss alone
does not prove provider failure or that no market data exists. A follow-up with explicit
refresh is appropriate only when a live update is intended and user/policy permission
exists. Refresh permission or completion does not guarantee an auction value: order-book
evidence may be available while a valid indicative match is unavailable. Report only what
the returned evidence supports, retaining uncertainty when no reason is established.
The adapter forwards the canonical v4 response unchanged and never rephrases these states.

## Schema ownership and fallback

At runtime, the adapter reads the canonical `omi.ask` and `omi.read_refresh_status` schemas from OMI backend
`GET /api/ai/tools`. It removes caller-selectable trust flags and adds only adapter-owned
compatibility fields.

`public_contract_snapshot.json` is an offline fallback, not a second schema authority. It must be
generated by the OMI repository script and must not be hand-edited. Contract review should compare
the live digest, generated snapshot, and adapter projection.

`include_intraday` and `intraday_limit` are structural aliases for nested
`market_data_params`. Existing nested values win; the adapter does not clamp or semantically
validate backend-owned parameters.

`include_raw` is deprecated and compatibility-only. The adapter always returns the canonical
`omi.decision.v4` response unchanged.

## Response and error semantics

The following v4 rules apply to market tools. Runtime tools instead return the unchanged backend object inside
`response`, alongside `http_status` and `transport_status`; no runtime output schema is invented or added to
backend-generated market snapshots. HTTP 202 is queue acceptance only. Valid JSON HTTP rejections (including
403, 409, 503) remain inspectable responses; adapter/transport errors use `isError=true` and fixed safe codes.

- A valid backend response must be an object with `contract_version=omi.decision.v4`.
- The response is returned in MCP `structuredContent` and as a text JSON fallback.
- Business outcomes such as `TARGET_NOT_FOUND`, missing evidence, partial data, stale data, or a
  blocked refresh remain structured v4 results with `isError=false`.
- Adapter input errors, transport failures, serialization failures, or a non-v4 backend response
  are MCP failures with `isError=true`.
- Freshness, `status`, `limitations`, `warnings`, `missing`, and
  `execution.refresh_reconciliation` must remain visible. The adapter must not turn an attempted
  refresh into a claim that data became current.
- Refresh operation completion and rebuilt evidence are separate states. Consumers must use the
  returned cache-only resume template to rebuild evidence before claiming that data is current.

## HTTP transport

The local Streamable HTTP endpoint is `/mcp`, implemented by the official Python MCP SDK. The SDK
owns initialization, protocol negotiation, JSON-RPC framing, request validation, and transport
lifecycle. The adapter does not maintain a second handwritten dispatcher.

The negotiated legacy wire projection adds only `type: "object"` to
`omi_read_tw_stock_research.outputSchema`: both generated `anyOf` branches already
require objects, but the SDK's legacy result validator requires an explicit root
type. All `$defs`/`$ref`/union constraints, the generated snapshots, and the original
catalog remain unchanged. Modern `2026-07-28` receives the exact generated schema.
The SDK still owns version sieving; restart annotations and its disruptive `_meta`
survive both tested versions. See [the offline reproduction](RuntimeControl.md#toolslist-協定修復驗證2026-10-14).

- Current clients negotiate the SDK's current protocol and use the sessionless Streamable HTTP flow.
- Exact legacy `2025-06-18` clients remain supported. They must preserve the returned
  `Mcp-Session-Id` and reuse it for later requests.
- Both flows expose the same resources, tools, structured business results, and adapter failures.

## MCP Apps UI resource

- URI: `ui://omi/tw-market-dashboard/v2.html`
- MIME: `text/html;profile=mcp-app`
- additional URI: `ui://omi/tw-workspace/v1.html`;
- only `omi_open_tw_market_dashboard` and `omi_open_tw_workspace` declare `_meta.ui.resourceUri`, each binding its corresponding URI;
- data/search/detail tools remain independently useful without UI;
- the resource has no direct network allowlist and calls backend-owned tools through the MCP Apps bridge;
- `tw_market_dashboard_contract_snapshot.json` is generated from OMI backend Pydantic models and supplies exact tool `outputSchema` values.

The generated `workspace_tools` entries own progressive tool paths, path parameters, GET methods,
input/output schemas, descriptions and annotations. The adapter only replaces dots in tool names
with underscores, URI-encodes path parameters and serializes explicitly supplied query parameters.
It does not supply omitted backend defaults, clamp values, or reinterpret business outcomes.
Null optional query values are omitted. Returned envelopes and evidence remain unchanged.

The new opener accepts `{}` or optional `stock_id`, `timeframe`, `watchlist_group_id` selection.
These field schemas are selected mechanically from the generated tools; the opener owns only
the render selection envelope. Both resources share a bundle; a server-provided HTML marker
selects the progressive app, leaving the legacy dashboard flow available.

Workspace panes call the bridge directly and independently without an LLM or a whole-dashboard
prerequisite. Header/watchlist/chart use 30-second completion-based polling; hot groups/research
use 120 seconds. Each pane retains its own loading, failure, retry and evidence state. Old chart
data stays visible with explicit identity while the pending target loads; request generations
and abort signals discard late completions. Research never blocks chart paint. Pane timestamps
may differ and must never be presented as an atomic snapshot.

Chart creation/removal depends only on symbol/timeframe identity or mount/unmount. Points and
backend MA changes use series refs/setData, preserving visible range. Latest/All are explicit
range controls. Host fullscreen support and the legacy 20-second bridge timeout are retained.
No execution/trading UI or tool is introduced by the workspace.

`/health` identifies the adapter build. `/upstream-health` performs a bounded check of the selected
OMI backend without exposing credentials or full upstream errors.

## Explicit non-goals

The public adapter does not provide LLM reports, streaming ask, memory mutation, save/persist,
database access, provider calls, arbitrary HTTP, market-data reconciliation, or direct write tools.
Those capabilities must not be added by expanding the adapter surface.
