import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { orderQuantityShares } from "./WorkspaceContext";
import { fixtureReadback, fixtureReview, fixtureStage, fixtureSubmissionError } from "../scripts/desk-fixture";
import type { CandidateBridge } from "./candidate-state";

// Real handlers/effects with controlled hooks; browser geometry is checked by
// the offline iframe fixture, not inferred from this harness.
const output = await build({
  stdin: { contents: 'export { ManualOrderForm, WorkspaceContext } from "./WorkspaceContext"; export { DeskOrders } from "./DeskOrders"; export { ResearchPanel } from "./ResearchPanel";', resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  plugins: [{ name: "controlled-trade", setup(builder) {
    builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, (args) => ({ path: args.path, namespace: "controlled" }));
    builder.onLoad({ filter: /.*/, namespace: "controlled" }, (args) => ({ contents: args.path === "react"
      ? "export const {useState,useEffect,useMemo,useRef}=globalThis.hooks;"
      : "export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment='fragment';" }));
  } }],
});

function harness(component: "ManualOrderForm" | "WorkspaceContext" | "DeskOrders" | "ResearchPanel", suppliedBridge?: CandidateBridge, candidateId?: string, properties: Record<string, any> = {}) {
  let cursor = 0, dirty = false, symbol = "2330", tree: any, refreshKey = 0;
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
        effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; });
      }
    },
  };
  const module = { exports: {} as any };
  const noIO = () => { throw Error("Unexpected broker or storage IO"); };
  vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, hooks, AbortController,
    document: { hidden: false, addEventListener() {}, removeEventListener() {} }, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval: () => {}, crypto: { randomUUID: properties.uuid ?? (() => "83771cec-bd72-4dd9-bb65-132ea523997b") }, fetch: noIO, localStorage: { setItem: noIO } });
  const bridge = suppliedBridge ?? { callTool: noIO };
  function render() {
    let rounds = 0;
    do {
      cursor = 0; dirty = false; effects = [];
      tree = module.exports[component]({ symbol, bridge, active: true, refreshKey, candidateId, ...properties });
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
  return { button, input, click, change, find, all: (predicate: (node: any) => boolean) => flatten(tree).filter(predicate), hasEnabledButton: (name: string) => flatten(tree).some(node => node.type === "button" && text(node) === name && !node.props.disabled), updateProps(value: Record<string, any>) { Object.assign(properties, value); render(); }, text: (node = tree) => text(node), select(value: string) { symbol = value; render(); }, invalidate() { refreshKey++; render(); }, async settle() { await new Promise(resolve => setImmediate(resolve)); render(); } };
}

test("four condition buttons normalize legal direction and every non-CASH mode excludes Odd", () => {
  const h = harness("ManualOrderForm");
  for (const [name, side] of [["現先賣", "賣出"], ["融資", "買進"], ["融券", "賣出"]]) {
    h.click("現股"); h.click("零股"); h.click(side === "買進" ? "賣出" : "買進");
    h.click(name);
    assert.equal(h.button(side).props["aria-pressed"], true, name);
    assert.equal(h.button(side === "買進" ? "賣出" : "買進").props.disabled, name === "現先賣", name);
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

test("no quote contract means empty price, no misleading shortcuts and no send transport", () => {
  const h = harness("ManualOrderForm");
  for (const label of ["跌停", "平盤", "漲停", "市價"]) assert.throws(() => h.button(label));
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
  for (const page of ["待送單", "券商委託", "研究預選", "成交", "庫存"]) {
    h.click(page); assert.equal(panel().props.active, false); assert.equal(panel().type, identity);
    h.click("新增委託"); assert.equal(panel().props.active, true);
  }
  h.click("一般"); assert.equal(panel().props.active, false);
  h.select("2303"); assert.equal(panel().props.symbol, "2303"); assert.equal(panel().type, identity);
  h.click("條件交易"); assert.equal(panel().props.active, true);
  assert.equal(panel().props.space, "USER_SPACE"); assert.equal(panel().type, identity);
  h.click("研究預選"); assert.equal(panel().props.active, false); assert.equal(panel().props.space, "USER_SPACE"); assert.equal(panel().type, identity);
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
  assert.equal(calls[0].args.quantity_shares, 1000); assert.match(h.text(), /已加入待送單/);
  assert.equal(created.manual_stage.client_intent_id, calls[0].args.client_intent_id);
  assert.ok(calls.every(call => !/confirm|approve/.test(call.name)));
  assert.equal(h.button("加入掛單").props.disabled, false);
  assert.equal(h.input("委託數量").props.value, "");
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
  assert.equal(h.button("加入掛單").props.disabled, false);
  h.change("委託數量", "20");
  assert.doesNotMatch(h.text(), /無法加入掛單/);
});

test("UUID failure before transport exits staging and can be corrected locally", async () => {
  const calls: string[] = [];
  const h = harness("ManualOrderForm", { async callTool(name) { calls.push(name); throw Error("must not call"); } }, undefined,
    { uuid: () => { throw Error("secure context unavailable"); } });
  h.change("委託價格", "80"); h.change("委託數量", "1");
  h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.equal(h.button("加入掛單").props.disabled, false); assert.equal(calls.length, 0);
});

for (const lifecycle of ["SUBMITTED", "SUBMITTING", "CANCELLED"]) test(`intent read preserves ${lifecycle} and exact navigation`, async () => {
  let saved: any; const targets: any[] = [], calls: string[] = [];
  const h = harness("ManualOrderForm", { async callTool(name, args) {
    calls.push(name);
    if (name === "omi_create_desk_draft") { saved = fixtureStage(args); throw Error("timeout"); }
    saved.lifecycle = lifecycle; if (lifecycle === "CANCELLED") saved.state = "CANCELLED";
    return { structuredContent: { result: [saved] } };
  } }, undefined, { onStaged: (target: any) => targets.push(target) });
  h.change("委託價格", "80"); h.change("委託數量", "1");
  h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.equal(targets[0].stageId, saved.id); assert.equal(targets[0].lifecycle, lifecycle);
  assert.doesNotMatch(h.text(), /尚未送交券商/); assert.equal(calls.filter(name => name === "omi_create_desk_draft").length, 1);
});

for (const operation of ["revise", "cancel"]) test(`late list cannot overwrite ${operation}; editor stays in the original card`, async () => {
  const original: any = fixtureStage(), other: any = fixtureStage({ client_intent_id: "second", symbol: "1101" });
  let resolveOld!: (value: unknown) => void, reads = 0, updated = original;
  const h = harness("DeskOrders", { async callTool(name, args) {
    if (name === "omi_read_desk_staged") { if (++reads === 2) return new Promise(resolve => { resolveOld = resolve; }); return { structuredContent: { result: [updated, other] } }; }
    assert.equal(name, operation === "revise" ? "omi_revise_candidate" : "omi_cancel_candidate");
    updated = { ...original, revision: 2, digest: "d".repeat(64), event: operation === "revise" ? "REVISE" : "CANCEL",
      ...(operation === "revise" ? { raw: args.raw } : { lifecycle: "CANCELLED", state: "CANCELLED" }) };
    return { structuredContent: updated };
  } }, undefined, { view: "staged" });
  await h.settle(); h.click("更新清單"); await h.settle();
  h.click(operation === "revise" ? "修改" : "刪除");
  if (operation === "revise") {
    const card = h.find(node => node.props?.id === `stage-${original.id}`);
    assert.match(h.text(card), /修改 2330 的本地掛單/);
    const second = h.find(node => node.props?.id === `stage-${other.id}`);
    assert.doesNotMatch(h.text(second), /儲存修改/);
    h.change("修改價格", "88"); h.find(node => node.type === "form" && node.props["aria-label"] === "修改本地待送單").props.onSubmit({ preventDefault() {} });
  }
  await h.settle(); resolveOld({ structuredContent: { result: [original, other] } }); await h.settle();
  if (operation === "revise") assert.match(h.text(h.find(node => node.props?.id === `stage-${original.id}`)), /88/);
  else {
    const inactive = h.find(node => node.props?.["aria-label"] === "當日草稿紀錄");
    const today = h.find(node => node.props?.["aria-label"] === "本地目前委託");
    assert.match(h.text(inactive), /2330/); assert.doesNotMatch(h.text(today), /2330/);
    assert.match(h.text(today), /1101/);
  }
});

for (const delay of [1000, 5000, 20000]) test(`local view renders independently during ${delay}ms Native read and shares that read`, async () => {
  const original = fixtureStage(); let release!: (value: unknown) => void, brokerReads = 0, localReads = 0;
  const h = harness("DeskOrders", { callTool(name) {
    if (name === "omi_read_desk_staged") { localReads++; return Promise.resolve({ structuredContent: { result: [original] } }); }
    assert.equal(name, "omi_read_desk_orders"); brokerReads++; return new Promise(resolve => { release = resolve; });
  } }, undefined, { view: "orders" });
  await h.settle(); h.updateProps({ view: "staged" }); await h.settle();
  assert.equal(h.button("修改").props.disabled, false); assert.ok(localReads >= 2);
  h.updateProps({ view: "orders" }); await h.settle(); assert.equal(brokerReads, 1);
  // Controlled completion represents the delayed transport; Browser also runs real timed delays.
  release({ structuredContent: fixtureReadback() }); await h.settle();
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
    assert.equal(h.hasEnabledButton("送單"), false);
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
    if (name === "omi_revise_candidate") { assert.equal((args.raw as any).client_intent_id, row.raw.client_intent_id); row = { ...row, raw: args.raw, revision: 2, event: "REVISE", digest: "d".repeat(64) }; }
    else { assert.equal(name, "omi_cancel_candidate"); row = { ...row, revision: 3, event: "CANCEL", state: "CANCELLED", lifecycle: "CANCELLED" }; }
    return { structuredContent: row };
  } });
  await h.settle(); h.click("修改"); h.change("修改價格", "101.25"); h.select("3105");
  assert.equal(h.input("修改價格").props.value, "101.25");
  h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await h.settle();
  h.click("刪除"); await h.settle(); assert.match(h.text(), /已刪除本地待送單/); assert.match(h.text(), /目前沒有待送單/);
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

test("slow local cancel locks only that draft; another local draft can still be cancelled", async () => {
  const first = fixtureStage({ client_intent_id: "slow-local", symbol: "3481" }), second = fixtureStage({ client_intent_id: "fast-local", symbol: "3711" });
  let resolve!: (value: unknown) => void;
  const calls: string[] = [];
  const h = harness("DeskOrders", { async callTool(name, args) {
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [first, second] } };
    if (name === "omi_read_desk_orders") throw Error("Native offline");
    assert.equal(name, "omi_cancel_candidate"); calls.push(String(args.id));
    if (args.id === first.id) return new Promise(done => resolve = done);
    return { structuredContent: { ...second, revision: 2, event: "CANCEL", state: "CANCELLED", lifecycle: "CANCELLED" } };
  } });
  await h.settle(); h.click("刪除"); await h.settle();
  const other = h.find(node => node.props["aria-label"] === "3711 本地掛單");
  const actions = (other.props.children as any[]).flat(Infinity).find((node: any) => node?.props?.className === "workspace-order-actions");
  const findDelete = (node: any): any => !node || typeof node !== "object" ? undefined : node.type === "button" && node.props.children === "刪除" ? node : [node.props?.children].flat(Infinity).map(findDelete).find(Boolean);
  // Traverse the other row's fragment rather than invoking a hidden/global action.
  const action = findDelete(actions); assert.ok(action); assert.equal(action.props.disabled, false);
  action.props.onClick(); await h.settle(); assert.equal(calls.length, 2);
  assert.match(h.text(), /處理中/);
  resolve({ structuredContent: { ...first, revision: 2, event: "CANCEL", state: "CANCELLED", lifecycle: "CANCELLED" } });
  await h.settle(); assert.match(h.text(), /目前沒有待送單/);
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
  assert.doesNotMatch(h.text(h.find(node => node.props["aria-label"] === "2409 本地掛單")), /正在送出|遭拒絕|已掛單|操作結果待確認/);
  assert.equal(h.button("讀回").props.disabled, false);
  f.review.execution = { ...f.review.execution, state: "ACCEPTED", broker_order_id: "fixture-order-2409", reconcile_required: false };
  h.click("讀回"); await h.settle();
  assert.match(h.text(), /委託讀回：已受理/);
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
  assert.equal(h.hasEnabledButton("送單"), false);
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
  assert.equal(h.hasEnabledButton("送單"), false);
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

test("NOT_ATTEMPTED unlocks only after exact local read; a new modal needs a new click and old callbacks cannot send", async () => {
  const row = fixtureStage({ symbol: "3711", lot: "Odd", quantity_shares: 200, price: "592" });
  const calls: string[] = []; let failRead = true;
  const h = harness("DeskOrders", { async callTool(name) {
    calls.push(name);
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [row] } };
    if (name === "omi_read_desk_stage") { if (failRead) throw Error("synthetic local read unavailable"); return { structuredContent: row }; }
    if (name === "omi_read_desk_orders") throw Error("synthetic Native absent");
    assert.equal(name, "omi_confirm_desk_staged"); return fixtureSubmissionError(row);
  } });
  await h.settle(); h.click("送單");
  const old = h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal");
  old.props.confirm(); old.props.confirm(); await h.settle(); await h.settle();
  assert.equal(calls.filter(name => name === "omi_confirm_desk_staged").length, 1);
  assert.equal(h.hasEnabledButton("送單"), false); assert.equal(h.button("讀回").props.disabled, false);
  assert.match(h.text(), /本次請求確定未送出/);
  failRead = false; h.click("讀回"); await h.settle();
  assert.equal(h.button("送單").props.disabled, false);
  assert.equal(calls.filter(name => name === "omi_read_desk_orders").length, 1, "retry proof never depends on Native read");
  old.props.confirm(); await h.settle(); // No modal => zero new calls.
  h.click("送單"); old.props.confirm(); old.props.cancel(); await h.settle();
  assert.equal(calls.filter(name => name === "omi_confirm_desk_staged").length, 1, "old callback cannot confirm/cancel a new modal");
  const next = h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal");
  next.props.confirm(); next.props.confirm(); await h.settle();
  assert.equal(calls.filter(name => name === "omi_confirm_desk_staged").length, 2, "explicit new user confirmation only");
});

for (const mode of ["claim", "partial-fill", "version", "digest", "stale-receipt", "malformed", "late-generation"]) test(`NOT_ATTEMPTED recovery keeps lock on ${mode}`, async () => {
  const original: any = fixtureStage({ symbol: "3481", action: "Sell", condition: "SHORT_SELLING", lot: "Common" });
  let current = original, resolve!: (value: unknown) => void;
  let count = 0;
  const h = harness("DeskOrders", { async callTool(name) {
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [current] } };
    if (name === "omi_read_desk_stage") return { structuredContent: current };
    if (name === "omi_read_desk_orders") throw Error("synthetic Native offline");
    assert.equal(name, "omi_confirm_desk_staged"); count++;
    return new Promise(done => resolve = done);
  } });
  await h.settle(); h.click("送單");
  const modal = h.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal");
  modal.props.confirm(); modal.props.confirm(); await h.settle();
  if (mode === "claim") current = { ...original, revision: 2, lifecycle: "SUBMITTING" };
  if (mode === "partial-fill") current = { ...original, revision: 3, lifecycle: "SUBMISSION_PENDING", manual_stage: { ...original.manual_stage, submission: { phase: "RESULT", receipt: { execution: { state: "PARTIALLY_FILLED" } } } } };
  if (mode === "version") current = { ...original, revision: 2 };
  if (mode === "digest") current = { ...original, digest: "d".repeat(64) };
  const error: any = fixtureSubmissionError(original);
  if (mode === "stale-receipt") error.structuredContent.backend_error.error.detail.submission_attempt.candidate_revision = 0;
  if (mode === "malformed") delete error.structuredContent.backend_error.error.detail.submission_attempt;
  if (mode === "late-generation") h.invalidate();
  resolve(error); await h.settle(); await h.settle();
  current = original; h.click("更新委託"); await h.settle();
  assert.equal(h.hasEnabledButton("送單"), false, "list cannot release a failed exact read or unknown latch");
  assert.equal(h.button("讀回").props.disabled, false);
  modal.props.confirm(); await h.settle(); assert.equal(count, 1);
  if (["claim", "partial-fill", "version", "digest"].includes(mode)) {
    h.click("讀回"); await h.settle();
    assert.equal(h.hasEnabledButton("送單"), false, "a subsequent stale STAGED detail cannot revive consumed proof");
  }
});

