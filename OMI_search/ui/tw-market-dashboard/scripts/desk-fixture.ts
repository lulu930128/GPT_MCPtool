// Synthetic shapes from execution_runtime/read_projection.py / ManualDeskService.
// No real broker identity, market price or account data.
import type { UnknownRecord } from "../src/state";
export const fixtureIntent = "83771cec-bd72-4dd9-bb65-132ea523997b";
export function fixtureSubmissionError(row: UnknownRecord): UnknownRecord {
  return { isError: true, structuredContent: { error: "OMI API HTTP 503: synthetic readiness failure", tool: "omi_confirm_desk_staged", http_status: 503,
    backend_error: { error: { code: "EXECUTOR_NOT_READY", message: "Request failed.", request_id: "synthetic-request", detail: {
      error_type: "ControlUnavailable", retry_policy: "EXPLICIT_RETRY_SAME_STAGE", submission_attempt: {
        contract: "omi.execution.submission-attempt.v1", outcome: "NOT_ATTEMPTED", candidate_id: row.id,
        candidate_revision: row.revision, candidate_digest: row.digest, phase: "READINESS", native_command_started: false,
      },
    } } } } };
}
export function fixtureConnection(patch: UnknownRecord = {}): UnknownRecord {
  return { connection: { contract: "omi.execution.connection.v1", market: "TW", timezone: "Asia/Taipei", desired: "ONLINE", actual: "RECOVERING",
    session_bound: true, disconnect_observed: true, disconnect_callback_registered: true, session_generation: 2, trade_date: "2026-11-05",
    date_ready: false, ready: false, busy: null, retry_attempt: 1, retry_at: null, last_error: "KGI_DISCONNECTED", last_broker_read: null, ...patch } };
}
export function fixtureStage(body: UnknownRecord = {}): UnknownRecord {
  const raw = { client_intent_id: fixtureIntent, market: "TW", symbol: "2330", action: "Buy", condition: "CASH", lot: "Common", quantity_shares: 1000, price: "100.25", ...body };
  return { id: `stage-${raw.client_intent_id}`, revision: 1, digest: "b".repeat(64), event: "CREATE", kind: "manual_stage", owner_id: "MCP", raw, state: "ACTIVE", lifecycle: "STAGED",
    manual_stage: { client_intent_id: raw.client_intent_id, original_digest: "c".repeat(64), space_id: "USER_SPACE", source: "MANUAL", state: "STAGED", submission: null } };
}
export function fixtureReview(body: UnknownRecord = {}): UnknownRecord {
  const intent = String(body.client_intent_id ?? fixtureIntent);
  const draft = { owner_id: "MCP", source: "MANUAL", command: { account_id: "fixture-account", trade_date: "2026-10-31", request_id: intent, intent_id: intent, symbol: body.symbol ?? "2330", action: body.action ?? "Buy", condition: body.condition ?? "CASH", lot: body.lot ?? "Common", shares_per_unit: body.lot === "Odd" ? 1 : 1000, quantity: body.quantity_shares ?? 1000, price: body.price ?? "100.25", space_id: "USER_SPACE", strategy_id: null, revision: null } };
  const review_id = `review-${intent}`;
  return { review_id, review_revision: 1, state: "PREVIEW", draft, client_intent_id: intent, snapshot: { review_version: 1, review_id, review_revision: 1, previewed_at: "2026-10-31T09:00:00+08:00", draft: structuredClone(draft), digest: "a".repeat(64), order_semantics: { order_kind: "LIMIT", time_in_force: "ROD", quantity_unit: "shares" } }, execution_id: null, execution: null, audit: [], execution_audit: [] };
}
export function fixtureReadback(reviews: UnknownRecord[] = []): UnknownRecord {
  const source = { source: "fixture-SDK", source_at: "2026-10-31T09:00:00+08:00", received_at: "2026-10-31T09:00:01+08:00", current_read: true, kind: "SNAPSHOT", quantity_shares: 1000, remaining_shares: 1000, cumulative_shares: 0, price: "100.25", broker_status: "fixture-submitted" };
  const unknown = { quality: "UNKNOWN", source: null, source_as_of: null, queried_at: null, received_at: null, items: null, complete: false, reasons: ["SDK_FIELD_SEMANTICS_UNVERIFIED"] };
  return { contract: "omi.execution-desk.v1", trade_date: "2026-10-31", session_generation: 1, queried_at: source.source_at, received_at: source.received_at, quality: "PARTIAL", sources: [{ source: "fixture-SDK", complete: false }], reviews,
    broker_orders: ["EXTERNAL", "MANAGED"].map(ownership => ({ broker_key: { account_id: "fixture-account", trade_date: "2026-10-31", order_id: `fixture-${ownership}` }, execution_id: ownership === "MANAGED" ? "fixture-execution" : null, ownership, space_id: "USER_SPACE", symbol: "2330", action: "Buy", condition: "CASH", lot: "Common", quantity_shares: 1000, price: "100.25", broker_status: "fixture-submitted", execution_state: ownership === "MANAGED" ? "SUBMITTED" : null, known_filled_shares: 0, fill_history_complete: false, quality: "PARTIAL", facts: [source] })),
    fills: [{ broker_key: { account_id: "fixture-account", trade_date: "2026-10-31", order_id: "fixture-fill-order" }, fill_id: "fixture-deal-1", execution_id: null, ownership: "EXTERNAL", space_id: "USER_SPACE", symbol: "2330", action: "Buy", condition: "CASH", lot: "Odd", quantity_shares: 1, price: "100.25", quality: "KNOWN", evidence: [{ ...source, kind: "DEAL", quantity_shares: 1 }] }], fill_history_complete: false,
    inventory: { cash: { quality: "PARTIAL", source: "Account.InventorySum(B)", source_as_of: null, queried_at: source.source_at, received_at: source.received_at, items: [{ symbol: "2330", reported_total_shares: 1000, odd_shares: 1, holding_upper_bound_shares: 1001, sellable_shares: null, quality: "PARTIAL" }], complete: false, reasons: ["SOURCE_AS_OF_UNKNOWN", "SELLABLE_SHARES_UNKNOWN", "REPORT_COMPLETENESS_UNKNOWN"] }, margin: structuredClone(unknown), short_selling: structuredClone(unknown) }, unparsed_reports: [{ reason: "fixture-unparsed", source: "fixture-SDK" }], invalid_trade_count: 0 };
}

