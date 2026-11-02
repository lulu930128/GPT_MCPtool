import assert from "node:assert/strict";
import test from "node:test";
import { CandidateSession, candidateExample, newCandidate, toolValue, visibleCandidates, type Candidate, type Pending } from "./candidate-state";
import type { UnknownRecord } from "./state";

function fixture(symbol?: string) {
  let record: Candidate = { id: "fixture-c", revision: 1, owner_id: "fixture-owner", raw: candidateExample(), state: "ACTIVE", validation_reasons: ["INCOMPLETE_DATE"] };
  let item: Pending = { id: "fixture-p", candidate_id: record.id, revision: 3, price: "12", quantity: 1, state: "PENDING_APPROVAL", qualification: { send_ready: false, reasons: ["BORROW_UNKNOWN"] } };
  const calls: { name: string; args: UnknownRecord }[] = [];
  let fault: ((name: string, args: UnknownRecord) => unknown) | null = null;
  const bridge = { async callTool(name: string, args: UnknownRecord) {
    calls.push({ name, args });
    const response = fault?.(name, args); if (response !== undefined) return await response;
    const values: Record<string, unknown> = {
      omi_list_candidates: { result: [record] }, omi_read_candidate: record,
      omi_read_candidate_revisions: { result: [record] }, omi_read_candidate_pending: { result: [item] },
      omi_read_candidate_monitor_status: { state: "NOT_STARTED" },
    };
    if (name === "omi_create_candidate") { record = { ...record, raw: args.raw as UnknownRecord, owner_id: args.owner_id as string }; return { structuredContent: record }; }
    if (name === "omi_revise_candidate") record = { ...record, revision: record.revision + 1, raw: args.raw as UnknownRecord };
    if (["omi_pause_candidate", "omi_resume_candidate", "omi_cancel_candidate"].includes(name)) record = { ...record, revision: record.revision + 1, state: name.includes("pause") ? "PAUSED" : name.includes("resume") ? "ACTIVE" : "CANCELLED" };
    if (name === "omi_revise_candidate_pending") item = { ...item, revision: item.revision + 2, price: args.price, quantity: args.quantity };
    if (name === "omi_cancel_candidate_pending") item = { ...item, revision: item.revision + 1, state: "CANCELLED" };
    return { structuredContent: name.includes("candidate_pending") && !name.startsWith("omi_read") ? item
      : name.startsWith("omi_read") || name === "omi_list_candidates" ? values[name] : record };
  } };
  return { session: new CandidateSession(bridge, symbol), calls, get record() { return record; }, set record(value: Candidate) { record = value; },
    get item() { return item; }, setFault(fn: typeof fault) { fault = fn; } };
}
const writes = (calls: { name: string; args: UnknownRecord }[]) => calls.filter(({ name }) => /omi_(create|revise|pause|resume|cancel)_/.test(name));

test("examples have no market prices; 3481 is an incomplete short-selling draft, not the 2330 trigger", () => {
  const long = candidateExample(), short = candidateExample(true);
  assert.equal(long.symbol, "2330"); assert.equal(long.quantity, 1); assert.equal(long.proposed_limit, null);
  const clauses = (long.conditions as { clauses: any[] }).clauses;
  assert.deepEqual(clauses.map((item) => [item.metric.kind, item.operator, item.value]), [["price", "<", 2180], ["rsi", "<=", 1], ["macd", ">=", 9999]]);
  assert.deepEqual(clauses[1].metric, { kind: "rsi", field: "value", timeframe: "1d", completed: true, parameters: [14] });
  assert.equal(short.symbol, "3481"); assert.equal(short.direction, "short"); assert.equal(short.action, "Sell");
  assert.equal(short.condition, "SHORT_SELLING"); assert.equal(short.lot, "Common"); assert.equal(short.quantity, 1000);
  assert.equal(short.proposed_limit, null); assert.equal(short.conditions, null);
  assert.equal((short.reference_notes as any).price_assumption, "upper"); assert.equal((short.reference_notes as any).borrow, "UNKNOWN");
});

