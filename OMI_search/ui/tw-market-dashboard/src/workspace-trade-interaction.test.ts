import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { orderQuantityShares } from "./WorkspaceContext";
import { fixtureReadback, fixtureReview, fixtureStage } from "../scripts/desk-fixture";
import type { CandidateBridge } from "./candidate-state";

// Real handlers/effects with controlled hooks; browser geometry is checked by
// the offline iframe fixture, not inferred from this harness.
const output = await build({
  stdin: { contents: 'export { ManualOrderForm, WorkspaceContext } from "./WorkspaceContext"; export { DeskOrders } from "./DeskOrders";', resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  plugins: [{ name: "controlled-trade", setup(builder) {
    builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, (args) => ({ path: args.path, namespace: "controlled" }));
    builder.onLoad({ filter: /.*/, namespace: "controlled" }, (args) => ({ contents: args.path === "react"
      ? "export const {useState,useEffect,useMemo,useRef}=globalThis.hooks;"
      : "export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment='fragment';" }));
  } }],
});

function harness(component: "ManualOrderForm" | "WorkspaceContext" | "DeskOrders", suppliedBridge?: CandidateBridge, candidateId?: string) {
  let cursor = 0, dirty = false, symbol = "2330", tree: any;
  const slots: any[] = [];
  let effects: (() => void)[] = [];
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [slots[index].value, (value: any) => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; dirty = true; }];
    },
    useRef(value: unknown) { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; },
    useEffect(fn: () => void, deps: unknown[]) {
      const index = cursor++;
      if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index].deps[i]))) {
        effects.push(() => { slots[index] = { deps }; fn(); });
      }
    },
  };
  const module = { exports: {} as any };
  const noIO = () => { throw Error("Unexpected broker or storage IO"); };
  vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, hooks, setInterval: () => 1, clearInterval: () => {}, crypto: { randomUUID: () => "83771cec-bd72-4dd9-bb65-132ea523997b" }, fetch: noIO, localStorage: { setItem: noIO } });
  const bridge = suppliedBridge ?? { callTool: noIO };
  function render() {
    let rounds = 0;
    do {
      cursor = 0; dirty = false; effects = [];
      tree = module.exports[component]({ symbol, bridge, active: true, refreshKey: 0, candidateId });
      effects.forEach((fn) => fn());
      assert.ok(++rounds < 10, "effects converge");
    } while (dirty);
  }
  const flatten = (node: any): any[] => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(flatten)];
  const text = (node: any): string => typeof node === "string" || typeof node === "number" ? String(node)
    : node && typeof node === "object" ? [node.props?.children].flat(Infinity).map(text).join("") : "";
  const find = (predicate: (node: any) => boolean) => { const node = flatten(tree).find(predicate); assert.ok(node); return node; };
  const button = (name: string) => find((node) => node.type === "button" && text(node) === name);
  const input = (name: string) => find((node) => node.type === "input" && node.props["aria-label"] === name);
  const click = (name: string) => { const node = button(name); assert.ok(!node.props.disabled); node.props.onClick(); render(); };
  const change = (name: string, value: string) => { input(name).props.onChange({ target: { value } }); render(); };
  render();
  return { button, input, click, change, find, text: (node = tree) => text(node), select(value: string) { symbol = value; render(); }, async settle() { await new Promise(resolve => setImmediate(resolve)); render(); } };
}

test("four condition buttons normalize legal direction and every non-CASH mode excludes Odd", () => {
  const h = harness("ManualOrderForm");
  for (const [name, side] of [["現先賣", "賣出"], ["融資", "買進"], ["融券", "賣出"]]) {
    h.click("現股"); h.click("零股"); h.click(side === "買進" ? "賣出" : "買進");
    h.click(name);
    assert.equal(h.button(side).props["aria-pressed"], true, name);
    assert.equal(h.button(side === "買進" ? "賣出" : "買進").props.disabled, true, name);
    assert.equal(h.button("整股").props["aria-pressed"], true, name);
    assert.equal(h.button("零股").props.disabled, true, name);
  }
  h.click("現股");
  assert.equal(h.button("買進").props.disabled, false);
  assert.equal(h.button("賣出").props.disabled, false);
  h.click("賣出"); h.click("零股");
  assert.equal(h.button("零股").props["aria-pressed"], true);
});

