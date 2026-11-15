import assert from "node:assert/strict";
import test from "node:test";
import { stageNativeReview } from "./desk-contract";
import { brokerOrderViews, stageOrderView } from "./broker-orders";
import { fixtureCrossdayOrders, fixtureSubmittedOrder, fixtureStage } from "../scripts/desk-fixture";
import type { UnknownRecord } from "./state";

for (const [state, date] of [["FILLED", "2026-11-06"], ["CANCELLED", "2026-11-09"], ["REJECTED", "2026-11-02"], ["UNKNOWN", "2026-11-02"]]) {
  test(`query day 11/11 precisely joins original ${date} ${state} without mutating local receipt`, () => {
    const item = fixtureSubmittedOrder(`synthetic-${state}`, state, date), before = JSON.stringify(item.row);
    const data = { ...fixtureCrossdayOrders().data, reviews: [item.review], broker_orders: [item.broker] };
    assert.equal(stageNativeReview(item.row, data), item.review);
    const view = stageOrderView(item.row, data, brokerOrderViews(data));
    assert.equal(view.date, date); assert.equal(view.state, state); assert.equal(view.history, true);
    assert.equal(view.historicalUnknown, state === "UNKNOWN"); assert.equal(view.cancelOrder, undefined);
    assert.equal(JSON.stringify(item.row), before);
    assert.equal((((item.row.manual_stage as any).submission).receipt.execution).state, "PENDING");
    if (state === "UNKNOWN") { assert.equal(view.execution.filled_shares, null); assert.match(view.reason, /歷史待核對/); }
  });
}

test("same-day active/partial directly reuse a cancel pin; terminal, past, missing, external and untrusted cannot", () => {
  const f = fixtureCrossdayOrders(), rows = brokerOrderViews(f.data);
  const views = f.stages.map(row => ({ symbol: (row.raw as UnknownRecord).symbol, ...stageOrderView(row, f.data, rows) }));
  assert.deepEqual(views.filter(view => view.cancelOrder).map(view => view.symbol), ["crossday-active", "crossday-partial"]);
  assert.deepEqual(views.filter(view => view.history).map(view => view.symbol), ["crossday-filled", "crossday-cancelled", "crossday-rejected", "crossday-unknown", "crossday-today-filled"]);
  for (const view of views.filter(view => !view.cancelOrder)) assert.ok(view.reason.length > 0);
  const undated = views.find(view => view.symbol === "crossday-undated")!;
  assert.equal(undated.history, false); assert.equal(undated.date, null); assert.match(undated.reason, /原委託日未確認/);
  const staged = stageOrderView(fixtureStage(), f.data, rows);
  assert.equal(staged.submitted, false); assert.equal(staged.history, false);
});

test("query date is only a presentation/cancel-session gate; old ACCEPTED does not become today's cancellable order", () => {
  const f = fixtureSubmittedOrder("old-active", "ACCEPTED", "2026-11-09"), data = { ...fixtureCrossdayOrders().data, reviews: [f.review], broker_orders: [f.broker] };
  const view = stageOrderView(f.row, data, brokerOrderViews(data));
  assert.equal(view.linked, f.review); assert.equal(view.history, true); assert.equal(view.historicalUnknown, true); assert.equal(view.cancelOrder, undefined);
});

for (const [name, change] of Object.entries<(review: any) => void>({
  "review ID": r => r.review_id = "different", "execution ID": r => r.execution_id = "different", "intent ID": r => r.draft.command.intent_id = "different",
  "original command date": r => r.draft.command.trade_date = "2026-11-07", "execution date": r => r.execution.trade_date = "2026-11-07",
  "revision": r => r.review_revision++, "digest": r => r.snapshot.digest = "f".repeat(64), "snapshot owner": r => r.snapshot.review_id = "different",
  "missing execution date": r => delete r.execution.trade_date, "missing execution intent": r => delete r.execution.intent_id, "missing execution identity": r => delete r.execution.execution_id,
})) test(`historical ${name} mismatch/missing still cannot join`, () => {
  const f = fixtureSubmittedOrder("wrong-original", "FILLED", "2026-11-06"), wrong = structuredClone(f.review);
  change(wrong); assert.equal(stageNativeReview(f.row, { ...fixtureCrossdayOrders().data, reviews: [wrong] }), null);
});

