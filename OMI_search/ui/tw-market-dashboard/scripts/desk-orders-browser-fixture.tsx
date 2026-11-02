// Isolated in-memory UI only. Never contact Backend, Native, market or storage.
import { createRoot } from "react-dom/client";
import { WorkspaceContext } from "../src/WorkspaceContext";
import { DeskOrders } from "../src/DeskOrders";
import type { UnknownRecord } from "../src/state";
import styles from "../src/styles.css";
import { fixtureReadback, fixtureStage, fixtureReview } from "./desk-fixture";

const style = document.createElement("style");
style.textContent = styles + ".desk-fixture { display:block; max-width:620px; margin:0 auto; padding:16px; } .desk-fixture .workspace-context { width:100%; min-width:0; }";
document.head.append(style);
document.documentElement.dataset.omiWorkspace = "true";
const noIO = () => { throw Error("No real IO permitted in desk fixture"); };
window.fetch = noIO; window.WebSocket = noIO as unknown as typeof WebSocket;
Storage.prototype.setItem = noIO;
const stages = [fixtureStage({ client_intent_id: "fixture-2330", symbol: "2330", lot: "Odd", quantity_shares: 1, price: "2330" }),
  fixtureStage({ client_intent_id: "fixture-4977", symbol: "4977", lot: "Common", quantity_shares: 1000, price: "175" })];
