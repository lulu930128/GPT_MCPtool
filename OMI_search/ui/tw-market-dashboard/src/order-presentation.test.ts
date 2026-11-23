import assert from "node:assert/strict";
import test from "node:test";
import { associatedStages, nextWorkspaceDayAt, stageCreatedDay, stagedSection, workspaceDay, remainingShares } from "./order-presentation";
import { readStockName } from "./stock-name";
import { fixtureSubmittedOrder, fixtureStage, fixtureReadback } from "../scripts/desk-fixture";
import type { UnknownRecord } from "./state";

test("exact master lookup coalesces cards; never uses a fuzzy name or a TW name for US", async () => {
  let calls = 0;
  const bridge = { async callTool(_name: string, args: UnknownRecord) {
    calls++;
    return { structuredContent: { kind: "omi.tw_symbol_search", query: args.keyword, items: [{ stock_id: "3702", stock_name: "大聯大" }, { stock_id: "37020", stock_name: "不應採用" }] } };
  } };
  assert.deepEqual(await Promise.all([readStockName(bridge, "3702", "TW"), readStockName(bridge, "3702", "TW")]), ["大聯大", "大聯大"]);
  assert.equal(calls, 1);
  assert.equal(await readStockName(bridge, "3702", "US"), "");
  await assert.rejects(readStockName(bridge, "370", "TW"));
  await assert.rejects(readStockName(bridge, "370", "TW"));
  assert.equal(calls, 2, "failures coalesce without automatic retry");
  await readStockName(bridge, "3702", "TW", true);
  assert.equal(calls, 3);
});

test("mismatched response identity and duplicate exact names fail visibly", async () => {
  for (const value of [
    { kind: "omi.tw_symbol_search", query: "2330", items: [{ stock_id: "3702", stock_name: "wrong" }] },
    { kind: "omi.tw_symbol_search", query: "3702", items: [{ stock_id: "3702", stock_name: "A" }, { stock_id: "3702", stock_name: "B" }] },
  ]) await assert.rejects(readStockName({ async callTool() { return { structuredContent: value }; } }, "3702", "TW"));
});

test("association preserves distinct same-symbol orders and ambiguous identity", () => {
  const f = fixtureSubmittedOrder("3702", "ACCEPTED", "2026-11-11", { price: "82.5", lot: "Odd", quantity_shares: 800 });
  const other = fixtureStage({ symbol: "3702", price: "83.1", quantity_shares: 1000, client_intent_id: "another-intent" });
  const data = { ...fixtureReadback([f.review]), broker_orders: [f.broker] };
  assert.deepEqual(associatedStages([f.row, other], data, f.broker), [f.row]);
  for (const field of ["account_id", "trade_date", "order_id"]) {
    const changed = { ...f.broker, broker_key: { ...(f.broker.broker_key as UnknownRecord), [field]: "different" } };
    assert.deepEqual(associatedStages([f.row, other], data, changed), []);
  }
  assert.deepEqual(associatedStages([f.row], { ...data, broker_orders: [f.broker, f.broker] }, f.broker), []);
  assert.deepEqual(associatedStages([f.row], data, { ...f.broker, ownership: "EXTERNAL" }), []);
});

test("remaining shares uses reported current evidence, never quantity minus incomplete fills", () => {
  assert.equal(remainingShares({ quantity_shares: 800, known_filled_shares: 0 }), "待回報");
  assert.equal(remainingShares({ facts: [{ current_read: true, remaining_shares: 800 }, { current_read: true, remaining_shares: 0 }] }), "0 股");
  assert.equal(remainingShares({ facts: [{ current_read: true, remaining_shares: null }] }), "待回報");
});

test("the Taipei creation day survives close, revisions and Native reads, then rolls at midnight", () => {
  const close = Date.parse("2026-11-23T13:30:00+08:00"), midnight = nextWorkspaceDayAt("2026-11-23");
  const stage = fixtureStage(), window = { state: "CURRENT", created_at: "2026-11-22T16:01:00Z",
    decision_date: "2026-11-23", market_date: "2026-11-23", reason: "STAGE_SAME_TRADING_DAY", expires_at: "2026-11-23T13:30:00+08:00" };
  const row = { ...stage, stage_validity: window, recorded_at: "2026-11-24T10:00:00+08:00" };
  assert.equal(workspaceDay(midnight), "2026-11-24");
  assert.equal(stagedSection(row, {}, false, close - 1), "current");
  assert.equal(stagedSection(row, {}, false, close), "inactive");
  assert.equal(stagedSection(row, {}, false, midnight - 1), "inactive");
  assert.equal(stagedSection(row, {}, false, midnight), "history");
  assert.equal(stagedSection({ ...row, stage_validity: { ...window, reason: "STAGE_ENTRY_WINDOW", expires_at: "2026-11-24T13:30:00+08:00" } }, {}, false, midnight), "history");
});

test("US creation is displayed on its Taipei civil day; ambiguous and future dates never enter today", () => {
  const now = Date.parse("2026-11-23T10:00:00+08:00"), template = fixtureStage({ market: "US" });
  const validity = { decision_date: "2026-11-22", created_at: "2026-11-22T16:05:00Z" };
  assert.equal(stageCreatedDay({ ...template, stage_validity: validity }, now), "2026-11-23");
  for (const patch of [{ created_at: null }, { created_at: "2026-11-22T16:05:00" }, { decision_date: "2026-11-23" },
    { created_at: "2026-02-30T16:00:00Z" }, { created_at: "2026-11-24T02:00:00Z" }]) {
    assert.equal(stagedSection({ ...template, stage_validity: { ...validity, ...patch } }, { state: "FILLED" }, false, now), "undated");
  }
});
