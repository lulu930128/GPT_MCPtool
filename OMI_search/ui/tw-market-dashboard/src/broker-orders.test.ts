import assert from "node:assert/strict";
import test from "node:test";
import { brokerOrderViews, cancelDeskOrder, deskCancelLatch, deskOrderCancellable, exactBrokerOrder } from "./broker-orders";
import { fixtureBrokerOrder, fixtureBrokerOrders, fixtureDeskOrder } from "../scripts/desk-fixture";
import type { UnknownRecord } from "./state";

const view = (row = fixtureBrokerOrder(), patch: UnknownRecord = {}) => brokerOrderViews({ ...fixtureBrokerOrders(), broker_orders: [row], ...patch })[0];
const fake = (respond: (name: string, args: UnknownRecord) => unknown | Promise<unknown>) => {
  const calls: { name: string; args: UnknownRecord }[] = [];
  return { calls, async callTool(name: string, args: UnknownRecord) { calls.push({ name, args }); return { structuredContent: await respond(name, args) }; } };
};

test("only exact direct NOT_SENT response releases cancel latch for another explicit click", async () => {
  const row = fixtureBrokerOrder(), pin = view(row).pin!;
  let failed = false;
  const bridge = fake(name => {
    if (name === "omi_read_desk_order") return fixtureDeskOrder(row, failed ? { cancel_stage: "NOT_SENT", cancel_error: "ORDER_NOT_IN_SDK_SESSION" } : {});
    failed = true;
    return fixtureDeskOrder(row, { cancel_stage: "NOT_SENT", cancel_error: "ORDER_NOT_IN_SDK_SESSION" });
  });
  const result = await cancelDeskOrder(bridge, pin.id, pin.market, pin);
  assert.equal(deskCancelLatch(bridge, pin.id, pin.market).attempted, false);
  assert.equal(deskOrderCancellable(result), true);
  assert.equal(bridge.calls.length, 2, "no automatic retry");
  await cancelDeskOrder(bridge, pin.id, pin.market, pin);
  assert.equal(bridge.calls.length, 4, "only explicit second action retries precheck");
});

test("Backend trading date partitions today's active/check-needed orders from terminal and past history", () => {
  const rows = brokerOrderViews(fixtureBrokerOrders());
  assert.deepEqual(rows.filter(row => !row.history).map(row => row.row.symbol), ["fixture-active", "fixture-partial", "fixture-external", "fixture-missing-id", "fixture-today-unknown", "fixture-untrusted"]);
  assert.deepEqual(rows.filter(row => row.history).map(row => row.row.symbol), ["fixture-filled", "fixture-old-cancelled", "fixture-old-unknown", "fixture-rejected"]);
  assert.deepEqual(rows.filter(row => row.pin).map(row => row.row.symbol), ["fixture-active", "fixture-partial"]);
  assert.equal(rows.find(row => row.row.symbol === "fixture-today-unknown")!.needsCheck, true);
  const old = rows.find(row => row.row.symbol === "fixture-old-unknown")!;
  assert.equal(old.needsCheck, true); assert.equal(old.state, "UNKNOWN"); assert.match(old.note, /未推定今日仍有效或已撤銷/);
  assert.equal(rows[1].row.known_filled_shares, 400); assert.equal(rows[1].row.fill_history_complete, false);
});

