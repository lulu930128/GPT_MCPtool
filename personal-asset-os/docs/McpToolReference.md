# Personal Asset OS MCP Tool Reference

## Contract

The MCP server exposes seven read-only tools. Aggregate/accounting values are decimal strings in
TWD. Broker positions may additionally carry USD `native_price` and `native_market_value` facts.
Callers must preserve as-of time, valuation quality, price age, missing/stale warnings, broker
read mode, account mapping, and reconciliation state. The server has no ledger mutation tool.

## Tools

### `get_asset_overview`

Returns aggregate dashboard read models:

- `as_of` and `base_currency`;
- overall quality;
- asset, liability, cash, investment, income/expense, and related metrics;
- valuation detail and warnings;
- a `broker` block describing KGI status, read mode, source time, opaque account reference,
  TWD market value, native-currency totals, FX fact, and reconciliation counts.

This is a provisional view when prices or reconciliation evidence are missing/stale. Do not call it
live net worth without checking the returned quality and warnings.

### `list_asset_accounts`

Lists account metadata and ledger-derived balances. System accounts are excluded by default;
`include_system=true` includes them.

Liability `display_balance` is sign-adjusted for presentation. The underlying debit-positive ledger
balance remains authoritative.

### `list_asset_positions`

Lists the effective investment read model. Ledger-only rows remain trade-derived. When KGI is
available, KGI rows include `position_source=kgi_broker`, broker source time, reported market value,
and `reconciliation_status`; a mapped matching Ledger position contributes book cost but is not
also counted as a second market value.

US rows preserve `native_currency=USD`, native price/value, settlement currency, and FX metadata.
Only a traceable, sufficiently fresh USD/TWD fact creates `market_value` in TWD. If FX is missing,
the native USD value remains visible while `valuation_included=false`; callers must not invent a
conversion rate.

Missing price keeps market value unavailable rather than substituting zero. `broker_unrealized_pnl`
is broker reference evidence and never replaces PAOS book P/L.

### `list_recent_asset_transactions`

Lists immutable transaction headers in reverse time order. `limit` defaults to 10 and is bounded
from 1 to 50.

The result intentionally omits posting-level details. It includes transaction id, occurrence and
record times, description, source, status, and reversal link.

### `get_pending_financial_events`

Returns bounded summaries of `pending_match` and `needs_review` Financial Events. `limit` defaults
to 20 and is bounded from 1 to 50.

The contract is `paos.capture.read.v1`. It excludes raw import payloads and cannot finalize, edit,
reject, or approve an event.

### `get_reconciliation_status`

Returns the latest reconciliation evidence, unresolved count/total, detailed reconciliation read
model, and warnings. An unresolved difference is evidence of a mismatch; it is not an instruction
to overwrite a balance.

### `get_asset_system_status`

Returns non-secret service version, build id, base currency, HTTP policy, MCP policy, and OpenAI
configuration/readiness status. It does not return credential values.

## Result rules

- Decimal values remain strings to avoid binary floating-point loss.
- Datetimes are serialized as timezone-aware UTC ISO 8601 values.
- Enum values are stable strings.
- `null`, missing-price/rate, stale-price/rate, per-market partial, and unreconciled states remain explicit.
- Read-only does not mean public: all results are private personal financial information.

## Tool selection

- Start with `get_asset_overview` for a broad question, then use account/position/reconciliation
  tools for evidence.
- Use `list_recent_asset_transactions` only for bounded recent headers, not detailed auditing.
- Use `get_pending_financial_events` to identify staging work; any mutation must happen in the
  trusted local UI/API workflow.
- Use `get_asset_system_status` for build/configuration diagnosis, not financial health.

## Explicitly unavailable

There are no MCP tools to create accounts, capture/finalize events, post/reverse transactions,
record trades/prices, reconcile, close a period, pair/revoke a phone, back up/restore, call OpenAI,
read raw SQLite, or approve an AI proposal.

## Protocol verification

A valid smoke test performs `initialize`, preserves `Mcp-Session-Id` when applicable, calls
`tools/list`, invokes representative read tools, and confirms the ledger did not change. HTTP 200
from `/mcp` alone is not contract proof.