test("create/revise/pause/resume/cancel pin exact versions and preserve backend validation", async () => {
  const f = fixture(); await f.session.refresh(); assert.equal(writes(f.calls).length, 0);
  f.session.owner("test-owner"); f.session.edit(candidateExample()); await f.session.save();
  assert.deepEqual(writes(f.calls)[0], { name: "omi_create_candidate", args: { owner_id: "MCP", raw: candidateExample() } });
  assert.deepEqual(f.session.state.detail?.validation_reasons, ["INCOMPLETE_DATE"]);
  f.session.edit({ ...f.session.state.draft, quantity: 2 }); await f.session.save();
  assert.equal(writes(f.calls)[1].args.expected_revision, 1);
  for (const [operation, expected] of [["pause", 2], ["resume", 3], ["cancel", 4]] as const) {
    await f.session.action(operation); assert.equal(writes(f.calls).at(-1)!.args.expected_revision, expected);
  }
  assert.equal(f.session.state.detail?.state, "CANCELLED");
  assert.ok(f.calls.every(({ name }) => !/prepare|approve|broker|sdk/.test(name)));
});

test("pending uses its own revision and decimal text, not candidate revision", async () => {
  const f = fixture(); await f.session.select(f.record.id);
  await f.session.changePending(f.item, "12.35", 1000);
  assert.deepEqual(writes(f.calls)[0], { name: "omi_revise_candidate_pending", args: { id: "fixture-p", expected_revision: 3, price: "12.35", quantity: 1000 } });
  await f.session.changePending(f.item);
  assert.deepEqual(writes(f.calls)[1], { name: "omi_cancel_candidate_pending", args: { id: "fixture-p", expected_revision: 5 } });
});

test("polling preserves dirty draft/base while new persisted revision is visible", async () => {
  const f = fixture(); await f.session.select(f.record.id);
  f.session.edit({ ...f.session.state.draft, quantity: 9 });
  f.record = { ...f.record, revision: 7, raw: { ...f.record.raw, quantity: 7 } };
  await f.session.refresh(); assert.equal(f.session.state.baseRevision, 1); assert.equal(f.session.state.draft.quantity, 9);
  assert.equal(f.session.state.detail?.revision, 7); assert.equal(f.session.state.dirty, true);
  f.session.adopt(); assert.equal(f.session.state.baseRevision, 7); assert.equal(f.session.state.draft.quantity, 7);
});

test("read/list errors and malformed data retain labelled prior evidence, with no fake empty success", async () => {
  const f = fixture(); await f.session.select(f.record.id); const before = f.session.state;
  f.setFault((name) => { if (name.startsWith("omi_read") || name === "omi_list_candidates") throw new Error("fixture offline"); });
  await f.session.refresh(); assert.equal(f.session.state.rows, before.rows); assert.equal(f.session.state.detail, before.detail);
  assert.equal(f.session.state.pending, before.pending); assert.match(f.session.state.errors.rows, /offline/);
  f.setFault((name) => name === "omi_list_candidates" ? { structuredContent: { malformed: true } } : undefined);
  await f.session.refresh(); assert.equal(f.session.state.rows, before.rows); assert.match(f.session.state.errors.rows, /格式/);
});

test("version conflict keeps draft; the next read does not silently rebase", async () => {
  const f = fixture(); await f.session.select(f.record.id); f.session.edit({ ...f.record.raw, quantity: 11 });
  f.record = { ...f.record, revision: 8 };
  f.setFault((name) => name === "omi_revise_candidate" ? { isError: true, structuredContent: { error: 'OMI API HTTP 409: {"detail":{"code":"STALE_CANDIDATE_REVISION"}}' } } : undefined);
  await f.session.save(); assert.match(f.session.state.notice, /STALE_CANDIDATE_REVISION/);
  assert.equal(f.session.state.draft.quantity, 11); assert.equal(f.session.state.baseRevision, 1); assert.equal(f.session.state.detail?.revision, 8);
});

test("timeout writes once, reads current record, and requires explicit adoption before another edit", async () => {
  const f = fixture(); await f.session.select(f.record.id); f.session.edit({ ...f.record.raw, quantity: 2 });
  f.setFault((name) => { if (name === "omi_revise_candidate") { f.record = { ...f.record, revision: 2 }; throw new Error("timed out"); } });
  await f.session.save(); assert.equal(writes(f.calls).length, 1); assert.equal(f.session.state.uncertain, true);
  assert.equal(f.session.state.detail?.revision, 2); assert.equal(f.session.state.baseRevision, 1);
  await f.session.save(); assert.equal(writes(f.calls).length, 1);
  f.session.adopt(); assert.equal(f.session.state.uncertain, false); assert.equal(f.session.state.baseRevision, 2);
});