test("clean ticket follows selection, while dirty ticket retains symbol and clears price only on explicit adoption", () => {
  const h = harness("ManualOrderForm");
  h.select("0050"); assert.equal(h.input("委託股票代碼").props.value, "0050");
  assert.equal(h.input("委託價格").props.value, "");
  h.change("委託價格", "100"); h.change("委託數量", "1"); h.select("2303");
  assert.equal(h.input("委託股票代碼").props.value, "0050");
  assert.equal(h.input("委託價格").props.value, "100");
  assert.match(h.text(), /表單保留 0050；工作台 2303/);
  h.click("使用目前選股並清空價格");
  assert.equal(h.input("委託股票代碼").props.value, "2303");
  assert.equal(h.input("委託價格").props.value, "");
  assert.equal(h.input("委託數量").props.value, "1");
});

test("no broker contract means empty price, disabled shortcuts and no send transport", () => {
  const h = harness("ManualOrderForm");
  for (const label of ["跌停", "平盤", "漲停", "市價"]) assert.equal(h.button(label).props.disabled, true);
  assert.equal(h.find(node => node.type === "button" && node.props.className === "workspace-order-submit").props.type, "submit");
  assert.equal(h.input("委託價格").props.value, "");
  let prevented = false;
  h.find((node) => node.type === "form").props.onSubmit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test("candidate stays mounted while polling is active only on trade/conditional", () => {
  const h = harness("WorkspaceContext");
  const panel = () => h.find((node) => typeof node.type === "function" && node.type.name === "CandidatePanel");
  const identity = panel().type;
  assert.equal(panel().props.active, false);
  h.click("條件交易"); assert.equal(panel().props.active, true);
  for (const page of ["掛單", "成交", "庫存"]) {
    h.click(page); assert.equal(panel().props.active, false); assert.equal(panel().type, identity);
    h.click("交易"); assert.equal(panel().props.active, true);
  }
  h.click("一般"); assert.equal(panel().props.active, false);
  h.select("2303"); assert.equal(panel().props.symbol, "2303"); assert.equal(panel().type, identity);
  h.click("條件交易"); assert.equal(panel().props.active, true);
  h.click("我的交易"); assert.equal(panel().props.active, true); assert.equal(panel().props.space, "USER_SPACE"); assert.equal(panel().type, identity);
  assert.match(h.text(), /AI 候選供檢視與管理/);
  h.click("AI 候選"); assert.equal(panel().props.active, true); assert.equal(panel().props.space, "AGENT_SPACE"); assert.equal(panel().type, identity);
});

test("quantity is explicitly converted from Common lots or Odd shares without unsafe numeric coercion", () => {
  assert.equal(orderQuantityShares("Common", "1"), 1000);
  assert.equal(orderQuantityShares("Odd", "1"), 1);
  for (const value of ["", "0", "-1", "1.5", "1e3", " 1", "NaN", "Infinity", "9007199254741"]) assert.equal(orderQuantityShares("Common", value), null, value);
  assert.equal(orderQuantityShares("OTHER", "1"), null);
  const h = harness("ManualOrderForm");
  h.change("委託數量", "1"); assert.match(h.text(), /1 張 \/ 1,000 股/);
  h.click("零股"); assert.equal(h.input("委託數量").props.value, ""); assert.match(h.text(), /交易單位已切換/);
  h.change("委託數量", "1"); assert.match(h.text(), /零股 · 1 股/);
  for (const condition of ["現先賣", "融資", "融券"]) {
    h.click(condition); assert.equal(h.input("委託數量").props.value, "");
    h.change("委託數量", "1"); assert.match(h.text(), /整股 · 1 張 \/ 1,000 股/);
    h.click("現股"); h.click("零股"); h.change("委託數量", "2");
  }
  h.click("整股"); assert.equal(h.input("委託數量").props.value, "");
});

test("draft timeout preserves one stable intent, reads the original local stage, and never retries creation or sends", async () => {
  const calls: { name: string; args: any }[] = [];
  let created: any;
  const h = harness("ManualOrderForm", { async callTool(name, args) {
    calls.push({ name, args });
    if (name === "omi_create_desk_draft") { created = fixtureStage(args); throw Error("timeout after local commit"); }
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [created] } };
    throw Error("Unexpected send");
  } });
  h.change("委託價格", "100.25"); h.change("委託數量", "1");
  const form = h.find(node => node.type === "form");
  form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.equal(calls.filter(call => call.name === "omi_create_desk_draft").length, 1);
  assert.equal(calls[0].args.client_intent_id, "83771cec-bd72-4dd9-bb65-132ea523997b");
  assert.equal(calls[0].args.quantity_shares, 1000); assert.match(h.text(), /原 client_intent_id/);
  assert.ok(calls.every(call => !/confirm|approve/.test(call.name)));
  assert.equal(h.button("已加入掛單").props.disabled, true);
});

