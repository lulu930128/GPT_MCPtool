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

`先記著` creates or updates staging only. `直接入帳` is limited to sufficiently complete
expense/income events with an explicit account decision. Finalization revalidates event version,
account, currency, amount, status, and ledger invariants inside one transaction.

Mobile sync creates `source=mobile_sync` pending Financial Events. It never calls ledger finalize.

## Investments

Trades are transaction details, not a separate ledger:

- a buy creates balanced cash/investment/fee postings and a linked trade;
- a sell releases moving-average cost, records proceeds/fees, and derives realized P/L;
- positions are rebuilt from ordered trades and cannot be manually overwritten;
- the latest authorized price at or before the requested cutoff provides valuation evidence.

Missing price yields `null` market value and a warning. Cost or zero must not be presented as a
live market value. Every price keeps provider, `price_at`, quality, and age.

## Reconciliation and snapshots

A balance observation records external evidence. The system compares it with the ledger balance
and reports the difference; it does not change postings to force agreement.

A snapshot fixes an as-of time and a metrics payload for reproducible monthly/period review. A
snapshot can be stale or incomplete if the underlying prices or reconciliation evidence were stale
or incomplete, and that quality must remain visible.

## First-version limitations

- Base/accounting currency is TWD.
- There is no complete foreign-exchange accounting.
- Securities use moving-average cost, not configurable tax lots.
- Prices are manual facts; there is no promise of live provider data.
- AI and MCP have no ledger mutation authority.
