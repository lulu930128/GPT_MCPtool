import assert from "node:assert/strict";
import test from "node:test";
import { brokerReadback, confirmDeskSelection, currentStageDecision, deskReviews, intentReview, pendingSelection, reviewSelection, stageRecord, stageSelection, intentStage, readStaged } from "./desk-contract";
import { fixtureIntent, fixtureReadback, fixtureReview, fixtureStage } from "../scripts/desk-fixture";
import { CandidateSession, newCandidate, visibleCandidates, type Candidate } from "./candidate-state";

test("local stage pins raw identity/provenance/revision/digest and routes confirmation once", async () => {
  const row = fixtureStage(), raw = row.raw as any, calls: any[] = [];
  assert.equal(stageRecord(row, raw), row);
  assert.equal(intentStage([row], raw), row);
  assert.equal(intentStage([], raw), null);
  assert.throws(() => intentStage([row, row], raw));
  for (const patch of [{ owner_id: "AGENT" }, { kind: "conditional" }, { revision: 0 }, { digest: "bad" }, { manual_stage: {} }, { raw: { ...raw, price: "99" } }]) {
    assert.throws(() => stageRecord({ ...row, ...patch }, raw));
  }
  for (const state of ["SUBMITTING", "SUBMITTED", "SUBMISSION_UNKNOWN", "SUBMISSION_REJECTED", "FILLED"]) {
    const changed = { ...row, manual_stage: { ...(row.manual_stage as any), state } };
    assert.equal(stageRecord(changed), changed, "Backend states are preserved");
    assert.throws(() => stageSelection(changed));
  }
  assert.throws(() => stageSelection({ ...row, lifecycle: "CANCELLED" }));
  await confirmDeskSelection({ async callTool(name, args) { calls.push({ name, args }); return {}; } }, stageSelection(row));
  assert.deepEqual(calls, [{ name: "omi_confirm_desk_staged", args: { id: row.id, expected_revision: 1, expected_digest: row.digest } }]);
});

test("a stage requires a Backend decision window even with the original ID and a matching digest", async () => {
  const row = fixtureStage(), pin = stageSelection(row);
  const closed = { state: "CURRENT", reason: "STAGE_SAME_TRADING_DAY", decision_date: "2026-11-23", market_date: "2026-11-23",
    created_at: "2026-11-23T09:00:00+08:00", expires_at: "2026-11-23T13:30:00+08:00" };
  assert.equal(currentStageDecision({ ...row, stage_validity: closed }, Date.parse("2026-11-23T05:29:59Z")), true);
  assert.equal(currentStageDecision({ ...row, stage_validity: closed }, Date.parse("2026-11-23T05:30:00Z")), false);
  for (const validity of [undefined, {}, { ...closed, state: "REVIEW" }, { ...closed, state: "EXPIRED" },
    { ...(row.stage_validity as object), created_at: null }, { ...(row.stage_validity as object), decision_date: "2026-11-19", market_date: "2026-11-23" }]) {
    const snapshot = { ...row, stage_validity: validity };
    assert.throws(() => stageSelection(snapshot));
    let calls = 0;
    await assert.rejects(confirmDeskSelection({ async callTool() { calls++; return {}; } }, { ...pin, snapshot }));
    assert.equal(calls, 0);
  }
});

test("local intent price compares exact decimal value without floating point rounding", () => {
  for (const [input, canonical] of [["578.00", "578"], ["50.00", "50"], ["00050.0100", "50.01"], ["578.0000000000000000010", "578.000000000000000001"]]) {
    const row = fixtureStage({ price: canonical });
    const expected = { ...(row.raw as any), price: input };
    assert.equal(stageRecord(row, expected), row);
    assert.equal(intentStage([row], expected), row);
  }
  const row = fixtureStage({ price: "578.000000000000000001" });
  assert.throws(() => stageRecord(row, { ...(row.raw as any), price: "578.000000000000000002" }));
  assert.throws(() => stageRecord(row, { ...(row.raw as any), quantity_shares: "1000" }));
});

test("stage read scans bounded pages and rejects ambiguous or malformed evidence", async () => {
  const page = Array.from({ length: 100 }, (_, i) => fixtureStage({ client_intent_id: `intent-${i}` }));
  const last = fixtureStage({ client_intent_id: "last" }), calls: any[] = [];
  const rows = await readStaged({ async callTool(name, args) { calls.push({ name, args }); return { structuredContent: { result: calls.length === 1 ? page : [last] } }; } });
  assert.equal(rows.length, 101);
  assert.deepEqual(calls[1], { name: "omi_read_desk_staged", args: { after: page[99].id, limit: 100 } });
  for (const value of [{}, [page[0], page[0]], [fixtureReview()]]) await assert.rejects(readStaged({ async callTool() { return { structuredContent: { result: value } }; } }));
});

test("immutable review pins exact revision/digest and uses the desk confirm route", async () => {
  const review = fixtureReview(), selection = reviewSelection(review), calls: unknown[] = [];
  await confirmDeskSelection({ async callTool(name, args) { calls.push({ name, args }); return { structuredContent: { state: "EXECUTION" } }; } }, selection);
  assert.deepEqual(calls, [{ name: "omi_confirm_desk_review", args: { id: review.review_id, expected_revision: 1, expected_digest: "a".repeat(64) } }]);
  for (const patch of [{ review_revision: 2 }, { snapshot: {} }]) assert.throws(() => reviewSelection({ ...review, ...patch }));
  const wrong: any = structuredClone(review); wrong.snapshot.draft.command.space_id = "AGENT_SPACE";
  assert.throws(() => reviewSelection(wrong), /USER_SPACE/);
  assert.throws(() => reviewSelection({ ...review, execution_audit: [{ kind: "CANDIDATE_REVIEW_BOUND" }] }), /Pending/);
});

