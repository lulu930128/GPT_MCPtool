import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { orderDirection, orderPrice, orderQuantity, orderStatus, stageStatus, SendOrderModal } from "./DeskOrders";
import { stageSelection, stageNativeReview } from "./desk-contract";
import { fixtureStage, fixtureReadback, fixtureReview } from "../scripts/desk-fixture";

test("display preserves decimal precision and formats only known share units", () => {
  assert.equal(orderPrice("2330"), "2,330");
  assert.equal(orderPrice("12345678901234567890.1250"), "12,345,678,901,234,567,890.1250");
  assert.equal(orderPrice(null), "未提供");
  assert.equal(orderPrice("NaN"), "未提供");
  assert.equal(orderQuantity("Odd", 1), "零股 1 股");
  assert.equal(orderQuantity("Common", 1000), "整股 1 張（1,000 股）");
  assert.equal(orderQuantity("Common", 1500), "1,500 股（交易單位待確認）");
  assert.equal(orderQuantity("Odd", null), "數量未確認");
  assert.equal(orderQuantity("Odd", Number.MAX_SAFE_INTEGER + 1), "數量未確認");
  assert.equal(orderDirection({ action: "Buy", condition: "CASH" }), "現股買進");
  assert.equal(orderDirection({ action: "Sell", condition: "CASH" }), "現股賣出");
});

test("local, submission and Native broker states retain their distinct meaning", () => {
  const expected = {
    STAGED: "待送出", PREVIEW: "待送出", SUBMITTING: "正在送出", SUBMISSION_UNKNOWN: "送單結果待確認",
    SUBMISSION_REJECTED: "送單遭拒", SUBMISSION_PENDING: "券商結果待確認", SUBMISSION_CANCELLED: "已撤銷", SUBMITTED: "已送出",
    PENDING: "券商結果待確認", ACCEPTED: "已受理", PARTIALLY_FILLED: "部分成交", FILLED: "已成交",
    REJECTED: "遭拒絕", CANCEL_PENDING: "撤銷處理中", UNKNOWN: "待確認", RECONCILING: "核對中",
  };
  for (const [state, label] of Object.entries(expected)) assert.equal(orderStatus(state), label, state);
  assert.equal(orderStatus("CANCELLED", true), "已取消（本地）");
  assert.equal(orderStatus("CANCELLED"), "已撤銷");
  assert.equal(orderStatus("future-state"), "狀態待確認");
});

test("returned Pending is distinct from active phases and only Native evidence confirms broker rejection", () => {
  for (const phase of ["DRAFT", "PREVIEW", "CONFIRM", "RESULT", undefined]) {
    const row = { lifecycle: "SUBMITTING", manual_stage: { submission: { phase } } };
    assert.equal(stageStatus(row).label, ["DRAFT", "PREVIEW", "CONFIRM"].includes(String(phase)) ? "正在送出" : "送單進度待確認");
  }
  const pending = stageStatus({ lifecycle: "SUBMISSION_PENDING", manual_stage: { submission: { phase: "RESULT", receipt: { execution: { state: "PENDING", broker_order_id: null, submit_stage: "RETURNED", reconcile_required: true } } } } });
  assert.equal(pending.label, "券商結果待確認"); assert.match(pending.note, /送單請求已返回/);
  assert.doesNotMatch(pending.label + pending.note, /正在送出|遭拒絕|已掛單/);
  assert.equal(stageStatus({ lifecycle: "SUBMISSION_REJECTED", manual_stage: { submission: { error: "EXECUTOR_COMMAND_REJECTED" } } }).label, "送單遭拒");
  assert.equal(stageStatus({ lifecycle: "SUBMISSION_REJECTED", manual_stage: { submission: { receipt: { execution: { state: "REJECTED" } } } } }).label, "遭拒絕");
});

