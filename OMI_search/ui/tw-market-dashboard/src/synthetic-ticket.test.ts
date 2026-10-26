import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SyntheticOrderPanel } from "./SyntheticOrderPanel";
import { WorkspaceContext } from "./WorkspaceContext";
import { canCancel, currentFrame, FIXTURE, initialTicket, ticketReducer as reduce, validateTicket, type TicketFields, type TicketView, type Scenario } from "./synthetic-ticket";

const fields: TicketFields = { side: "BUY", lot: "BOARD", orderKind: "LIMIT", price: "100.01", quantity: "1000", scenario: "fill" };
function preview(patch: Partial<TicketFields> = {}) {
  return reduce(reduce(initialTicket("2330"), { type: "edit", patch: { ...fields, ...patch } }), { type: "preview", now: 1_000 });
}
function confirm(view = preview()) {
  return reduce(reduce(view, { type: "acknowledge", value: true, previewId: view.preview!.id, now: 1_100 }), { type: "confirm", previewId: view.preview!.id, now: 1_200 });
}
const next = (view: TicketView, now = 2_000) => reduce(view, { type: "next", now });

test("selection only supplies a symbol and never creates a preview or defaults side/quantity/price", () => {
  const view = initialTicket("2330");
  assert.deepEqual(view.fields, { side: "", lot: "", orderKind: "", price: "", quantity: "", scenario: "fill" });
  assert.equal(view.preview, null);
  assert.equal(view.attempts, 0);
  assert.equal(next(view), view);
  assert.equal(reduce(view, { type: "confirm", previewId: 1, now: 1 }), view);
});

test("empty, unsupported, malformed and non-cash modes fail closed", () => {
  assert.ok(validateTicket("", initialTicket().fields).errors.length >= 4);
  for (const symbol of ["", "AAPL", "9999", "__proto__", "constructor"]) assert.equal(validateTicket(symbol, fields).estimate, null);
  for (const patch of [
    { side: "SHORT" }, { lot: "MARGIN" }, { orderKind: "MARKET" }, { scenario: "live" },
    ...["", "NaN", "Infinity", "-1", "0", "200.01", "1e2", "1.001", " 100", "100 ", "100foo"].map((price) => ({ price })),
    ...["", "0", "-1", "1.5", "NaN", "1e3", "10001", "9999999999999999", "1000 "].map((quantity) => ({ quantity })),
    { lot: "BOARD", quantity: "999" }, { lot: "ODD", quantity: "1000" },
  ]) assert.equal(validateTicket("2330", { ...fields, ...patch } as TicketFields).estimate, null, JSON.stringify(patch));
});

test("fixture-only decimal estimates, cash reserve, stock/ETF, TWSE/TPEX and BOARD/ODD", () => {
  const estimate = validateTicket("2330", fields).estimate!;
  assert.equal(estimate.notionalCents, 10_001_000);
  assert.equal(estimate.requiredCashCents, 10_003_000);
  assert.equal(validateTicket("2330", { ...fields, quantity: "10000", price: "100" }).estimate, null, "reserve exceeds fake cash");
  for (const symbol of ["2330", "0050", "6488"]) {
    for (const side of ["BUY", "SELL"] as const) {
      assert.ok(validateTicket(symbol, { ...fields, side }).estimate);
      assert.ok(validateTicket(symbol, { ...fields, side, lot: "ODD", quantity: "1", price: "1.01" }).estimate);
      assert.ok(validateTicket(symbol, { ...fields, side, lot: "ODD", quantity: "999", price: "200" }).estimate);
    }
  }
  assert.equal(validateTicket("0050", { ...fields, side: "SELL" }).estimate!.requiredCashCents, 0);
});