export function fixtureBrokerOrder(patch: UnknownRecord = {}): UnknownRecord {
  const row = (fixtureReadback().broker_orders as UnknownRecord[])[1];
  const result: UnknownRecord = { ...row, symbol: "fixture-active", broker_key: { account_id: "fixture-account", trade_date: "2026-11-11", order_id: "fixture-broker-active" },
    execution_id: "fixture-execution-active", execution_state: "ACCEPTED", broker_status: "ACCEPTED", ...patch };
  if (!("facts" in patch)) {
    const date = (result.broker_key as UnknownRecord).trade_date;
    result.facts = (row.facts as UnknownRecord[]).map(fact => ({ ...fact, source_at: `${date}T09:00:00+08:00`, received_at: `${date}T09:00:01+08:00`,
      remaining_shares: Number(result.quantity_shares) - Number(result.known_filled_shares), broker_status: result.broker_status }));
  }
  return result;
}

export function fixtureDeskOrder(row = fixtureBrokerOrder(), patch: UnknownRecord = {}): UnknownRecord {
  const key = row.broker_key as UnknownRecord;
  return { market: "TW", command: { account_id: key.account_id, trade_date: key.trade_date }, protection: null,
    execution: { execution_id: row.execution_id, broker_order_id: key.order_id, trade_date: key.trade_date, state: row.execution_state,
      quantity: row.quantity_shares, filled_shares: row.known_filled_shares, reconcile_required: false, cancel_stage: null, ...patch } };
}

export function fixtureBrokerOrders(): UnknownRecord {
  const make = (symbol: string, state: string, date = "2026-11-11", patch: UnknownRecord = {}) => fixtureBrokerOrder({
    symbol, execution_id: `execution-${symbol}`, broker_key: { account_id: "fixture-account", trade_date: date, order_id: `broker-${symbol}` },
    execution_state: state, broker_status: state, ...patch,
  });
  return { ...fixtureReadback(), trade_date: "2026-11-11", broker_orders: [
    make("fixture-active", "ACCEPTED"), make("fixture-partial", "PARTIALLY_FILLED", undefined, { known_filled_shares: 400 }),
    make("fixture-filled", "FILLED", undefined, { known_filled_shares: 1000 }),
    make("fixture-old-cancelled", "CANCELLED", "2026-11-10"), make("fixture-old-unknown", "UNKNOWN", "2026-11-10"),
    make("fixture-external", "OPEN", undefined, { ownership: "EXTERNAL", execution_id: null }),
    make("fixture-missing-id", "ACCEPTED", undefined, { execution_id: null }),
    make("fixture-today-unknown", "UNKNOWN"), make("fixture-rejected", "REJECTED"),
    make("fixture-untrusted", "ACCEPTED", undefined, { quality: "UNKNOWN", facts: [] }),
  ], unparsed_reports: Array.from({ length: 6 }, () => ({ reason: "INVALID_JOURNAL_OBSERVATION" })) };
}