test("concurrent windows: a NOT_ATTEMPTED receipt cannot unlock a stage another window claimed", async () => {
  const original: any = fixtureStage(); let current = original, resolve!: (value: unknown) => void, sends = 0;
  const bridge: CandidateBridge = { async callTool(name) {
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [current] } };
    if (name === "omi_read_desk_stage") return { structuredContent: current };
    if (name === "omi_read_desk_orders") throw Error("synthetic Native offline");
    assert.equal(name, "omi_confirm_desk_staged"); sends++;
    if (sends === 1) return new Promise(done => resolve = done);
    current = { ...original, revision: 2, lifecycle: "SUBMITTING" }; throw Error("synthetic claimed timeout");
  } };
  const a = harness("DeskOrders", bridge), b = harness("DeskOrders", bridge);
  await a.settle(); await b.settle();
  a.click("送單"); a.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal").props.confirm();
  b.click("送單"); b.find(node => typeof node.type === "function" && node.type.name === "SendOrderModal").props.confirm();
  await b.settle(); resolve(fixtureSubmissionError(original)); await a.settle(); await a.settle();
  assert.equal(sends, 2); assert.match(a.text(), /正在送出|送單進度待確認/);
  assert.equal(a.button("讀回").props.disabled, false);
  assert.ok(!a.text().includes("同一掛單讀回一致"));
});