test("every field edit invalidates preview and acknowledgement, including scenario and mode", () => {
  const p = preview();
  const acknowledged = reduce(p, { type: "acknowledge", value: true, now: 1_100, previewId: p.preview!.id });
  for (const patch of [{ side: "SELL" }, { lot: "ODD" }, { orderKind: "" }, { quantity: "2000" }, { price: "99" }, { scenario: "reject" }]) {
    const changed = reduce(acknowledged, { type: "edit", patch: patch as Partial<TicketFields> });
    assert.equal(changed.preview, null);
    assert.equal(changed.acknowledged, false);
    assert.equal(changed.attempts, 0);
    assert.equal(reduce(changed, { type: "confirm", previewId: p.preview!.id, now: 1_200 }), changed);
  }
});

test("symbol changes, including away and back, discard draft/intent and receipt", () => {
  for (const previous of [preview(), confirm()]) {
    const selected = reduce(previous, { type: "select", symbol: "0050" });
    assert.equal(selected.symbol, "0050");
    assert.equal(selected.preview, null);
    assert.equal(selected.fields.side, "");
    const back = reduce(selected, { type: "select", symbol: "2330" });
    assert.equal(back.fields.price, "");
    assert.equal(back.frames.length, 0);
  }
});

test("two-stage confirmation binds the current preview; duplicate and stale handlers cannot create another attempt", () => {
  const p = preview();
  assert.equal(reduce(p, { type: "confirm", previewId: p.preview!.id, now: 1_100 }), p);
  const ack = reduce(p, { type: "acknowledge", value: true, previewId: p.preview!.id, now: 1_100 });
  assert.equal(reduce(ack, { type: "confirm", previewId: 99, now: 1_200 }), ack);
  const receipt = confirm();
  assert.equal(currentFrame(receipt).state, "SIMULATED_PENDING");
  assert.equal(receipt.attempts, 1);
  assert.equal(reduce(receipt, { type: "confirm", previewId: receipt.preview!.id, now: 99_000 }), receipt);
  assert.equal(reduce(receipt, { type: "preview", now: 2_000 }), receipt);
  const edited = reduce(ack, { type: "edit", patch: { price: "99" } });
  const newer = reduce(edited, { type: "preview", now: 2_000 });
  assert.notEqual(newer.preview!.id, p.preview!.id);
  assert.equal(reduce(newer, { type: "acknowledge", value: true, previewId: p.preview!.id, now: 2_100 }), newer);
});

test("strict acknowledgement, expiry at boundary, suspended timer and backwards clock fail closed", () => {
  const p = preview();
  assert.equal(p.preview!.expiresAt - p.preview!.createdAt, FIXTURE.ttlMs);
  assert.equal(reduce(p, { type: "acknowledge", value: "true" as unknown as boolean, previewId: p.preview!.id, now: 1_100 }).acknowledged, false);
  const ack = reduce(p, { type: "acknowledge", value: true, previewId: p.preview!.id, now: 1_100 });
  assert.equal(reduce(ack, { type: "confirm", previewId: p.preview!.id, now: 60_999 }).phase, "receipt");
  for (const now of [61_000, 90_000, 999, NaN]) {
    const rejected = reduce(ack, { type: "confirm", previewId: p.preview!.id, now });
    assert.equal(rejected.phase, "expired");
    assert.equal(rejected.acknowledged, false);
    assert.equal(rejected.attempts, 0);
  }
  const expired = reduce(p, { type: "tick", now: 61_000 });
  const fresh = reduce(expired, { type: "preview", now: 62_000 });
  assert.equal(fresh.phase, "preview");
  assert.equal(fresh.acknowledged, false);
  assert.notEqual(fresh.preview!.id, p.preview!.id);
});

test("cancel before confirmation consumes UI intent with zero attempts", () => {
  const p = preview();
  const cancelled = reduce(p, { type: "cancel", now: 1_100 });
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(currentFrame(cancelled).state, "SIMULATED_CANCELLED");
  assert.equal(cancelled.attempts, 0);
  assert.equal(reduce(cancelled, { type: "confirm", previewId: p.preview!.id, now: 1_200 }), cancelled);
  assert.equal(next(cancelled), cancelled);
});

