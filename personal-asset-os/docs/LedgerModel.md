# Personal Asset OS Ledger Model

## Formal truth

`transactions` and `postings` are the only formal accounting truth. Account balances, dashboard
totals, cash availability, positions, profit/loss, reconciliation differences, and snapshots are
derived views or evidence.

```text
capture / UI / import staging
  -> validated ledger service
  -> immutable transaction
  -> two or more balanced postings
  -> reporting and reconciliation projections
```

No UI, API adapter, MCP tool, mobile client, price provider, or AI may overwrite a balance or edit
an existing posted transaction in place.

## Sources of truth

| Concern | Source | Meaning |
| --- | --- | --- |
| Formal accounting | `transactions + postings` | Immutable financial effect |
| Quick capture | `financial_events` | Staging/evidence; does not affect net worth until finalized |
| Capture lineage | `financial_event_transaction_links` | Which event produced which formal transaction |
| Trade details | `trades` linked to a transaction | Quantity, execution price, fees, tax |
| Position | Rebuilt from trades | Derived quantity, average cost, realized P/L |
| Valuation | `prices` | Provider, price, `price_at`, quality |
| Reconciliation | `balance_observations` | External balance evidence and difference |
| Period close | `snapshots` | Reproducible as-of metrics, not a balance override |
| Daily valuation | `daily_valuation_snapshots` | Immutable aggregate chart evidence, not Ledger truth |

## Posting convention

The ledger is debit-positive:

- asset and expense increases are positive;
- liability, equity, and income increases are negative;
- every transaction's `base_amount` sum is zero.

Examples:

| Event | Posting 1 | Posting 2 |
| --- | ---: | ---: |
| Cash expense 500 | Expense `+500` | Cash `-500` |
| Credit-card expense 500 | Expense `+500` | Card liability `-500` |
| Pay card 500 | Card liability `+500` | Bank `-500` |
| Receive income 1,000 | Bank `+1,000` | Income `-1,000` |

Credit-card payment is a transfer from asset to liability; it is not a second expense.

## Transaction invariants

The ledger service enforces:

- at least two postings;
- no zero posting amount;
- each posting currency matches its account;
- first-version currency is TWD only;
- `amount` equals `base_amount` for TWD;
- total `base_amount` equals exactly zero;
- money uses `Decimal`/database numeric values, not binary float;
- timestamps are normalized to timezone-aware UTC at service boundaries.

Money is quantized to six decimal places internally. UI formatting must not change stored values or
become the source for later calculations.

## Immutability and correction

Posted transactions are not updated or deleted. Corrections use one of:

- a reversal transaction with postings equal and opposite to the original;
- a new adjustment transaction with explicit description and audit lineage;
- a corrected staged Financial Event before it is finalized.

Reversal does not erase the original transaction. Both remain available for audit and reporting.

## Idempotency

Create/finalize operations may carry an idempotency key. The same key with the same normalized
content returns the existing result. The same key with different content is a conflict.

After a timeout, query existing state and retry the same key. Generating a new key before checking
can create an unintended duplicate economic event.

## Financial Event lifecycle

A Financial Event is editable staging:

```text
captured -> pending_match / needs_review
         -> finalized -> linked immutable transaction
         -> rejected  -> retained tombstone/audit state
```

`直接入帳` is limited to sufficiently complete expense/income events and uses the one eligible
activity-fund account. Finalization revalidates event version, account, currency, amount, status,
and ledger invariants inside one transaction.

Authenticated mobile sync atomically creates `source=mobile_sync` Financial Events and calls the
same desktop finalize service with `approval_source=paired_mobile`. The service requires matching
authenticated device identity; the phone itself never writes the ledger database.

## Reporting annotations

`transaction_reporting_annotations` is mutable presentation metadata for category and note cleanup.
It references one immutable transaction, uses optimistic versions, and writes create/update audit
rows. Dashboard grouping and recent-transaction presentation may use it, but transaction/posting
amounts, descriptions, Financial Events, idempotency keys, and payload hashes remain unchanged.

## Investments

Trades are transaction details, not a separate ledger:

- a buy creates balanced cash/investment/fee postings and a linked trade;
- a sell releases moving-average cost, records proceeds/fees, and derives realized P/L;
- positions are rebuilt from ordered trades and cannot be manually overwritten;
- the latest authorized price at or before the requested cutoff provides valuation evidence.

Missing price yields `null` market value and a warning. Cost or zero must not be presented as a
live market value. Every price keeps provider, `price_at`, quality, and age. A configured KGI
Bridge may replace the valuation of an explicitly mapped investment account at read time, but it
does not create or modify trade, posting, price, or snapshot rows. Broker-only positions remain
external, unreconciled evidence even when their reported market value is included in provisional
net worth.

KGI overseas positions are also read-time evidence, not multi-currency Ledger entries. Their USD
price/value remain explicit. A fresh official USD/TWD fact may project a TWD market value for the
current read model. Raw positions and FX provider payloads are not persisted; a component-scheduled
or explicitly captured daily aggregate snapshot may retain only applied rate/provider/quality timing as bounded chart
evidence. Missing/expired FX excludes that position from TWD totals instead of substituting zero or
a guessed rate.

## Reconciliation and snapshots

A balance observation records external evidence. The system compares it with the ledger balance
and reports the difference; it does not change postings to force agreement.

A period snapshot fixes an as-of time and a metrics payload for reproducible monthly/period review.
A daily valuation snapshot stores only aggregate chart metrics plus bounded quality/provider timing;
it does not persist broker accounts, raw positions, or Bridge payloads. Both snapshot types can be
stale or incomplete if the underlying prices or reconciliation evidence were stale
or incomplete, and that quality must remain visible.

The PAOS component lifecycle owns the once-daily capture attempt. After the configured local wall
time, the first ready process creates that reporting date's immutable row; an existing row prevents
another broker/FX read. History reads never invoke this capture path, and missed dates remain gaps.

## First-version limitations

- Base/accounting currency is TWD.
- There is no complete foreign-exchange accounting.
- Securities use moving-average cost, not configurable tax lots.
- Prices are manual facts; there is no promise of live provider data.
- AI and MCP have no ledger mutation authority.