test("synthetic 3481 short-selling Common/ROD and 3711 cash Odd quantities remain exact across bridge", async () => {
  for (const raw of [
    { symbol: "3481", condition: "SHORT_SELLING", action: "Sell", lot: "Common", quantity_shares: 1000, price: "15" },
    { symbol: "3711", condition: "CASH", action: "Buy", lot: "Odd", quantity_shares: 200, price: "592" },
  ]) {
    const review: any = fixtureReview(raw), selected = reviewSelection(review), stage = stageSelection(fixtureStage(raw));
    assert.equal(selected.command.symbol, raw.symbol); assert.equal(selected.command.condition, raw.condition);
    assert.equal(selected.command.action, raw.action); assert.equal(selected.command.lot, raw.lot);
    assert.equal(selected.command.quantity, raw.quantity_shares); assert.equal(stage.command.quantity, raw.quantity_shares);
    assert.equal(review.snapshot.order_semantics.time_in_force, "ROD");
    const calls: unknown[] = [];
    await confirmDeskSelection({ async callTool(name, args) { calls.push({ name, args }); return { structuredContent: review }; } }, stage);
    assert.deepEqual(calls, [{ name: "omi_confirm_desk_staged", args: { id: stage.id, expected_revision: stage.revision, expected_digest: stage.digest } }]);
  }
});

test("actual readback shapes retain external orders, partial cash and unknown credit inventory", () => {
  const data = fixtureReadback([fixtureReview()]);
  assert.equal(brokerReadback(data, "orders"), data); assert.equal(deskReviews(data).length, 1);
  assert.deepEqual((data.broker_orders as any[]).map(row => row.ownership), ["EXTERNAL", "MANAGED"]);
  assert.equal(brokerReadback(data, "fills").fill_history_complete, false);
  const inventory = brokerReadback(data, "inventory").inventory as any;
  assert.equal(inventory.cash.quality, "PARTIAL"); assert.equal(inventory.cash.items[0].sellable_shares, null);
  assert.equal(inventory.margin.quality, "UNKNOWN"); assert.equal(inventory.short_selling.items, null);
  assert.throws(() => brokerReadback({ items: [], source: "portfolio.holdings" }, "inventory"));
  assert.throws(() => brokerReadback({ ...data, fills: undefined }, "fills"));
  assert.equal(intentReview(data, fixtureIntent)?.review_id, fixtureReview().review_id);
  assert.throws(() => intentReview(fixtureReadback([fixtureReview(), fixtureReview()]), fixtureIntent), /多筆/);
});

test("conditional Pending binds approve and rejects a hardcoded AGENT preparation", async () => {
  const review: any = fixtureReview();
  const candidate = { id: "c", revision: 2, owner_id: "MCP", raw: { ...newCandidate("2330"), conditions: { kind: "AND", clauses: [] } } };
  const pending = { id: "p", candidate_id: "c", candidate_revision: 2, revision: 5, digest: "b".repeat(64), state: "NATIVE_PREVIEW", price: "100.25", quantity: 1000, native: { review_id: review.review_id, review_revision: 1, digest: "a".repeat(64) }, preparation: { draft: review.draft } };
  const calls: unknown[] = [];
  await confirmDeskSelection({ async callTool(name, args) { calls.push({ name, args }); return {}; } }, pendingSelection(pending, candidate));
  assert.deepEqual(calls, [{ name: "omi_approve_candidate_pending", args: { id: "p", expected_revision: 5, expected_digest: "b".repeat(64) } }]);
  const wrong = structuredClone(pending); wrong.preparation.draft.command.space_id = "AGENT_SPACE";
  assert.throws(() => pendingSelection(wrong, candidate), /AGENT/);
});

test("new conditional drafts use USER/MANUAL/MCP while legacy edits keep original provenance", async () => {
  const calls: any[] = [];
  const legacy: Candidate = { id: "legacy", revision: 7, owner_id: "old-agent", raw: { ...newCandidate("2330"), space_id: "AGENT_SPACE", source: "AGENT_PROPOSAL" } };
  const bridge = { async callTool(name: string, args: any) { calls.push({ name, args }); return { structuredContent: name === "omi_read_candidate" ? legacy : name === "omi_list_candidates" ? { result: [legacy] } : name === "omi_create_candidate" ? { id: "user", revision: 1, owner_id: "MCP", raw: args.raw, validation_reasons: ["INVALID_INPUT:space_id:literal_error"] } : name === "omi_read_candidate_monitor_status" ? {} : { result: [] } }; } };
  const session = new CandidateSession(bridge, "2330"); assert.equal(session.state.owner, "MCP"); session.start();
  assert.equal(session.state.draft.space_id, "USER_SPACE"); assert.equal(session.state.draft.source, "MANUAL");
  session.edit({ ...session.state.draft, quantity: 12 }); const before = session.state.draft;
  visibleCandidates(session.state, "AGENT_SPACE"); assert.equal(session.state.draft, before);
  await session.save(); assert.equal(calls.find(call => call.name === "omi_create_candidate").args.owner_id, "MCP"); assert.match(session.state.notice, /未生效/);
  const old = new CandidateSession(bridge); await old.select("legacy"); old.beginEdit();
  assert.equal(old.state.draft.space_id, "AGENT_SPACE"); assert.equal(old.state.owner, "old-agent");
});