test("accepted local UNKNOWN card renders inline broker cancellation, and missing proof explains why in place", async () => {
  const { fixtureSubmittedOrder, fixtureBrokerOrders } = await import("../scripts/desk-fixture");
  const f: any = fixtureSubmittedOrder("3702", "ACCEPTED", "2026-11-16", { lot: "Odd", quantity_shares: 800, price: "82.5" });
  f.row.lifecycle = f.row.manual_stage.state = "SUBMISSION_UNKNOWN";
  f.row.manual_stage.submission.receipt.execution.state = "UNKNOWN";
  let missing = false;
  const h = harness("DeskOrders", { async callTool(name) {
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [f.row] } };
    assert.equal(name, "omi_read_desk_orders", "render performs no broker mutation");
    return { structuredContent: { ...fixtureBrokerOrders(), trade_date: "2026-11-16", reviews: [f.review], broker_orders: missing ? [] : [f.broker] } };
  } });
  await h.settle();
  const card = () => h.find(node => node.props.id === `stage-${f.row.id}`);
  assert.match(h.text(card()), /已受理/);
  assert.match(h.text(card()), /零股 800 股/);
  assert.ok(!h.text(card()).includes("前往此筆券商委託"));
  const controls = h.all(node => typeof node.type === "function" && node.type.name === "BrokerOrderControls");
  assert.equal(controls.length, 2, "local and broker cards reuse the same controls");
  assert.equal(controls[0].props.order.pin.id, controls[1].props.order.pin.id);
  assert.equal(controls[0].props.order.pin.brokerOrderId, f.broker.broker_key.order_id);
  missing = true; h.click("更新委託"); await h.settle();
  assert.match(h.text(card()), /缺少唯一的當日券商紀錄/);
  assert.match(h.text(card()), /撤銷剩餘委託.*讀回/s);
});