test("post-confirm cancel is intent only and fixed acknowledgement preserves partial fills", () => {
  const partial = next(next(confirm()));
  assert.equal(currentFrame(partial).state, "SIMULATED_PARTIALLY_FILLED");
  const pending = reduce(partial, { type: "cancel", now: 2_100 });
  assert.equal(currentFrame(pending).state, "CANCEL_PENDING");
  assert.equal(currentFrame(pending).filled, 500);
  assert.equal(canCancel(pending), false);
  const cancelled = next(pending, 2_200);
  assert.equal(currentFrame(cancelled).state, "SIMULATED_CANCELLED");
  assert.equal(currentFrame(cancelled).filled, 500);
});

test("fixed storyboards cover accepted, fill, rejected, UNKNOWN, empty and error without automatic progress", () => {
  for (const scenario of ["fill", "reject", "unknown", "empty", "error"] as Scenario[]) {
    let view = confirm(preview({ scenario }));
    assert.equal(reduce(view, { type: "tick", now: 99_000 }), view, "time does not manufacture reports");
    while (view.cursor + 1 < view.frames.length) view = next(view);
    assert.equal(currentFrame(view).state, scenario === "fill" || scenario === "unknown" ? "SIMULATED_FILLED" : scenario === "reject" ? "SIMULATED_REJECTED" : "UNKNOWN");
    assert.equal(next(view), view);
    assert.equal(view.attempts, 1);
  }
  const oneShare = confirm(preview({ lot: "ODD", quantity: "1" }));
  assert.equal(oneShare.frames.some((frame) => frame.state === "SIMULATED_PARTIALLY_FILLED"), false);
});

test("UNKNOWN cancellation remains unknown until explicitly played reconciliation and report", () => {
  const unknown = next(confirm(preview({ scenario: "unknown" })));
  const cancelled = reduce(unknown, { type: "cancel", now: 2_100 });
  assert.equal(currentFrame(cancelled).state, "UNKNOWN");
  assert.equal(cancelled.cancelRequested, true);
  const reconciling = next(cancelled, 2_200);
  assert.equal(currentFrame(reconciling).state, "RECONCILING");
  assert.equal(currentFrame(next(reconciling, 2_300)).state, "SIMULATED_CANCELLED");
});

test("reset/reload cannot restore a simulated order or confirmation", () => {
  const cleared = reduce(confirm(), { type: "reset" });
  assert.equal(cleared.preview, null);
  assert.equal(cleared.frames.length, 0);
  assert.equal(cleared.attempts, 0);
  assert.equal(initialTicket("2330").phase, "editing");
});

test("rendered panel has mandatory simulation labels and manual empty inputs, with research separate", () => {
  const html = renderToStaticMarkup(createElement(SyntheticOrderPanel, { symbol: "2330" }));
  for (const label of ["SYNTHETIC", "simulated", "no broker", "unavailable", "未經 M1 後端驗證", "重新載入即清空", "CASH", "DAY"]) assert.ok(html.includes(label), label);
  assert.equal((html.match(/value=""/g) ?? []).length >= 5, true);
  assert.doesNotMatch(html, /SYNTHETIC 預覽 #|SIMULATED_PENDING|type="checkbox"/);
  const context = renderToStaticMarkup(createElement(WorkspaceContext, { symbol: "2330", children: "研究內容" }));
  assert.match(context, /workspace-context-disclosure/);
  assert.match(context, /id="workspace-order-content" hidden=""/);
  assert.match(context, /研究內容/);
});

test("simulation import boundary has no transport, storage, broker or market inputs", () => {
  const model = readFileSync(new URL("./synthetic-ticket.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./SyntheticOrderPanel.tsx", import.meta.url), "utf8");
  const context = readFileSync(new URL("./WorkspaceContext.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(model, /^import\s/m);
  const imports = [...panel.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["react", "./synthetic-ticket"]);
  assert.doesNotMatch(model + panel + context, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|callTool|postMessage)\b/);
  assert.match(panel, /symbol\?: string/);
  assert.match(context, /SyntheticOrderPanel key=\{symbol \?\? ""\} symbol=\{symbol\}/);
});
