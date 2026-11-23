import assert from "node:assert/strict";
import test from "node:test";
import { brokerOrderViews } from "./broker-orders";
import { todayOrderPresentation, orderCreatedLabel } from "./order-presentation";
import { fixtureTodayOrders } from "../scripts/today-orders-fixture";

test("11/16 only: mixed sources are newest first, terminal orders stay, exact dedupe preserves both 3702 orders", () => {
  const f = fixtureTodayOrders(), before = JSON.stringify(f);
  const result = todayOrderPresentation(f.stages, f.data, brokerOrderViews(f.data));
  assert.deepEqual(result.orders.map(item => item.kind === "broker" && [item.order.row.symbol, item.order.row.price, item.order.state]), [["3702", "83.1", "ACCEPTED"], ["3702", "82.5", "CANCELLED"]]);
  assert.deepEqual(result.orders.map(item => orderCreatedLabel(item.createdAt)), ["10:09:44", "09:11:49"]);
  assert.equal(result.undatedStages.length, 1); assert.equal(result.undatedBrokers.length, 1);
  assert.equal(JSON.stringify(f), before, "no source state or facts changed");
});

test("all same-day states stay, future/past rows and malformed date never enter today", () => {
  for (const state of ["ACCEPTED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "UNKNOWN"]) {
    const f = fixtureTodayOrders(); f.later.broker.execution_state = state; (f.later.review.execution as any).state = state;
    assert.equal(todayOrderPresentation(f.stages, f.data, brokerOrderViews(f.data)).orders.length, 2, state);
  }
  const f = fixtureTodayOrders();
  for (const date of [null, "2026-02-30", "not-a-date"]) assert.equal(todayOrderPresentation(f.stages, { ...f.data, trade_date: date }, brokerOrderViews(f.data)).orders.length, 0);
  assert.equal(todayOrderPresentation(f.stages, { ...f.data, trade_date: "2026-11-17" }, brokerOrderViews(f.data)).orders.length, 0);
});

test("local receipt date works without linked review; conflicting dates never use recorded_at", () => {
  const f = fixtureTodayOrders();
  const data = { ...f.data, reviews: [], broker_orders: [] };
  assert.deepEqual(todayOrderPresentation(f.stages, data, []).orders.map(item => item.createdAt), ["2026-11-16T02:09:44+00:00", "2026-11-16T01:11:49+00:00"]);
  (f.later.row.manual_stage as any).submission.receipt.execution.trade_date = "2026-11-13";
  const result = todayOrderPresentation(f.stages, data, []);
  assert.equal(result.orders.length, 1);
  assert.ok(result.undatedStages.some(item => item.row.id === f.later.row.id));
});

test("broker and local-only records share one sort; first ACCEPTED fallback ignores cancel/read clocks, missing times sort last with stable ID", () => {
  const f = fixtureTodayOrders();
  const data = { ...f.data, reviews: [], broker_orders: [f.earlier.broker] };
  const result = todayOrderPresentation([f.later.row], data, brokerOrderViews(data));
  assert.deepEqual(result.orders.map(item => [item.kind, orderCreatedLabel(item.createdAt)]), [["stage", "10:09:44"], ["broker", "09:11:49"]]);
  const noTime = structuredClone(f.later.broker); noTime.facts = [{ kind: "SNAPSHOT", source_at: "2026-11-16T23:59:00+08:00" }];
  const tied = { ...data, broker_orders: [noTime, { ...noTime, execution_id: "another-execution" }] };
  const first = todayOrderPresentation([], tied, brokerOrderViews(tied));
  const reversed = { ...tied, broker_orders: [...tied.broker_orders].reverse() };
  assert.deepEqual(first.orders.map(item => item.id), todayOrderPresentation([], reversed, brokerOrderViews(reversed)).orders.map(item => item.id));
  assert.ok(first.orders.every(item => item.createdAt === null));
});

test("date filtering does not depend on cancel eligibility or stale evidence; draft-only rows never become submitted", () => {
  const f = fixtureTodayOrders();
  const result = todayOrderPresentation(f.stages, f.data, brokerOrderViews(f.data, true), true);
  assert.equal(result.orders.length, 2);
  assert.ok(result.orders.every(item => item.kind === "broker" && !item.order.pin));
  assert.ok(!result.orders.some(item => f.drafts.some(draft => item.kind === "stage" && item.stage.row.id === draft.id)));
});