test("omitted local market retains TW cancellation; explicit US and unsupported market never become TW", () => {
  const f = fixtureSubmittedOrder("default-market", "ACCEPTED", "2026-11-11");
  const data = { ...fixtureCrossdayOrders().data, reviews: [f.review], broker_orders: [f.broker] }, broker = brokerOrderViews(data);
  delete (f.row.raw as UnknownRecord).market;
  let view = stageOrderView(f.row, data, broker);
  assert.equal(view.market, "TW"); assert.ok(view.cancelOrder); assert.equal(view.reason, "");
  (f.row.raw as UnknownRecord).market = "US"; view = stageOrderView(f.row, data, broker);
  assert.equal(view.market, "US"); assert.equal(view.cancelOrder, undefined);
  (f.row.raw as UnknownRecord).market = "UNSUPPORTED"; view = stageOrderView(f.row, data, broker);
  assert.equal(view.market, "UNSUPPORTED"); assert.equal(view.cancelOrder, undefined); assert.match(view.reason, /市場未確認/);
});

test("conflicting original receipt/command dates and missing all identity pins remain unknown", () => {
  const f = fixtureSubmittedOrder("wrong-local", "FILLED", "2026-11-06"), data = { ...fixtureCrossdayOrders().data, reviews: [f.review] };
  const local: any = structuredClone(f.row); local.manual_stage.submission.receipt.execution.trade_date = "2026-11-07";
  assert.equal(stageNativeReview(local, data), null);
  assert.equal(stageOrderView(local, data, []).date, null);
  const missing: any = structuredClone(f.row); delete missing.manual_stage.submission.native; delete missing.manual_stage.submission.native_intent_id;
  delete missing.manual_stage.submission.receipt; delete missing.manual_stage.submission.draft.command.intent_id;
  assert.equal(stageNativeReview(missing, data), null);
});

test("duplicate exact or conflicting review/execution/intent identities never select the convenient record", () => {
  const f = fixtureSubmittedOrder("duplicates", "FILLED", "2026-11-06"), data = fixtureCrossdayOrders().data;
  assert.equal(stageNativeReview(f.row, { ...data, reviews: [f.review, structuredClone(f.review)] }), null);
  for (const field of ["execution_id", "review_id"]) {
    const conflict: any = structuredClone(f.review); conflict[field] = "conflict";
    assert.equal(stageNativeReview(f.row, { ...data, reviews: [f.review, conflict] }), null);
  }
});

test("stale list, Native/broker account/order/state/date conflicts and existing cancel claim block the upper action", () => {
  const make = () => fixtureSubmittedOrder("upper-conflict", "ACCEPTED", "2026-11-11");
  for (const alter of [
    (f: ReturnType<typeof make>) => (f.broker.broker_key as UnknownRecord).account_id = "other",
    (f: ReturnType<typeof make>) => (f.broker.broker_key as UnknownRecord).order_id = "other",
    (f: ReturnType<typeof make>) => (f.broker.broker_key as UnknownRecord).trade_date = "2026-11-10",
    (f: ReturnType<typeof make>) => f.broker.execution_state = "PARTIALLY_FILLED",
    (f: ReturnType<typeof make>) => (f.review.execution as UnknownRecord).cancel_stage = "CLAIMED",
  ]) {
    const f = make(); alter(f); const data = { ...fixtureCrossdayOrders().data, reviews: [f.review], broker_orders: [f.broker] };
    assert.equal(stageOrderView(f.row, data, brokerOrderViews(data)).cancelOrder, undefined);
  }
  const f = make(), data = { ...fixtureCrossdayOrders().data, reviews: [f.review], broker_orders: [f.broker] };
  assert.equal(stageOrderView(f.row, data, brokerOrderViews(data), true).cancelOrder, undefined);
});