test("unresolved draft identity stays locked after empty readback, including HTTP 409 CHECK_STATUS_DO_NOT_RESEND", async () => {
  const calls: any[] = [];
  const h = harness("ManualOrderForm", { async callTool(name, args) {
    calls.push({ name, args });
    if (name === "omi_create_desk_draft") throw Error('OMI API HTTP 409: {"retry_policy":"CHECK_STATUS_DO_NOT_RESEND"}');
    return { structuredContent: { result: [] } };
  } });
  h.change("委託價格", "100"); h.change("委託數量", "1");
  h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.match(h.text(), /UNKNOWN/);
  h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.equal(calls.filter(call => call.name === "omi_create_desk_draft").length, 1);
  const intent = calls[0].args.client_intent_id;
  assert.ok(intent);
  h.click("\u8b80\u56de\u539f\u610f\u5716\uff08\u4e0d\u91cd\u9001\uff09"); await h.settle();
  assert.match(h.text(), /UNKNOWN/);
  assert.equal(calls.filter(call => call.name === "omi_create_desk_draft").length, 1);
  assert.equal(calls[0].args.client_intent_id, intent);
  assert.ok(calls.slice(1).every(call => call.name === "omi_read_desk_staged"));
});

test("cancelling the existing Desk confirmation clears selection with zero confirm/approve calls", async () => {
  const calls: string[] = [];
  const h = harness("DeskOrders", { async callTool(name) {
    calls.push(name);
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [] } };
    assert.equal(name, "omi_read_desk_orders", "no send is authorized by cancelling");
    return { structuredContent: fixtureReadback([fixtureReview()]) };
  } });
  await h.settle();
  h.click("\u9001\u55ae");
  const modal = h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal");
  modal.props.cancel(); await h.settle();
  // Even a stale confirmation handler cannot consume the cancelled selection.
  modal.props.confirm(); await h.settle();
  assert.deepEqual(calls, ["omi_read_desk_staged", "omi_read_desk_orders"]);
});

test("successful local create preserves raw intent and selection changes retain a dirty ticket", async () => {
  const calls: any[] = [];
  const h = harness("ManualOrderForm", { async callTool(name, args) {
    calls.push({ name, args }); assert.equal(name, "omi_create_desk_draft");
    return { structuredContent: fixtureStage(args) };
  } });
  h.change("委託價格", "578"); h.click("零股"); h.change("委託數量", "50"); h.select("3105");
  assert.equal(h.input("委託股票代碼").props.value, "2330");
  h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].args.quantity_shares, 50);
  assert.equal(h.button("已加入掛單").props.disabled, true);
});

