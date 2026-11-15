import assert from "node:assert/strict";
import test from "node:test";
import { localStageResult, stageSelection } from "./desk-contract";
import { fixtureStage } from "../scripts/desk-fixture";
import type { UnknownRecord } from "./state";

test("local cancel resolves from its terminal version with no Native execution", () => {
  const before = fixtureStage();
  const receipt = { ...before, revision: 2, digest: "d".repeat(64), event: "CANCEL", state: "CANCELLED", lifecycle: "CANCELLED" };
  assert.equal(localStageResult(receipt, { before }), receipt);
  assert.throws(() => stageSelection(receipt));
});
test("local revision checks the requested content and preserves original identity", () => {
  const before = fixtureStage(), raw = { ...(before.raw as UnknownRecord), price: "102", quantity_shares: 2000 };
  const receipt = { ...before, raw, revision: 2, event: "REVISE", digest: "d".repeat(64) };
  assert.equal(localStageResult(receipt, { before, raw }), receipt);
  assert.throws(() => localStageResult({ ...receipt, raw: before.raw }, { before, raw }));
});
test("unchanged, later unrelated, claimed, mismatched and malformed reads cannot resolve local mutation", () => {
  const before = fixtureStage(), stage = before.manual_stage as UnknownRecord;
  const receipt = { ...before, revision: 2, event: "CANCEL", state: "CANCELLED", lifecycle: "CANCELLED" };
  for (const patch of [{ id: "other" }, { revision: 1 }, { revision: 3 }, { event: "REVISE" }, { state: "ACTIVE" },
    { manual_stage: { ...stage, submission: { phase: "DRAFT" } } }, { manual_stage: { ...stage, original_digest: "a".repeat(64) } }]) {
    assert.throws(() => localStageResult({ ...receipt, ...patch }, { before }));
  }
});