// Anonymous shape of a frozen local PENDING receipt and a later Native read.
export function fixtureSubmittedOrder(symbol: string, state: string, date: string | null, patch: UnknownRecord = {}) {
  const row = fixtureStage({ client_intent_id: `synthetic-crossday-${symbol}`, symbol, ...patch });
  const raw = row.raw as UnknownRecord, review = fixtureReview(raw), draft = review.draft as UnknownRecord, command = draft.command as UnknownRecord;
  command.trade_date = date; (review.snapshot as UnknownRecord).draft = structuredClone(draft);
  const broker = fixtureBrokerOrder({ symbol, execution_id: `synthetic-execution-${symbol}`, execution_state: state, broker_status: state,
    broker_key: { account_id: "fixture-account", trade_date: date, order_id: `synthetic-broker-${symbol}` },
    quantity_shares: raw.quantity_shares, lot: raw.lot, known_filled_shares: state === "FILLED" ? raw.quantity_shares : state === "PARTIALLY_FILLED" ? 400 : state === "UNKNOWN" ? null : 0 });
  const execution = { ...(fixtureDeskOrder(broker).execution as UnknownRecord), intent_id: command.intent_id, reconcile_required: true };
  review.state = "EXECUTION"; review.execution_id = broker.execution_id; review.execution = execution;
  const frozen = structuredClone(review);
  frozen.execution = { ...execution, state: "PENDING", broker_order_id: null, filled_shares: null };
  row.revision = 2; row.digest = "d".repeat(64); row.lifecycle = "SUBMISSION_PENDING";
  row.manual_stage = { ...(row.manual_stage as UnknownRecord), state: "SUBMISSION_PENDING", submission: { phase: "RESULT", pin: { revision: 1, digest: "b".repeat(64) },
    native_intent_id: command.intent_id, native: { review_id: review.review_id, review_revision: review.review_revision, digest: (review.snapshot as UnknownRecord).digest },
    draft: structuredClone(draft), receipt: frozen } };
  return { row, review, broker };
}

export function fixtureCrossdayOrders() {
  const orders = [fixtureSubmittedOrder("crossday-active", "ACCEPTED", "2026-11-11"), fixtureSubmittedOrder("crossday-partial", "PARTIALLY_FILLED", "2026-11-11"),
    fixtureSubmittedOrder("crossday-filled", "FILLED", "2026-11-06", { lot: "Odd", quantity_shares: 1 }),
    fixtureSubmittedOrder("crossday-cancelled", "CANCELLED", "2026-11-09"), fixtureSubmittedOrder("crossday-rejected", "REJECTED", "2026-11-02"),
    fixtureSubmittedOrder("crossday-unknown", "UNKNOWN", "2026-11-02"), fixtureSubmittedOrder("crossday-today-filled", "FILLED", "2026-11-11"),
    fixtureSubmittedOrder("crossday-missing-id", "ACCEPTED", "2026-11-11"), fixtureSubmittedOrder("crossday-external", "ACCEPTED", "2026-11-11"),
    fixtureSubmittedOrder("crossday-untrusted", "ACCEPTED", "2026-11-11"), fixtureSubmittedOrder("crossday-undated", "UNKNOWN", null)];
  const missing = orders.find(item => item.broker.symbol === "crossday-missing-id")!;
  // Real local TW rows may omit market; preserve the existing nullish default.
  delete (orders[0].row.raw as UnknownRecord).market;
  delete (orders[1].row.raw as UnknownRecord).market;
  (missing.broker.broker_key as UnknownRecord).order_id = null; (missing.review.execution as UnknownRecord).broker_order_id = null;
  orders.find(item => item.broker.symbol === "crossday-external")!.broker.ownership = "EXTERNAL";
  const untrusted = orders.find(item => item.broker.symbol === "crossday-untrusted")!;
  untrusted.broker.quality = "UNKNOWN"; untrusted.broker.facts = [];
  const data = { ...fixtureBrokerOrders(), reviews: orders.map(item => item.review), broker_orders: orders.map(item => item.broker) };
  return { orders, data, stages: orders.map(item => item.row) };
}