for (const failure of ["timeout", "503", "UNKNOWN", "mismatched-id"]) {
  test(`local stage stays visible offline; modal ${failure} only reads original ID and never resends`, async () => {
    const original: any = fixtureStage(), calls: { name: string; args: any }[] = [];
    const h = harness("DeskOrders", { async callTool(name, args) {
      calls.push({ name, args });
      if (name === "omi_read_desk_staged") return { structuredContent: { result: [original] } };
      if (name === "omi_read_desk_stage") { assert.equal(args.id, original.id); return { structuredContent: original }; }
      if (name === "omi_read_desk_orders") throw Error("OMI API HTTP 503: Native missing");
      assert.equal(name, "omi_confirm_desk_staged");
      assert.deepEqual(args, { id: original.id, expected_revision: original.revision, expected_digest: original.digest });
      if (failure === "timeout" || failure === "503") throw Error(failure);
      return { structuredContent: { ...original, id: failure === "mismatched-id" ? "wrong" : original.id, revision: 2,
        manual_stage: { ...original.manual_stage, state: "SUBMISSION_UNKNOWN", submission: { pin: { revision: 1, digest: original.digest } } } } };
    } });
    await h.settle(); assert.match(h.text(), /Native missing/); assert.match(h.text(), /本地掛單/);
    h.click("送單");
    let modal = h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal");
    modal.props.cancel(); await h.settle();
    assert.equal(calls.filter(call => /confirm|approve/.test(call.name)).length, 0);
    h.click("送單"); modal = h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal");
    modal.props.confirm(); modal.props.confirm(); await h.settle(); await h.settle();
    assert.equal(calls.filter(call => /confirm|approve/.test(call.name)).length, 1);
    assert.ok(calls.some(call => call.name === "omi_read_desk_stage"));
    assert.match(h.text(), /操作結果待確認/);
    assert.equal(h.button("送單").props.disabled, true);
    h.click("讀回"); await h.settle();
    modal.props.confirm(); await h.settle();
    assert.equal(calls.filter(call => /confirm|approve/.test(call.name)).length, 1);
  });
}

test("local revision and cancellation keep ID, raw intent and exact revision without Native", async () => {
  let row: any = fixtureStage(); const calls: any[] = [];
  const h = harness("DeskOrders", { async callTool(name, args) {
    calls.push({ name, args });
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [row] } };
    if (name === "omi_read_desk_orders") throw Error("503 Native missing");
    assert.equal(args.id, row.id); assert.equal(args.expected_revision, row.revision);
    if (name === "omi_revise_candidate") { assert.equal((args.raw as any).client_intent_id, row.raw.client_intent_id); row = { ...row, raw: args.raw, revision: 2, digest: "d".repeat(64) }; }
    else { assert.equal(name, "omi_cancel_candidate"); row = { ...row, revision: 3, state: "CANCELLED", lifecycle: "CANCELLED" }; }
    return { structuredContent: row };
  } });
  await h.settle(); h.click("修改"); h.change("修改價格", "101.25"); h.select("3105");
  assert.equal(h.input("修改價格").props.value, "101.25");
  h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await h.settle();
  h.click("刪除"); await h.settle(); assert.match(h.text(), /CANCELLED/);
  assert.equal(calls.filter(call => call.name === "omi_revise_candidate").length, 1);
  assert.equal(calls.filter(call => call.name === "omi_cancel_candidate").length, 1);
  assert.ok(calls.every(call => !/confirm|approve|create/.test(call.name)));
});

test("slow broker read never delays local stage rendering or opens a Native call before confirmation", async () => {
  const calls: string[] = [];
  const h = harness("DeskOrders", { callTool(name) {
    calls.push(name);
    if (name === "omi_read_desk_staged") return Promise.resolve({ structuredContent: { result: [fixtureStage()] } });
    assert.equal(name, "omi_read_desk_orders");
    return new Promise(() => {});
  } });
  await h.settle(); h.click("修改"); h.change("修改價格", "578.00");
  assert.equal(h.input("修改價格").props.value, "578.00");
  assert.deepEqual(calls, ["omi_read_desk_staged", "omi_read_desk_orders"]);
});

function returned2409(state = "PENDING", lifecycle = "SUBMISSION_PENDING") {
  const original: any = fixtureStage({ symbol: "2409", action: "Sell", price: "33.7", quantity_shares: 1000 });
  original.id = "281692ad4b581eef2fe87453ba8a0b0df21dfabb882e01ab85efb189a4a83edd";
  const review: any = fixtureReview(original.raw);
  review.draft.command.trade_date = "2026-11-02";
  // Native intent is independently pinned; it is not the UI client intent ID.
  review.draft.command.intent_id = review.draft.command.request_id = "fixture-native-intent-2409";
  review.snapshot.draft = structuredClone(review.draft);
  review.state = "EXECUTION"; review.execution_id = "exec-fixture-2409";
  review.execution = { execution_id: review.execution_id, intent_id: review.draft.command.intent_id, trade_date: "2026-11-02",
    state, broker_order_id: state === "ACCEPTED" ? "fixture-order-2409" : null, submit_stage: "RETURNED", broker_attempts_max: 1, reconcile_required: state === "PENDING" || state === "UNKNOWN" };
  const row = { ...original, revision: 5, digest: "e".repeat(64), lifecycle,
    manual_stage: { ...original.manual_stage, state: lifecycle, submission: {
      pin: { revision: original.revision, digest: original.digest }, phase: "RESULT", native_intent_id: review.draft.command.intent_id,
      draft: structuredClone(review.draft), native: { review_id: review.review_id, review_revision: review.review_revision, digest: review.snapshot.digest }, receipt: structuredClone(review),
    } } };
  const data: any = { ...fixtureReadback([review]), trade_date: "2026-11-02", broker_orders: [],
    unparsed_reports: [{ fields: { StockNo: "2409", Price: "33.7", BS: "S", Qty: "1", ErrCode: "MAT0095", OrderNo: "0000" } }] };
  return { original, row, review, data };
}