const calls: { name: string; args: UnknownRecord }[] = [];
let offline = true;
const nativeStates = ["PENDING", "ACCEPTED", "PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCEL_PENDING", "UNKNOWN", "RECONCILING"];
const bridge = { async callTool(name: string, args: UnknownRecord = {}) {
  calls.push({ name, args: structuredClone(args) });
  let value: unknown;
  if (name === "omi_read_desk_status") throw Error("OMI API HTTP 503: fixture Native offline");
  else if (name === "omi_read_desk_orders") {
    if (offline) throw Error("OMI API HTTP 503: fixture Native offline");
    const readback = fixtureReadback();
    const source = (readback.broker_orders as UnknownRecord[])[0];
    value = { ...readback, broker_orders: nativeStates.map(state => ({ ...source, execution_state: state, broker_status: state })) };
  } else if (name === "omi_read_desk_fills" || name === "omi_read_desk_inventory") value = fixtureReadback();
  else if (name === "omi_read_desk_staged") value = { result: stages };
  else if (name === "omi_read_desk_stage") value = stages.find(row => row.id === args.id);
  else if (name === "omi_revise_candidate" || name === "omi_cancel_candidate") {
    const index = stages.findIndex(row => row.id === args.id), row = stages[index];
    check(!!row && args.expected_revision === row.revision, "exact local revision pin");
    stages[index] = { ...row, revision: Number(row.revision) + 1, digest: "d".repeat(64),
      ...(name === "omi_revise_candidate" ? { raw: args.raw } : { state: "CANCELLED", lifecycle: "CANCELLED", manual_stage: { ...(row.manual_stage as UnknownRecord), state: "CANCELLED" } }) };
    value = stages[index];
  } else if (name === "omi_confirm_desk_staged") {
    const row = stages.find(row => row.id === args.id)!;
    check(!!row && row.revision === args.expected_revision && row.digest === args.expected_digest, "exact confirmation ID/revision/digest pin");
    throw Error("fixture confirmation timeout; UNKNOWN");
  } else if (name === "omi_list_candidates") value = { result: [] };
  else if (name === "omi_read_candidate_monitor_status") value = { status: "unknown" };
  else throw Error(`Unexpected fixture tool ${name}`);
  return { structuredContent: structuredClone(value) };
} };
const root = createRoot(document.getElementById("root")!);
if (document.documentElement.dataset.fixtureMode !== "submission") root.render(<main className="tw-workspace desk-fixture" data-workspace-view="trade"><WorkspaceContext symbol="2330" bridge={bridge}/></main>);
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const find = <T extends Element = HTMLElement>(selector: string) => { const node = document.querySelector<T>(selector); check(node, selector); return node; };
const button = (root: Element, label: string) => { const node = [...root.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label); check(node, label); return node; };
const click = async (root: Element, label: string) => { const node = button(root, label); check(!node.disabled, `${label} enabled`); node.click(); await pause(); };
const change = async (label: string, value: string) => {
  const input = find<HTMLInputElement>(`[aria-label="${label}"]`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
};
const countConfirm = () => calls.filter(call => /confirm|approve/.test(call.name)).length;
const summary = (node: HTMLElement) => node.innerText;

async function run() {
  await pause();
  check(button(document.body, "我的交易").getAttribute("aria-pressed") === "true", "user environment default");
  await click(document.body, "AI 候選"); await click(document.body, "我的交易");
  await click(document.body, "掛單");
  const local = find('[aria-label="本地待送單"]');
  const first = find<HTMLElement>('[aria-label="2330 本地掛單"]'), second = find<HTMLElement>('[aria-label="4977 本地掛單"]');
  check(first.getBoundingClientRect().height > 0 && second.getBoundingClientRect().height > 0, "both cards rendered visibly");
  check(summary(first).includes("現股買進") && summary(first).includes("2,330") && summary(first).includes("零股 1 股"), "2330 readable facts");
  check(summary(second).includes("175") && summary(second).includes("整股 1 張（1,000 股）"), "4977 readable facts");
  check(summary(first).includes("待送出") && summary(second).includes("待送出"), "Chinese staged status");
  check(!/USER_SPACE|MANUAL|MCP|stage-|revision|digest|STAGED|Native|Journal|Session|\?{3,}|\uFFFD/.test(summary(find(".workspace-context"))), `no exposed technical content or encoding damage: ${summary(find(".workspace-context"))}`);
  check([...document.querySelectorAll("details")].every(node => !node.open), "all diagnostics closed by default");
  check([...local.querySelectorAll("button")].every(node => node.textContent !== "讀回"), "healthy stages have no recovery button");
  check(summary(find('[aria-label="券商委託"]')).includes("本地掛單仍可管理"), "broker 503 preserves local operation");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  for (const card of [first, second]) for (const action of ["修改", "刪除", "送單"]) {
    const box = button(card, action).getBoundingClientRect();
    check(box.width >= 44 && box.height >= 32 && box.right <= innerWidth, "usable action geometry");
  }
  if (document.documentElement.dataset.fixtureMode === "presentation") {
    document.body.dataset.testResult = `PASS presentation ${innerWidth}px: 2330/4977, closed diagnostics, broker 503`; return;
  }
  const details = first.querySelector("details")!;
  details.open = true;
  const raw = JSON.parse(details.querySelector("pre")!.textContent!);
  check(raw.id === stages[0].id && raw.digest === stages[0].digest && raw.raw.price === "2330", "exact raw retained");
  details.open = false;
  await click(first, "送單");
  check(document.querySelectorAll("dialog[open]").length === 1, "single SendOrderModal");
  check(!/stage-|USER_SPACE|digest|Native/.test(summary(find("dialog"))), "modal diagnostics closed");
  await click(find("dialog"), "取消"); check(countConfirm() === 0, "cancel modal zero confirms");
  await click(second, "修改"); await change("修改價格", "176.50"); await change("修改股數", "2000");
  await click(document.body, "儲存修改");
  check(summary(second).includes("176.50") && summary(second).includes("整股 2 張（2,000 股）"), "local revise visible during broker 503");
  const revision = calls.find(call => call.name === "omi_revise_candidate")!;
  check(revision.args.id === stages[1].id && revision.args.expected_revision === 1 && (revision.args.raw as UnknownRecord).client_intent_id === "fixture-4977", "revision preserves ID and raw identity");
  await click(second, "刪除");
  check(summary(second).includes("已取消（本地）"), "local cancellation truthful");
  const cancelled = calls.find(call => call.name === "omi_cancel_candidate")!;
  check(cancelled.args.id === stages[1].id && cancelled.args.expected_revision === 2 && countConfirm() === 0, "delete is exact local candidate cancel only");
  await click(first, "送單");
  const confirm = button(find("dialog"), "確認送單"); confirm.click(); confirm.click(); await pause(); await pause();
  check(countConfirm() === 1, "double click consumes one pinned confirm");
  check(!document.querySelector("dialog[open]") && summary(first).includes("待確認"), "timeout closes modal and locks stage");
  check(button(first, "送單").disabled && button(first, "修改").disabled && button(first, "刪除").disabled, "unknown remains locked");
  await click(first, "讀回"); check(countConfirm() === 1, "readback never resends");
  check(calls.filter(call => call.name === "omi_read_desk_stage").every(call => call.args.id === stages[0].id), "read original ID only");
  offline = false; await click(document.body, "更新委託");
  const labels = [...find('[aria-label="券商委託"]').querySelectorAll(".workspace-order-status")].map(node => node.textContent);
  check(JSON.stringify(labels) === JSON.stringify(["券商結果待確認", "已受理", "部分成交", "已成交", "遭拒絕", "撤銷處理中", "待確認", "核對中"]), "Native broker states accurately rendered");
  await click(document.body, "成交");
  check(!/Native|Session|UNKNOWN|fixture-/.test(summary(find('[aria-label="券商成交"]'))), "fills diagnostics closed");
  await click(document.body, "庫存");
  check(!/Native|Session|UNKNOWN|fixture-/.test(summary(find('[aria-label="券商庫存"]'))), "inventory diagnostics closed");
  document.body.dataset.testResult = `PASS interaction ${innerWidth}px: local CRUD, 503, cancel=0, confirm=1, pinned identity, UNKNOWN no resend, broker states`;
  find("#fixture-receipt").textContent = JSON.stringify(calls, null, 2);
}
async function runSubmission() {
  const original = fixtureStage({ symbol: "2409", price: "33.7", action: "Sell" });
  original.id = "281692ad4b581eef2fe87453ba8a0b0df21dfabb882e01ab85efb189a4a83edd";
  const review = fixtureReview(original.raw as UnknownRecord), draft = review.draft as UnknownRecord, command = draft.command as UnknownRecord;
  command.trade_date = "2026-11-02"; command.intent_id = command.request_id = "fixture-native-intent-2409";
  const snapshot = review.snapshot as UnknownRecord;
  snapshot.draft = structuredClone(draft);
  review.state = "EXECUTION"; review.execution_id = "exec-fixture-2409";
  review.execution = { execution_id: review.execution_id, intent_id: command.intent_id, trade_date: command.trade_date,
    state: "PENDING", submit_stage: "RETURNED", broker_attempts_max: 1, broker_order_id: null, reconcile_required: true };
  const returned: UnknownRecord = { ...original, revision: 5, digest: "e".repeat(64), lifecycle: "SUBMISSION_PENDING",
    manual_stage: { ...(original.manual_stage as UnknownRecord), state: "SUBMISSION_PENDING", submission: {
      phase: "RESULT", pin: { revision: original.revision, digest: original.digest }, native_intent_id: command.intent_id, draft: structuredClone(draft),
      native: { review_id: review.review_id, review_revision: review.review_revision, digest: snapshot.digest }, receipt: structuredClone(review),
    } } };
  const unchanged = JSON.stringify(returned);
  let current = returned, failRead = false, partial = false, timeout = false;
  const nativeCalls: { name: string; args: UnknownRecord }[] = [];
  const nativeBridge = { async callTool(name: string, args: UnknownRecord = {}) {
    nativeCalls.push({ name, args: structuredClone(args) });
    if (name === "omi_read_desk_staged") return { structuredContent: { result: [structuredClone(current)] } };
    if (name === "omi_read_desk_stage") { check(args.id === original.id, "read exact Candidate ID, never review ID"); return { structuredContent: structuredClone(current) }; }
    if (name === "omi_read_desk_orders") {
      if (failRead) throw Error("fixture 503 readback unavailable");
      return { structuredContent: { ...fixtureReadback(), trade_date: command.trade_date, broker_orders: [], reviews: partial ? [] : [structuredClone(review)],
        unparsed_reports: [{ fields: { StockNo: "2409", Price: "33.7", BS: "S", Qty: "1", ErrCode: "MAT0095", OrderNo: "0000" } }] } };
    }
    check(name === "omi_confirm_desk_staged", `only the pinned mock confirmation is allowed: ${name}`);
    check(args.id === original.id && args.expected_revision === original.revision && args.expected_digest === original.digest, "exact original pin unchanged");
    current = returned;
    if (timeout) { failRead = true; throw Error("fixture transport timeout after submit"); }
    return { structuredContent: structuredClone(returned) };
  } };
  const mount = async (key: string) => { root.render(<main className="tw-workspace desk-fixture" data-workspace-view="trade"><div className="workspace-context"><DeskOrders key={key} bridge={nativeBridge} active refreshKey={0}/></div></main>); await pause(); await pause(); };
  const card = () => find<HTMLElement>('[aria-label="2409 本地掛單"]');
  const confirms = () => nativeCalls.filter(call => /confirm|approve/.test(call.name)).length;
  await mount("reopened");
  check(card().getBoundingClientRect().height > 0 && button(card(), "讀回").getBoundingClientRect().width >= 44, "reopened Pending and readback button visibly rendered");
  check(summary(card()).includes("券商結果待確認") && summary(card()).includes("送單請求已返回"), "returned request and pending broker result visible after reopen");
  check(!/正在送出|遭拒絕|已掛單|操作結果待確認/.test(summary(card())), "MAT0095/0000 never infers broker result");
  check(summary(find('[aria-label="券商委託"]')).includes("有 1 筆券商回報無法確認委託身分，請查看詳細資訊。") && !summary(card()).includes("回報無法確認委託身分"), "unparsed reports produce one global notice, never a Candidate result");
  check(!button(card(), "讀回").disabled && confirms() === 0, "reopened Pending is read-only and readable");
  await click(card(), "讀回");
  for (const [state, label] of [["ACCEPTED", "已受理"], ["REJECTED", "遭拒絕"], ["CANCELLED", "已撤銷"], ["UNKNOWN", "待確認"]]) {
    review.execution = { ...(review.execution as UnknownRecord), state };
    await click(card(), "讀回");
    check(summary(card()).includes(`券商階段讀回：${label}`), `exact Native ${state} stays separately labelled`);
    check(card().querySelector(".workspace-order-status")!.textContent === "券商結果待確認", "persisted Candidate still Pending");
  }
  check(JSON.stringify(returned) === unchanged && confirms() === 0, "no Candidate/receipt mutation from Native or readback");
  review.execution = structuredClone(((returned.manual_stage as UnknownRecord).submission as UnknownRecord).receipt as UnknownRecord).execution;
  current = original; await mount("successful-send");
  await click(card(), "送單"); await click(find("dialog"), "取消"); check(confirms() === 0, "cancel modal zero confirms");
  await click(card(), "送單");
  let confirm = button(find("dialog"), "確認送單"); confirm.click(); confirm.click(); await pause(); await pause();
  check(confirms() === 1 && !summary(card()).includes("操作結果待確認"), "successful returned Pending has no artificial unknown");
  await click(card(), "讀回");
  current = original; await click(document.body, "更新委託");
  check(button(card(), "送單").disabled && confirms() === 1, "clearing warning never clears original consumed ID latch");
  timeout = true; current = original; await mount("transport-recovery");
  await click(card(), "送單"); confirm = button(find("dialog"), "確認送單"); confirm.click(); confirm.click(); await pause(); await pause();
  check(confirms() === 2 && summary(card()).includes("操作結果待確認"), "transport timeout/503 keeps warning");
  check(summary(card()).includes("送單請求已返回"), "valid local result retained during broker 503");
  failRead = false; partial = true; await click(card(), "讀回");
  check(summary(card()).includes("操作結果待確認"), "partial read without linked review cannot clear uncertainty");
  partial = false; await click(card(), "讀回");
  check(!summary(card()).includes("操作結果待確認") && summary(card()).includes("券商結果待確認"), "exact Candidate/review/execution clears UI-only warning and preserves business Pending");
  check(confirms() === 2 && !button(card(), "讀回").disabled, "recovery reads never duplicate mock orders");
  check(document.documentElement.scrollWidth <= innerWidth, "submission cards fit viewport");
  check([...document.querySelectorAll("details")].every(node => !node.open), "technical fields stay closed");
  document.body.dataset.testResult = `PASS submission ${innerWidth}px: 2409 PARTIAL MAT0095/0000, exact Native IDs/version/date, reopened readback, confirm=1 per intent, timeout/503 recovery, no duplicate`;
  find("#fixture-receipt").textContent = JSON.stringify(nativeCalls, null, 2);
}
(document.documentElement.dataset.fixtureMode === "submission" ? runSubmission() : run()).catch(error => { document.body.dataset.testResult = `FAIL ${error.message}`; });