for (const state of ["OPEN", "ACCEPTED", "PARTIALLY_FILLED"]) test(`same-day ${state} with current PARTIAL evidence remains cancellable`, () => {
  assert.ok(view(fixtureBrokerOrder({ execution_state: state })).pin);
});
for (const state of ["UNKNOWN", "RECONCILING", "PENDING", "CANCEL_PENDING", "future-state"]) test(`${state} is check-needed, never active or cancellable`, () => {
  const row = view(fixtureBrokerOrder({ execution_state: state }));
  assert.equal(row.history, false); assert.equal(row.needsCheck, true); assert.equal(row.pin, undefined);
});
for (const [name, patch] of Object.entries({ external: { ownership: "EXTERNAL" }, missingExecution: { execution_id: null }, blankExecution: { execution_id: " " },
  missingBroker: { broker_key: { account_id: "fixture-account", trade_date: "2026-11-11" } }, missingAccount: { broker_key: { trade_date: "2026-11-11", order_id: "broker" } },
  missingDate: { broker_key: { account_id: "fixture-account", order_id: "broker" } },
  invalidDate: { broker_key: { account_id: "fixture-account", trade_date: "2026-02-30", order_id: "broker" } },
  old: { broker_key: { account_id: "fixture-account", trade_date: "2026-11-10", order_id: "broker" } }, unknownQuality: { quality: "UNKNOWN" },
  absentQuality: { quality: null }, absentFacts: { facts: [] }, cached: { facts: [{ current_read: false, kind: "SNAPSHOT", remaining_shares: 1000 }] },
  zeroRemaining: { facts: [{ current_read: true, kind: "SNAPSHOT", remaining_shares: 0 }] }, conflictingTerminal: { broker_status: "FILLED" },
  newerZero: { facts: [{ current_read: true, kind: "SNAPSHOT", remaining_shares: 1000 }, { current_read: true, kind: "SNAPSHOT", remaining_shares: 0 }] },
  newerRejection: { facts: [{ current_read: true, kind: "SNAPSHOT", remaining_shares: 1000 }, { current_read: true, kind: "REJECTED", remaining_shares: null }] },
})) test(`${name} cannot obtain a cancel pin`, () => { assert.equal(view(fixtureBrokerOrder(patch)).pin, undefined); });

test("unavailable whole read and stale cached list block cancellation; global historical parse diagnostics do not mark today's trusted row unknown", () => {
  assert.equal(view().needsCheck, false);
  assert.equal(view(undefined, { quality: "UNKNOWN" }).pin, undefined);
  assert.equal(view(undefined, { trade_date: "bad-date" }).needsCheck, true);
  assert.equal(brokerOrderViews(fixtureBrokerOrders(), true).some(row => row.pin), false);
  const row = fixtureBrokerOrder();
  assert.equal(brokerOrderViews({ ...fixtureBrokerOrders(), broker_orders: [row, structuredClone(row)] }).some(row => row.pin), false);
});

test("cancel re-reads exact account/date/execution/broker identity and only calls the existing cancel route once for remaining shares", async () => {
  const row = fixtureBrokerOrder({ execution_state: "PARTIALLY_FILLED", known_filled_shares: 400 }), pin = view(row).pin!;
  const bridge = fake(name => fixtureDeskOrder(row, name === "omi_cancel_desk_order" ? { state: "CANCEL_PENDING", cancel_stage: "RETURNED" } : {}));
  const result = await cancelDeskOrder(bridge, pin.id, pin.market, pin);
  assert.equal((result.execution as UnknownRecord).state, "CANCEL_PENDING");
  assert.deepEqual(bridge.calls, ["omi_read_desk_order", "omi_cancel_desk_order"].map(name => ({ name, args: { id: pin.id, market: "TW" } })));
  await assert.rejects(cancelDeskOrder(bridge, pin.id, pin.market, pin));
  assert.equal(bridge.calls.length, 2);
});

for (const state of ["ACCEPTED", "PARTIALLY_FILLED"]) test(`exact ${state} cancel follows Native authority even when reconcile_required=true`, async () => {
  const row = fixtureBrokerOrder({ execution_state: state, known_filled_shares: state === "PARTIALLY_FILLED" ? 400 : 0 }), pin = view(row).pin!;
  const current = fixtureDeskOrder(row, { reconcile_required: true });
  assert.equal(deskOrderCancellable(current), true);
  const bridge = fake(name => name === "omi_read_desk_order" ? current : fixtureDeskOrder(row, { state: "CANCEL_PENDING", cancel_stage: "RETURNED", reconcile_required: true }));
  await cancelDeskOrder(bridge, pin.id, pin.market, pin);
  assert.deepEqual(bridge.calls, ["omi_read_desk_order", "omi_cancel_desk_order"].map(name => ({ name, args: { id: pin.id, market: "TW" } })));
  await assert.rejects(cancelDeskOrder(bridge, pin.id, pin.market, pin));
  assert.equal(bridge.calls.length, 2);
});