test("PARTIAL MAT0095/0000 appears only as a global unassociated-report notice and preserves Stage Pending", async () => {
  const f = returned2409(), before = JSON.stringify(f.row);
  const h = harness("DeskOrders", { async callTool(name) {
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [f.row] } };
    assert.equal(name, "omi_read_desk_orders"); return { structuredContent: f.data };
  } });
  await h.settle();
  const broker = h.find(node => node.props["aria-label"] === "券商委託");
  assert.match(h.text(broker), /有 1 筆券商回報無法確認委託身分，請查看詳細資訊。/);
  const card = h.text(h.find(node => node.props["aria-label"] === "2409 本地掛單"));
  assert.match(card, /券商結果待確認/); assert.doesNotMatch(card, /回報無法確認委託身分|遭拒絕|已掛單|MAT0095|0000/);
  assert.equal(f.row.lifecycle, "SUBMISSION_PENDING"); assert.equal(JSON.stringify(f.row), before);
});

test("2409 reopened Pending remains returned and uncertain; exact Native readback updates a separate layer without mutation", async () => {
  const f = returned2409(), before = JSON.stringify(f.row), calls: any[] = [];
  const h = harness("DeskOrders", { async callTool(name, args) {
    calls.push({ name, args });
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [f.row] } };
    if (name === "omi_read_desk_stage") { assert.equal(args.id, f.row.id); return { structuredContent: f.row }; }
    assert.equal(name, "omi_read_desk_orders"); return { structuredContent: structuredClone(f.data) };
  } });
  await h.settle();
  assert.match(h.text(), /券商結果待確認/); assert.match(h.text(), /送單請求已返回/);
  assert.doesNotMatch(h.text(), /正在送出|遭拒絕|已掛單|操作結果待確認/);
  assert.equal(h.button("讀回").props.disabled, false);
  f.review.execution = { ...f.review.execution, state: "ACCEPTED", broker_order_id: "fixture-order-2409", reconcile_required: false };
  h.click("讀回"); await h.settle();
  assert.match(h.text(), /券商階段讀回：已受理/);
  assert.match(h.text(), /券商結果待確認/);
  assert.equal(JSON.stringify(f.row), before, "Native state never overwrites Candidate lifecycle/receipt");
  assert.deepEqual(calls.slice(-2).map(call => call.name).sort(), ["omi_read_desk_orders", "omi_read_desk_stage"]);
  assert.ok(calls.every(call => !/confirm|approve|create|revise|cancel/.test(call.name)));
});

