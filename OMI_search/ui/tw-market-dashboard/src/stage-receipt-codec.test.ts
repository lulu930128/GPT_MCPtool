import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stageRecord, intentStage } from "./desk-contract";
import { researchStaged } from "./research-contract";
import type { UnknownRecord } from "./state";

const fixtures = JSON.parse(readFileSync(new URL("../scripts/fixtures/backend-stage-receipts.json", import.meta.url), "utf8")) as { request: UnknownRecord; receipt: UnknownRecord }[];
test("actual Backend persisted receipt accepts omitted defaults and nested Decimal wire forms", () => {
  for (const { request, receipt } of fixtures) {
    assert.equal(stageRecord(receipt, request), receipt);
    assert.equal(intentStage(fixtures.map(item => item.receipt), request), receipt);
  }
});
test("wrong market, settlement, quantity, protection and ambiguous intent remain UNKNOWN", () => {
  const { request, receipt } = fixtures[0];
  for (const patch of [{ market: "US" }, { market: null }, { settlement_mode: "TWD" }, { quantity_shares: 2000 },
    { protection: { ...(request.protection as UnknownRecord), stop_loss: 76 } },
    { protection: { ...(request.protection as UnknownRecord), targets: [{ price: 90, fraction: 0.5, limit_price: 89 }] } }]) {
    assert.throws(() => stageRecord(receipt, { ...request, ...patch }), /UNKNOWN/);
  }
  assert.throws(() => intentStage([receipt, receipt], request), /多筆/);
});
test("research receipt applies the same omitted TW codec without weakening lineage", () => {
  const { request, receipt } = fixtures[0];
  const expected = { id: "research-1", revision: "rev-1", intent: String(request.client_intent_id), market: "TW", symbol: "1802" };
  const row = { ...receipt, raw: { ...(receipt.raw as UnknownRecord), research_proposal: { creation_id: expected.id, revision_id: expected.revision, market: "TW", workflow_origin: "AI_NOMINATION" } } };
  assert.equal(researchStaged(row, expected), row);
  assert.throws(() => researchStaged(row, { ...expected, market: "US" }));
});
