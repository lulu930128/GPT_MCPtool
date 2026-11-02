// Synthetic shapes from execution_runtime/read_projection.py / ManualDeskService.
// No real broker identity, market price or account data.
import type { UnknownRecord } from "../src/state";
export const fixtureIntent = "83771cec-bd72-4dd9-bb65-132ea523997b";
export function fixtureStage(body: UnknownRecord = {}): UnknownRecord {
  const raw = { client_intent_id: fixtureIntent, symbol: "2330", action: "Buy", condition: "CASH", lot: "Common", quantity_shares: 1000, price: "100.25", ...body };
  return { id: `stage-${raw.client_intent_id}`, revision: 1, digest: "b".repeat(64), kind: "manual_stage", owner_id: "MCP", raw, state: "ACTIVE", lifecycle: "STAGED",
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