test("neutral research uses its backend capabilities without claiming a short trade or editable plan", async () => {
  const { fixtureResearch, fixtureResearchList } = await import("../scripts/research-fixture");
  const row = { ...fixtureResearch(), direction: "neutral", stage_supported: false, revise_supported: false };
  const h = harness("ResearchPanel", { async callTool(name) {
    assert.equal(name, "omi_list_research_proposals");
    return { structuredContent: fixtureResearchList([row]) };
  } });
  await h.settle();
  const card = h.find(node => node.type === "article");
  assert.match(h.text(card), /中性觀察/);
  assert.ok(!h.text(card).includes("做空"));
  assert.equal(h.hasEnabledButton("檢視研究"), true);
  assert.equal(h.hasEnabledButton("加入待送單"), false);
  assert.equal(h.hasEnabledButton("修改"), false);
});

test("research stage releases busy after 422, 5xx, transport and unknown; recovers only original intent", async () => {
  const { fixtureResearch, fixtureResearchList } = await import("../scripts/research-fixture");
  for (const failure of [422, 503, "transport", "unknown"]) {
    const row = fixtureResearch();
    let stageCalls = 0, staged: any, navigated: any;
    const bridge = { async callTool(name: string, args: any) {
      if (name === "omi_list_research_proposals") return { structuredContent: fixtureResearchList([row]) };
      if (name === "omi_stage_research_order") {
        stageCalls++;
        staged = fixtureStage({ symbol: row.symbol, client_intent_id: args.data.client_intent_id,
          research_proposal: { creation_id: row.creation_id, revision_id: row.revision_id, workflow_origin: "AI_NOMINATION", market: "TW" } });
        if (typeof failure === "number") return { isError: true, structuredContent: { error: "fixture failure", http_status: failure, tool: name } };
        if (failure === "transport") throw Error("MCP transport timeout");
        return { structuredContent: {} };
      }
      if (name === "omi_read_desk_staged") return { structuredContent: { result: [staged] } };
      throw Error(`Unexpected mutation ${name}`);
    } };
    const h = harness("ResearchPanel", bridge, undefined, { onStaged: (value: any) => navigated = value });
    await h.settle(); assert.ok(h.hasEnabledButton("加入待送單"), h.text()); h.click("加入待送單"); await h.settle();
    assert.equal(stageCalls, 1); assert.equal(navigated, undefined);
    assert.ok(!h.text().includes("處理中…"));
    if (failure === 422) assert.equal(h.button("加入待送單").props.disabled, false);
    else {
      assert.equal(h.button("加入待送單").props.disabled, true);
      h.click("讀回原待送單"); await h.settle();
      assert.equal((navigated as any).stageId, staged.id); assert.equal(stageCalls, 1);
      h.click("加入待送單"); await h.settle(); assert.equal(stageCalls, 1, "same version navigates to its existing stage");
    }
  }
});
