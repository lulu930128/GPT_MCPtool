import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FillCapsules, InventoryCapsules } from "./DeskOrders";
import { inventoryPresentation, stockGroups } from "./readback-presentation";
import { fillView } from "./broker-orders";
import { fixtureReadbackCapsules } from "../scripts/readback-capsules-fixture";

test("fill grouping keeps interleaved buys/sells, duplicate reports, original values and order", () => {
  const data = fixtureReadbackCapsules(), before = JSON.stringify(data);
  const groups = stockGroups(data.fills);
  assert.deepEqual(groups.map(group => [group.symbol, group.rows.length]), [["2330", 2], ["8227", 2]]);
  assert.equal(groups[0].rows[0], data.fills[0]);
  assert.equal(groups[0].rows[1], data.fills[2]);
  assert.equal(stockGroups([data.fills[0], data.fills[0]])[0].rows.length, 2);
  const html = renderToStaticMarkup(createElement(FillCapsules, { rows: fillView(data, "history").dated }));
  assert.equal((html.match(/workspace-readback-card/g) ?? []).length, 2);
  for (const value of ["2026-11-06", "2026-11-09", "2026-11-10", "現股買進", "現股賣出", "2,140", "2,240", "零股 1 股", "數量未確認", "未提供"]) assert.ok(html.includes(value), value);
  assert.equal((html.match(/數量未確認/g) ?? []).length, 2);
  assert.equal(fillView(data, "today").dated.length, 0);
  assert.equal(fillView(data, "history", "2026-11-09").dated.length, 2);
  assert.equal(JSON.stringify(data), before);
});

test("unknown symbols and undated fills are retained separately, without fabricated identity/date", () => {
  assert.equal(stockGroups([{ symbol: null }, { symbol: null }, { symbol: "" }]).length, 3);
  const data = fixtureReadbackCapsules();
  data.fills[0].broker_key.trade_date = null;
  const view = fillView(data, "history");
  assert.equal(view.undated[0], data.fills[0]);
  const html = renderToStaticMarkup(createElement(FillCapsules, { rows: view.undated }));
  assert.match(html, /未提供/);
  assert.doesNotMatch(html, /2026-11-18/);
});

test("3702 cash 1000 leads; zero records remain collapsed with their original credit types", () => {
  const data = fixtureReadbackCapsules(), before = JSON.stringify(data);
  const groups = inventoryPresentation(data.inventory);
  assert.deepEqual(groups.nonzero.map(group => group.symbol), ["3702"]);
  assert.deepEqual(groups.zero.map(group => group.symbol), ["2637"]);
  assert.equal(groups.nonzero[0].rows.length, 3);
  assert.equal(groups.nonzero[0].rows[0].row, data.inventory.cash.items[1]);
  const html = renderToStaticMarkup(createElement(InventoryCapsules, { inventory: data.inventory }));
  assert.ok(html.includes("3702 券商庫存"));
  assert.ok(!html.includes("2637 券商庫存"), "zero-only stocks mount on expansion, avoiding hidden name reads");
  assert.match(html, /今日餘額<\/dt><dd>1000 股/);
  assert.match(html, /可出清 1000 股/); assert.match(html, /可下單 1000 股/);
  assert.match(html, /融券餘額（待回補）/); assert.match(html, /不另加總/);
  assert.equal(groups.nonzero[0].rows.length + groups.zero[0].rows.length, 6);
  assert.equal((html.match(/class="workspace-readback-entry"/g) ?? []).length, 3);
  assert.equal((html.match(/零值不代表已確認空手/g) ?? []).length, 3);
  assert.match(html, /2026-11-18T10:20:00\+08:00/);
  assert.match(html, /券商資料時間 未提供/);
  assert.doesNotMatch(html, /<details[^>]* open|已確認此類無持倉/);
  assert.equal(JSON.stringify(data), before);
});

test("only explicit zero in every displayed balance field can collapse; missing/invalid remain visible", () => {
  const zero = { symbol: "2637", reported_total_shares: 0, closeable_shares: 0, orderable_shares: 0, odd_shares: 0, odd_closeable_shares: 0 };
  for (const field of ["reported_total_shares", "closeable_shares", "orderable_shares", "odd_shares", "odd_closeable_shares"]) {
    for (const missing of [null, undefined, "", "UNKNOWN", false, NaN, Infinity, " ", "0.0", Number.MAX_SAFE_INTEGER + 1]) {
      const groups = inventoryPresentation({ cash: { items: [{ ...zero, [field]: missing }] } });
      assert.equal(groups.zero.length, 0, `${field}: ${missing}`);
      assert.equal(groups.unknown.length, 1);
    }
  }
  assert.equal(inventoryPresentation({ cash: { items: [{ ...zero, reported_total_shares: "0" }] } }).zero.length, 1);
  for (const field of Object.keys(zero).filter(key => key !== "symbol")) {
    assert.equal(inventoryPresentation({ cash: { items: [{ ...zero, [field]: 1 }] } }).nonzero.length, 1);
  }
  assert.equal(inventoryPresentation({ cash: { items: [{ ...zero, reported_total_shares: -10 }] } }).nonzero.length, 1);
});

test("mixed stock types never net/sum, malformed rows survive, partial empty and unknown stay distinct", () => {
  const data = fixtureReadbackCapsules();
  const inventory = { ...data.inventory, margin: { ...data.inventory.margin, items: [{ symbol: "3702", reported_total_shares: 500 }] } };
  const groups = inventoryPresentation(inventory);
  assert.equal(groups.nonzero[0].rows[0].row.reported_total_shares, 1000);
  assert.equal(groups.nonzero[0].rows[1].row.reported_total_shares, 500);
  const html = renderToStaticMarkup(createElement(InventoryCapsules, { inventory }));
  assert.match(html, /1000 股/); assert.match(html, /500 股/); assert.doesNotMatch(html, /1500 股/);
  const empty = renderToStaticMarkup(createElement(InventoryCapsules, { inventory: {
    cash: { quality: "PARTIAL", complete: false, items: [] }, margin: { quality: "UNKNOWN", complete: false, items: null },
    short_selling: { quality: "KNOWN", complete: true, empty_confirmed: true, items: [] },
  } }));
  assert.match(empty, /本次未回傳庫存列，尚不能確認空手/);
  assert.match(empty, /庫存未知，不視為零/); assert.match(empty, /已確認此類無持倉/);
  assert.equal(inventoryPresentation({ cash: { items: [null, { symbol: null }] } }).unknown.length, 2);
  const missing = renderToStaticMarkup(createElement(InventoryCapsules, { inventory: { cash: { items: [{ symbol: "2330" }] } } }));
  assert.match(missing, /餘額待確認/); assert.match(missing, /未提供 股/);
});
