import { fixtureSubmittedOrder, fixtureReadback, fixtureStage } from "./desk-fixture";
import type { UnknownRecord } from "../src/state";

// Anonymous in-memory fixtures, not account/order IDs copied from production.
export function fixtureTodayOrders() {
  const make = (key: string, symbol: string, state: string, date: string | null, price: string, quantity: number, created: string | null) => {
    const f = fixtureSubmittedOrder(key, state, date, { symbol, price, quantity_shares: quantity, lot: quantity === 800 ? "Odd" : "Common" });
    f.broker.symbol = symbol; f.broker.price = price;
    f.review.created_at = created;
    f.review.updated_at = "2026-11-16T12:00:00+08:00";
    const receipt = (f.row.manual_stage as any).submission.receipt;
    receipt.created_at = created; receipt.confirmed_at = created;
    f.row.stage_validity = { state: "LOCKED", market_date: "2026-11-23", decision_date: date };
    f.row.recorded_at = "2026-11-16T13:00:00+08:00";
    const fact = (f.broker.facts as UnknownRecord[])[0];
    if (state === "CANCELLED") fact.remaining_shares = 0;
    f.broker.facts = [{ ...fact, kind: "ACCEPTED", current_read: false, source: "Order.set_event", source_at: created },
      { ...fact, source_at: "2026-11-16T10:08:06+08:00", received_at: "2026-11-16T14:00:00+08:00" }];
    return f;
  };
  const earlier = make("old-3702", "3702", "CANCELLED", "2026-11-16", "82.5", 800, "2026-11-16T01:11:49+00:00");
  const later = make("new-3702", "3702", "ACCEPTED", "2026-11-16", "83.1", 1000, "2026-11-16T02:09:44+00:00");
  const past = [make("past-1802", "1802", "UNKNOWN", "2026-11-13", "82.8", 1000, "2026-11-13T09:00:00+08:00"),
    make("past-2409", "2409", "UNKNOWN", "2026-11-02", "32.5", 1000, "2026-11-02T09:00:00+08:00"),
    make("past-2330", "2330", "FILLED", "2026-11-09", "900", 1000, "2026-11-09T09:00:00+08:00"),
    make("past-8227", "8227", "ACCEPTED", "2026-11-09", "45", 1000, "2026-11-09T09:00:00+08:00")];
  const undated = make("undated", "9999", "UNKNOWN", null, "10", 1000, null);
  const orders = [earlier, ...past, later, undated];
  const expired = fixtureStage({ client_intent_id: "nov19-draft", symbol: "00685L", price: "20" });
  expired.stage_validity = { state: "EXPIRED", created_at: "2026-11-19T03:35:00Z", decision_date: "2026-11-19", market_date: "2026-11-23" };
  const drafts = [expired, fixtureStage({ client_intent_id: "valid-today", symbol: "1101", price: "20" })];
  const stages = [...orders.map(item => item.row), ...drafts];
  const data = { ...fixtureReadback(orders.map(item => item.review)), trade_date: "2026-11-16", broker_orders: orders.map(item => item.broker) };
  return { data, stages, orders, earlier, later, past, undated, drafts };
}

// Same distribution as the reported 13:53 workspace. All IDs are synthetic.
export function fixtureStagedDays() {
  function sent(symbol: string, day: string, state: string) {
    const { row, review } = fixtureSubmittedOrder(symbol, state, day);
    row.lifecycle = state === "UNKNOWN" ? "SUBMISSION_UNKNOWN" : "SUBMITTED";
    (row.manual_stage as UnknownRecord).state = row.lifecycle;
    row.stage_validity = { state: "LOCKED", created_at: `${day}T03:35:00Z`, decision_date: day, market_date: "2026-11-23" };
    row.recorded_at = "2026-11-23T05:50:00Z";
    row.native_readback = { status: "OBSERVED", execution: review.execution };
    return row;
  }
  const today = ["2327", "00631L", "3711"].map(symbol => sent(symbol, "2026-11-23", "FILLED"));
  const cancelled = fixtureStage({ symbol: "00685L", client_intent_id: "nov19-cancel" });
  cancelled.lifecycle = cancelled.state = "CANCELLED";
  cancelled.stage_validity = { state: "EXPIRED", decision_date: "2026-11-19", created_at: "2026-11-19T03:35:00Z", market_date: "2026-11-23" };
  const history = [cancelled, sent("1802", "2026-11-13", "UNKNOWN"), sent("2409", "2026-11-02", "UNKNOWN"),
    ...Array.from({ length: 29 }, (_, i) => sent(String(5000 + i), "2026-11-19", ["ACCEPTED", "CANCELLED", "REJECTED", "FILLED"][i % 4]))];
  return [...today, ...history];
}
