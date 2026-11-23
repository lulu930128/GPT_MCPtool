import assert from "node:assert/strict";
import test from "node:test";
import { researchList, researchDetail, researchDeleted, researchStaged, localRejection, deletedResearchRead } from "./research-contract";
import { CallError } from "./candidate-state";
import { fixtureResearch, fixtureResearchList, fixtureResearchDetail } from "../scripts/research-fixture";
import { fixtureStage } from "../scripts/desk-fixture";

test("current TW and US list summaries provide identities without full evidence or detail reads", () => {
  for (const market of ["TW", "US"]) {
    const row = fixtureResearch(market);
    const parsed = researchList(fixtureResearchList([row]), market, 0);
    assert.equal(parsed.items[0].creation_id, row.creation_id);
    assert.equal(parsed.items[0].proposal, undefined);
    assert.equal(parsed.hasMore, false);
    assert.throws(() => researchDetail(row));
  }
});
test("reject old UI-only shape, duplicate IDs, wrong market, wrong page and incomplete identity", () => {
  const row = fixtureResearch();
  for (const payload of [{ items: [fixtureResearchDetail(row)], has_more: false }, fixtureResearchList([row, row]),
    fixtureResearchList([{ ...row, market: "US" }]), fixtureResearchList([{ ...row, revision_id: "" }]),
    fixtureResearchList([row], 25), { ...fixtureResearchList([row]), execution_ready: true }]) {
    assert.throws(() => researchList(payload, "TW", 0));
  }
});
test("editing requires exact detail identity and version, never the stale list summary", () => {
  const row = researchList(fixtureResearchList([fixtureResearch()]), "TW", 0).items[0];
  assert.equal(researchDetail(fixtureResearchDetail(row), row).proposal.revision_id, row.revision_id);
  assert.throws(() => researchDetail(fixtureResearchDetail({ ...row, revision_id: "new", revision: 2 }), row));
  assert.throws(() => researchDetail(fixtureResearchDetail({ ...row, creation_id: "other" }), row, false));
});
test("deletion needs the dedicated terminal receipt, not an empty success response", () => {
  const row = researchList(fixtureResearchList([fixtureResearch()]), "TW", 0).items[0];
  const receipt = { creation_id: row.creation_id, revision_id: "deleted-revision", status: "deleted", deleted_at: "2026-11-06T00:00:00Z" };
  researchDeleted(receipt, row);
  for (const value of [{}, { ...receipt, creation_id: "other" }, { ...receipt, revision_id: row.revision_id }]) assert.throws(() => researchDeleted(value, row));
});
test("research staging/recovery binds original proposal revision, intent, symbol and market", () => {
  const expected = { id: "research-US", revision: "r1", intent: "original-intent", market: "US", symbol: "NVDA" };
  const raw = { market: "US", symbol: "NVDA", lot: "Shares", client_intent_id: expected.intent,
    research_proposal: { creation_id: expected.id, revision_id: expected.revision, workflow_origin: "AI_NOMINATION", market: "US" } };
  researchStaged(fixtureStage(raw), expected);
  for (const patch of [{ client_intent_id: "different" }, { market: "TW" }, { research_proposal: { ...raw.research_proposal, revision_id: "r2" } }]) {
    assert.throws(() => researchStaged(fixtureStage({ ...raw, ...patch }), expected));
  }
});
test("local refusal and terminal deletion recovery require typed errors for the exact tool", () => {
  assert.equal(localRejection(new CallError("conflict", false, 409, {}, "omi_cancel_candidate"), "omi_cancel_candidate"), true);
  assert.equal(localRejection(new Error("OMI API HTTP 409: conflict"), "omi_cancel_candidate"), false);
  assert.equal(localRejection(new CallError("timeout", true, 503, {}, "omi_cancel_candidate"), "omi_cancel_candidate"), false);
  assert.equal(deletedResearchRead(new CallError("deleted", false, 410, { error: { code: "PROPOSAL_DELETED" } }, "omi_read_research_proposal")), true);
  assert.equal(deletedResearchRead(new CallError("deleted", false, 410, {}, "omi_read_research_proposal")), false);
});


test("program nomination and neutral observation do not invalidate a whole research page", () => {
  const row = { ...fixtureResearch(), workflow_origin: "PROGRAM_NOMINATION", direction: "neutral", stage_supported: false, revise_supported: false };
  assert.equal(researchList(fixtureResearchList([row]), "TW", 0).items[0].workflow_origin, "PROGRAM_NOMINATION");
});