test("UNKNOWN create cannot be unlocked by a successful list or adopt, even after Backend created a record", async () => {
  const f = fixture(); f.session.owner("fixture-owner"); f.session.edit(candidateExample());
  f.setFault((name) => { if (name === "omi_create_candidate") throw new Error("timed out after commit"); });
  await f.session.save(); assert.equal(f.session.state.readback, true); assert.equal(f.session.state.uncertain, true);
  f.session.adopt(); f.session.discard(); f.session.start("2330"); await f.session.save();
  assert.equal(f.session.state.uncertain, true); assert.equal(writes(f.calls).length, 1);
  f.setFault((name) => { if (name === "omi_read_candidate") throw new Error("offline"); });
  await f.session.viewAfterUnknownCreate(f.record.id); await f.session.save();
  assert.equal(f.session.state.uncertain, true); assert.equal(writes(f.calls).length, 1, "failed explicit view cannot unlock old create");
  f.setFault(null); await f.session.viewAfterUnknownCreate(f.record.id);
  assert.equal(f.session.state.detail?.id, f.record.id); assert.equal(f.session.state.uncertain, false);
  assert.equal(writes(f.calls).length, 1, "explicit view does not send another create");
});

test("UNKNOWN create can only abandon the old body via explicit blank reconstruction", async () => {
  const f = fixture(); f.session.owner("fixture-owner"); f.session.edit(candidateExample());
  f.setFault((name) => { if (name === "omi_create_candidate") throw new Error("timed out"); });
  await f.session.save(); f.session.rebuildAfterUnknownCreate();
  assert.equal(f.session.state.uncertain, false); assert.deepEqual(f.session.state.draft, newCandidate());
  assert.match(f.session.state.notice, /前次建立結果仍未知/); assert.equal(writes(f.calls).length, 1);
});

test("UNKNOWN Pending requires its own successful readback and preserves an unsaved Candidate draft", async () => {
  const f = fixture(); await f.session.select(f.record.id); f.session.edit({ ...f.record.raw, quantity: 9 });
  f.setFault((name) => { if (name === "omi_revise_candidate_pending" || name === "omi_read_candidate_pending") throw new Error("timed out"); });
  await f.session.changePending(f.item, "12", 1);
  assert.equal(f.session.state.uncertain, true); assert.equal(f.session.state.readback, false);
  f.session.adopt(); f.session.acknowledgePendingReadback(); assert.equal(f.session.state.uncertain, true);
  f.setFault(null); await f.session.refresh(); assert.equal(f.session.state.readback, true);
  f.session.acknowledgePendingReadback(); assert.equal(f.session.state.uncertain, false);
  assert.equal(f.session.state.draft.quantity, 9); assert.equal(f.session.state.dirty, true);
  assert.equal(writes(f.calls).length, 1);
});

test("duplicate mutation clicks are single-flight", async () => {
  const f = fixture(); await f.session.select(f.record.id); f.session.edit({ ...f.record.raw, quantity: 5 });
  let finish!: (value: unknown) => void;
  f.setFault((name) => name === "omi_revise_candidate" ? new Promise((resolve) => { finish = resolve; }) : undefined);
  const first = f.session.save(); const second = f.session.save();
  assert.equal(writes(f.calls).length, 1);
  f.record = { ...f.record, revision: 2, raw: f.session.state.draft };
  finish({ structuredContent: f.record }); await Promise.all([first, second]); assert.equal(f.session.state.baseRevision, 2);
});

test("a pre-mutation delayed read cannot replace the saved revision or draft", async () => {
  const f = fixture(); await f.session.select(f.record.id);
  let finish!: (value: unknown) => void, captured = false;
  const old = structuredClone(f.record);
  f.setFault((name) => {
    if (name === "omi_read_candidate" && !captured) {
      captured = true; return new Promise((resolve) => { finish = resolve; });
    }
  });
  const delayedRead = f.session.refresh();
  f.session.edit({ ...f.record.raw, quantity: 6 }); await f.session.save();
  assert.equal(f.session.state.detail?.revision, 2);
  finish({ structuredContent: old }); await delayedRead;
  assert.equal(f.session.state.detail?.revision, 2); assert.equal(f.session.state.draft.quantity, 6);
});

test("array/text MCP decoding and HTTP errors retain reasons", () => {
  assert.deepEqual(toolValue({ structuredContent: { result: [] } }), []);
  assert.deepEqual(toolValue({ content: [{ type: "text", text: '[{"id":"fixture"}]' }] }), [{ id: "fixture" }]);
  assert.throws(() => toolValue({ isError: true, structuredContent: { error: "BORROW_UNKNOWN" } }), /BORROW_UNKNOWN/);
});