for (const [state, lifecycle, label] of [
  ["PENDING", "SUBMISSION_PENDING", "券商結果待確認"], ["ACCEPTED", "SUBMITTED", "已送出"],
  ["REJECTED", "SUBMISSION_REJECTED", "遭拒絕"], ["CANCELLED", "SUBMISSION_CANCELLED", "已撤銷"],
  ["UNKNOWN", "SUBMISSION_UNKNOWN", "送單結果待確認"],
]) test(`successful staged confirm ${state} keeps business truth and clears no ID latch`, async () => {
  const f = returned2409(state, lifecycle), calls: any[] = []; let current = f.original;
  const h = harness("DeskOrders", { async callTool(name, args) {
    calls.push({ name, args });
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [current] } };
    if (name === "omi_read_desk_orders") return { structuredContent: f.data };
    if (name === "omi_read_desk_stage") return { structuredContent: current };
    assert.equal(name, "omi_confirm_desk_staged");
    assert.deepEqual({ ...args }, { id: f.original.id, expected_revision: 1, expected_digest: f.original.digest });
    current = f.row; return { structuredContent: current };
  } });
  await h.settle(); h.click("送單");
  const modal = h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal");
  modal.props.confirm(); modal.props.confirm(); await h.settle(); await h.settle();
  assert.match(h.text(), new RegExp(label));
  assert.doesNotMatch(h.text(), /操作結果待確認/);
  assert.equal(h.button("讀回").props.disabled, false);
  h.click("讀回"); await h.settle();
  // Even a stale STAGED list cannot discard the consumed original ID latch.
  current = f.original; h.click("更新委託"); await h.settle();
  assert.equal(h.button("送單").props.disabled, true);
  modal.props.confirm(); await h.settle();
  assert.equal(calls.filter(call => /confirm|approve/.test(call.name)).length, 1);
});

test("transport unknown survives partial/mismatched/503 readback, then only exact stage + Native proof clears the UI warning", async () => {
  const f = returned2409(), calls: any[] = []; let current = f.original, mode = "503";
  const h = harness("DeskOrders", { async callTool(name, args) {
    calls.push({ name, args });
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [current] } };
    if (name === "omi_read_desk_stage") return { structuredContent: current };
    if (name === "omi_read_desk_orders") {
      if (mode === "503") throw Error("503 readback unavailable");
      const value = structuredClone(f.data);
      if (mode === "partial") value.reviews = [];
      if (mode === "mismatch") value.reviews[0].review_revision++;
      return { structuredContent: value };
    }
    assert.equal(name, "omi_confirm_desk_staged"); throw Error("transport timeout after send");
  } });
  await h.settle(); h.click("送單");
  const modal = h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal");
  modal.props.confirm(); await h.settle(); await h.settle();
  assert.match(h.text(), /操作結果待確認/);
  current = f.row;
  for (mode of ["partial", "mismatch", "503"]) {
    h.click("讀回"); await h.settle(); assert.match(h.text(), /操作結果待確認/);
    assert.equal(h.button("讀回").props.disabled, false);
  }
  mode = "valid";
  h.click("更新委託"); await h.settle(); assert.match(h.text(), /操作結果待確認/, "list + reviews cannot clear a Candidate ID warning");
  h.click("讀回"); await h.settle();
  assert.doesNotMatch(h.text(), /操作結果待確認/); assert.match(h.text(), /券商結果待確認/);
  assert.equal(f.row.manual_stage.submission.receipt.execution.broker_order_id, null);
  current = f.original; h.click("更新委託"); await h.settle();
  assert.equal(h.button("送單").props.disabled, true);
  modal.props.confirm(); await h.settle();
  assert.equal(calls.filter(call => /confirm|approve/.test(call.name)).length, 1);
});

test("successful Native review readback still clears only its own temporary unknown after confirm timeout", async () => {
  const review: any = fixtureReview(), calls: any[] = []; let recovered = false;
  const h = harness("DeskOrders", { async callTool(name, args) {
    calls.push({ name, args });
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [] } };
    if (name === "omi_read_desk_orders") return { structuredContent: fixtureReadback([{ ...review, state: recovered ? "EXECUTION" : "PREVIEW", execution_id: recovered ? "exec-review" : null }]) };
    assert.equal(name, "omi_confirm_desk_review");
    assert.deepEqual({ ...args }, { id: review.review_id, expected_revision: review.review_revision, expected_digest: review.snapshot.digest });
    throw Error("review transport timeout");
  } });
  await h.settle(); h.click("送單");
  const modal = h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal");
  modal.props.confirm(); modal.props.confirm(); await h.settle(); await h.settle();
  assert.match(h.text(), /此筆結果待確認，已鎖定重送/);
  recovered = true; h.click("更新委託"); await h.settle();
  assert.doesNotMatch(h.text(), /此筆結果待確認，已鎖定重送/);
  assert.doesNotMatch(h.text(), /操作結果待確認/);
  assert.equal(calls.filter(call => /confirm|approve/.test(call.name)).length, 1);
});