for (const [name, patch] of Object.entries({ filled: { state: "FILLED" }, rejected: { state: "REJECTED" }, cancelled: { state: "CANCELLED" },
  unknown: { state: "UNKNOWN" }, reconciling: { state: "RECONCILING" }, cancelPending: { state: "CANCEL_PENDING" },
  broker: { broker_order_id: "different" }, missingBroker: { broker_order_id: null }, execution: { execution_id: "different" },
  date: { trade_date: "2026-11-10" },
  existingCancel: { cancel_stage: "CLAIMED" }, missingCancel: { cancel_stage: undefined }, fullyFilled: { filled_shares: 1000 },
  unknownFill: { filled_shares: null }, negativeFill: { filled_shares: -1 }, unknownQuantity: { quantity: null },
})) test(`pre-cancel read ${name} prevents all effects`, async () => {
  const row = fixtureBrokerOrder(), pin = view(row).pin!, bridge = fake(() => fixtureDeskOrder(row, patch));
  await assert.rejects(cancelDeskOrder(bridge, pin.id, pin.market, pin));
  assert.deepEqual(bridge.calls.map(call => call.name), ["omi_read_desk_order"]);
});

test("account/command date/market mismatch and malformed readback cannot cancel", async () => {
  const row = fixtureBrokerOrder(), pin = view(row).pin!, data = fixtureDeskOrder(row);
  for (const value of [{ ...data, market: "US" }, { ...data, command: { account_id: "other", trade_date: pin.tradeDate } },
    { ...data, command: { account_id: pin.accountId, trade_date: "2026-11-10" } }, {}, null]) {
    const bridge = fake(() => value);
    await assert.rejects(cancelDeskOrder(bridge, pin.id, pin.market, pin));
    assert.equal(bridge.calls.length, 1);
  }
});

for (const outcome of ["timeout", "UNKNOWN", "wrong-broker", "malformed"]) test(`cancel ${outcome} retains the shared latch through list refresh/remount and exact reads`, async () => {
  const row = fixtureBrokerOrder(), pin = view(row).pin!;
  const bridge = fake(name => {
    if (name === "omi_read_desk_order") return fixtureDeskOrder(row);
    if (outcome === "timeout") throw Error("synthetic timeout");
    return outcome === "UNKNOWN" ? fixtureDeskOrder(row, { state: "UNKNOWN" }) : outcome === "wrong-broker" ? fixtureDeskOrder(row, { broker_order_id: "other" }) : {};
  });
  await cancelDeskOrder(bridge, pin.id, pin.market, pin).catch(() => {});
  const latch = deskCancelLatch(bridge, pin.id, pin.market);
  assert.equal(latch.attempted, true); assert.equal(latch.busy, false);
  assert.equal(deskCancelLatch(bridge, pin.id, pin.market), latch);
  exactBrokerOrder(fixtureDeskOrder(row), pin.id, pin.market, pin); // An old ACCEPTED read cannot allow a resend.
  exactBrokerOrder(fixtureDeskOrder(row, { state: "CANCELLED" }), pin.id, pin.market, pin);
  await assert.rejects(cancelDeskOrder(bridge, pin.id, pin.market, pin));
  assert.equal(bridge.calls.filter(call => call.name === "omi_cancel_desk_order").length, 1);
});

test("concurrent broker and local detail actions share the pre-read lock and cannot dispatch twice", async () => {
  const row = fixtureBrokerOrder(), pin = view(row).pin!;
  let release!: (value: unknown) => void;
  const bridge = fake(name => name === "omi_read_desk_order" ? new Promise(resolve => { release = resolve; }) : fixtureDeskOrder(row, { state: "CANCEL_PENDING" }));
  const pending = cancelDeskOrder(bridge, pin.id, pin.market, pin);
  await assert.rejects(cancelDeskOrder(bridge, pin.id, pin.market));
  assert.equal(bridge.calls.length, 1);
  release(fixtureDeskOrder(row)); await pending;
  assert.equal(bridge.calls.filter(call => call.name === "omi_cancel_desk_order").length, 1);
});

test("failed pre-read sends nothing and permits a later explicit read-and-cancel; no automatic retry", async () => {
  const row = fixtureBrokerOrder(), pin = view(row).pin!;
  let failure = true;
  const bridge = fake(() => { if (failure) throw Error("offline"); return fixtureDeskOrder(row); });
  await assert.rejects(cancelDeskOrder(bridge, pin.id, pin.market, pin));
  assert.equal(deskCancelLatch(bridge, pin.id, pin.market).attempted, false);
  assert.equal(bridge.calls.length, 1);
  failure = false; await cancelDeskOrder(bridge, pin.id, pin.market, pin);
  assert.equal(bridge.calls.length, 3);
  assert.equal(deskOrderCancellable(fixtureDeskOrder(row)), true);
});