test("read-only Native join requires exact IDs, date and version pins, never economic or unparsed similarity", () => {
  const review: any = fixtureReview(), day = review.draft.command.trade_date;
  review.state = "EXECUTION"; review.execution_id = "exec-fixture";
  review.execution = { execution_id: review.execution_id, intent_id: review.draft.command.intent_id, trade_date: day, state: "PENDING", broker_order_id: null };
  const row: any = fixtureStage();
  row.manual_stage.submission = { native_intent_id: review.draft.command.intent_id, draft: review.draft,
    native: { review_id: review.review_id, review_revision: 1, digest: review.snapshot.digest }, receipt: structuredClone(review) };
  const data: any = fixtureReadback([review]);
  assert.notEqual(row.id, review.review_id);
  assert.equal(stageNativeReview(row, data), review);
  const before = JSON.stringify({ row, data });
  data.unparsed_reports = [{ fields: { ErrCode: "MAT0095", OrderNo: "0000", StockNo: "2330", Price: "100.25", Qty: "1" } }];
  assert.equal(stageNativeReview(row, data), review);
  for (const change of [
    (r: any) => r.review_id = "another-review", (r: any) => r.execution_id = "another-execution",
    (r: any) => r.draft.command.intent_id = "another-intent", (r: any) => r.draft.command.trade_date = "2026-11-02",
    (r: any) => r.review_revision++, (r: any) => r.snapshot.digest = "d".repeat(64),
    (r: any) => r.execution.intent_id = "another-intent", (r: any) => r.execution.trade_date = "2026-11-02",
  ]) {
    const wrong = structuredClone(review); change(wrong);
    assert.equal(stageNativeReview(row, { ...data, reviews: [wrong] }), null);
  }
  assert.equal(stageNativeReview(row, { ...data, trade_date: "2026-11-02" }), null);
  assert.equal(stageNativeReview(row, { ...data, reviews: [review, review] }), null);
  assert.equal(stageNativeReview(row, { ...data, reviews: [] }), null);
  const intentOnly = structuredClone(row); delete intentOnly.manual_stage.submission.native; delete intentOnly.manual_stage.submission.receipt;
  assert.equal(stageNativeReview(intentOnly, data), review, "intent plus trade date is an exact identity, even before a receipt");
  const conflict = structuredClone(row); conflict.manual_stage.submission.receipt.execution_id = "conflict";
  assert.equal(stageNativeReview(conflict, data), null);
  assert.equal(JSON.stringify({ row, data: { ...data, unparsed_reports: JSON.parse(before).data.unparsed_reports } }), before, "join never mutates either source");
});

test("one existing modal shows readable order facts and keeps the exact raw pin in closed details", () => {
  const selection = stageSelection(fixtureStage({ price: "2330", quantity_shares: 1, lot: "Odd" }));
  const html = renderToStaticMarkup(createElement(SendOrderModal, { selection, busy: false, notice: "", cancel() {}, confirm() {} }));
  assert.equal((html.match(/<dialog/g) ?? []).length, 1);
  assert.match(html, /現股買進/); assert.match(html, /2,330/); assert.match(html, /零股 1 股/);
  const [visible, details] = html.split('<details');
  assert.doesNotMatch(visible, /USER_SPACE|MANUAL|MCP|stage-|digest|revision|Native/);
  assert.match(details, /詳細資訊與技術紀錄/);
  assert.match(details, new RegExp(selection.id));
  assert.match(details, new RegExp(selection.digest));
  assert.doesNotMatch(details, / open[=> ]/);
});

test("affected UI remains valid UTF-8 with required Traditional Chinese and no replacement text", () => {
  for (const file of ["DeskOrders.tsx", "WorkspaceContext.tsx"]) {
    const bytes = readFileSync(new URL(file, import.meta.url));
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.doesNotMatch(source, /\?{3,}|\uFFFD|>\s*\?\s*</);
    for (const label of file === "DeskOrders.tsx" ? ["本地掛單", "限價", "數量", "修改", "刪除", "送單", "券商委託"] : ["我的交易", "AI 候選"]) assert.ok(source.includes(label), label);
    assert.ok(source.includes("詳細資訊與技術紀錄"));
  }
});