test("stale or conflicting Candidate detail cannot clear unknown even when Native is exact", async () => {
  const f = returned2409(); let sent = false, validNative = false, detail = f.row;
  const h = harness("DeskOrders", { async callTool(name) {
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [sent ? f.row : f.original] } };
    if (name === "omi_read_desk_stage") return { structuredContent: detail };
    if (name === "omi_read_desk_orders") return { structuredContent: { ...f.data, reviews: validNative ? [f.review] : [] } };
    assert.equal(name, "omi_confirm_desk_staged"); sent = true; throw Error("timeout after committed submit");
  } });
  await h.settle(); h.click("送單");
  h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal").props.confirm();
  await h.settle(); await h.settle(); validNative = true;
  for (const change of [
    (row: any) => row.id = "another-candidate", (row: any) => row.revision = 4,
    (row: any) => row.digest = "d".repeat(64), (row: any) => row.raw.client_intent_id = "another-intent",
    (row: any) => row.manual_stage.submission.pin.revision = 2,
    (row: any) => row.manual_stage.submission.pin.digest = "d".repeat(64),
  ]) {
    detail = structuredClone(f.row); change(detail);
    h.click("讀回"); await h.settle();
    assert.ok(h.text().includes("操作結果待確認"), "Candidate mismatch retains the warning");
    assert.equal(h.button("讀回").props.disabled, false);
  }
  detail = f.row; h.click("讀回"); await h.settle();
  assert.doesNotMatch(h.text(), /操作結果待確認/);
});

test("single-stage local read renders while the independent Native read is still pending", async () => {
  const f = returned2409(); let current = f.row, slow = false;
  const h = harness("DeskOrders", { callTool(name) {
    if (name === "omi_read_desk_staged") return Promise.resolve({ structuredContent: { result: [current] } });
    if (name === "omi_read_desk_stage") return Promise.resolve({ structuredContent: current });
    assert.equal(name, "omi_read_desk_orders");
    return slow ? new Promise(() => {}) : Promise.resolve({ structuredContent: f.data });
  } });
  await h.settle(); slow = true;
  current = { ...f.row, revision: 6, digest: "d".repeat(64), lifecycle: "SUBMISSION_CANCELLED" };
  h.click("讀回"); await h.settle();
  assert.match(h.text(), /已撤銷/);
  assert.equal(h.button("讀回").props.disabled, false);
});

test("Pending timeout retains its own ID warning when a different Native review recovers; original approve stays one-shot", async () => {
  const review: any = fixtureReview(), candidate = { id: "candidate-conditional", revision: 2, owner_id: "MCP", raw: { space_id: "USER_SPACE", source: "MANUAL", symbol: "2330", lot: "Common", conditions: {} } };
  const pending = { id: "pending-conditional", candidate_id: candidate.id, candidate_revision: 2, revision: 5, digest: "b".repeat(64), state: "NATIVE_PREVIEW", price: "100.25", quantity: 1000,
    native: { review_id: review.review_id, review_revision: 1, digest: review.snapshot.digest }, preparation: { draft: review.draft } };
  const calls: any[] = [];
  const h = harness("DeskOrders", { async callTool(name, args) {
    calls.push({ name, args });
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [] } };
    if (name === "omi_read_desk_orders") return { structuredContent: fixtureReadback([{ ...review, state: "EXECUTION", execution_id: "exec-pending" }]) };
    if (name === "omi_read_candidate") return { structuredContent: candidate };
    if (name === "omi_read_candidate_pending") return { structuredContent: { result: [pending] } };
    assert.equal(name, "omi_approve_candidate_pending");
    assert.deepEqual({ ...args }, { id: pending.id, expected_revision: pending.revision, expected_digest: pending.digest });
    throw Error("pending transport timeout");
  } }, candidate.id);
  await h.settle(); h.click("送單");
  const modal = h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal");
  modal.props.confirm(); modal.props.confirm(); await h.settle(); await h.settle();
  assert.match(h.text(), /結果待確認，不會自動重送/);
  h.click("更新委託"); await h.settle();
  assert.match(h.text(), /結果待確認，不會自動重送/);
  modal.props.confirm(); await h.settle();
  assert.equal(calls.filter(call => /confirm|approve/.test(call.name)).length, 1);
});