test("symbol sync updates the loaded-row filter and new draft; all remains an explicit option", async () => {
  const f = fixture("2330");
  const short = { ...f.record, id: "short-c", raw: candidateExample(true) };
  f.setFault((name) => name === "omi_list_candidates" ? { structuredContent: { result: [f.record, short] } } : undefined);
  await f.session.refresh(); assert.deepEqual(visibleCandidates(f.session.state).map((row) => row.raw.symbol), ["2330"]);
  f.session.setShowAll(true); assert.equal(visibleCandidates(f.session.state).length, 2);
  f.session.syncSymbol("3481"); assert.equal(f.session.state.showAll, false);
  assert.equal(f.session.state.scopeSymbol, "3481"); assert.deepEqual(visibleCandidates(f.session.state).map((row) => row.raw.symbol), ["3481"]);
  f.session.start(); assert.equal(f.session.state.view, "new"); assert.equal(f.session.state.draft.symbol, "3481");
  assert.equal(writes(f.calls).length, 0);
});

test("list, detail and edit/new are exclusive views, and a successful save returns to detail", async () => {
  const f = fixture("2330"); assert.equal(f.session.state.view, "list");
  await f.session.select(f.record.id); assert.equal(f.session.state.view, "detail");
  f.session.beginEdit(); assert.equal(f.session.state.view, "edit");
  f.session.edit({ ...f.record.raw, quantity: 7 }); assert.equal(f.session.backToList(), false);
  await f.session.save(); assert.equal(f.session.state.view, "detail");
  assert.equal(f.session.backToList(), true); assert.equal(f.session.state.view, "list");
  f.session.start(); assert.equal(f.session.state.view, "new"); assert.equal(f.session.state.draft.symbol, "2330");
});

test("dirty symbol switch is explicit; keeping the edit preserves identity/revision until save", async () => {
  const f = fixture("2330"); await f.session.select(f.record.id); f.session.beginEdit();
  f.session.edit({ ...f.record.raw, quantity: 9 }); f.session.syncSymbol("3481");
  assert.equal(f.session.state.scopeSymbol, "2330"); assert.equal(f.session.state.pendingSymbol, "3481");
  assert.equal(f.session.state.draft.quantity, 9); assert.equal(f.session.state.baseRevision, 1);
  f.session.keepEditing(); assert.equal(f.session.state.pendingSymbol, null); assert.equal(f.session.state.requestedSymbol, "3481");
  await f.session.save(); assert.equal(writes(f.calls)[0].args.expected_revision, 1);
  assert.equal((writes(f.calls)[0].args.raw as any).symbol, "2330");
  assert.equal(f.session.backToList(), true); assert.equal(f.session.state.scopeSymbol, "3481");
  f.session.start(); assert.equal(f.session.state.draft.symbol, "3481");
});

test("explicit discard switches the filter/draft without writing; latest requested symbol wins", async () => {
  const f = fixture("2330"); f.session.start(); f.session.edit(candidateExample());
  f.session.syncSymbol("3481"); f.session.syncSymbol("0050"); f.session.discardAndSwitch();
  assert.equal(f.session.state.view, "list"); assert.equal(f.session.state.scopeSymbol, "0050");
  assert.equal(f.session.state.draft.symbol, "0050"); assert.equal(f.session.state.dirty, false);
  assert.equal(writes(f.calls).length, 0);
});

test("a stock change cannot clear UNKNOWN create or unlock a duplicate create", async () => {
  const f = fixture("2330"); f.session.owner("fixture"); f.session.edit(candidateExample());
  f.setFault((name) => { if (name === "omi_create_candidate") throw new Error("timed out"); });
  await f.session.save(); f.session.syncSymbol("3481"); f.session.discardAndSwitch(); f.session.adopt();
  assert.equal(f.session.state.uncertain, true); assert.equal(f.session.state.scopeSymbol, "2330");
  assert.equal(f.session.backToList(true), false); await f.session.save(); assert.equal(writes(f.calls).length, 1);
});

test("unsaved Pending fields guard stock/navigation switches independently of Candidate dirty state", async () => {
  const f = fixture("2330"); await f.session.select(f.record.id);
  f.session.setPendingDirty("fixture-p", true); f.session.syncSymbol("3481");
  assert.equal(f.session.state.dirty, false); assert.equal(f.session.state.pendingDirty, true);
  assert.equal(f.session.state.pendingSymbol, "3481"); assert.equal(f.session.backToList(), false);
  f.session.beginEdit(); assert.equal(f.session.state.view, "detail"); await f.session.action("pause"); assert.equal(writes(f.calls).length, 0);
  f.session.discardAndSwitch(); assert.equal(f.session.state.scopeSymbol, "3481"); assert.equal(f.session.state.pendingDirty, false);
});
