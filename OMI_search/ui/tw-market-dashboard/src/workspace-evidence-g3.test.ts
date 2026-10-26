import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { collectDiagnostics, collectProvenance, criticalStatuses, sourceCategory, SourceDetails, StatusBadge, statusNotice, WorkspaceStatusPanel, type StatusSource } from "./workspace-evidence";
import type { UnknownRecord } from "./state";

const source = (data: UnknownRecord | null, patch: Partial<StatusSource["pane"]> = {}): StatusSource => ({
  id: "header", name: "市場 Header", pane: { data, key: "header", dataKey: data ? "header" : null, loading: false, error: null, ...patch },
});
const healthy = { status: "ready", freshness: { status: "latest_completed_session" } };
// Reduced field-level regression fixture from user-supplied 2026-10-10 evidence.
// No live request, provider acquisition, generated schema or market inference.
const header = {
  kind: "omi.tw_workspace_header", version: "omi.tw_workspace_header.v1",
  freshness: { status: "latest_completed_session" },
  session: { presentation_state: "previous_session", trade_date: "2026-10-08" },
  resolved_breadth: {
    TWSE: { status: "partial", coverage: 1044, universe: 1080,
      acquisition_diagnostics: { missing_z_rescue: { status: "blocked", source: "historical-provider", reason_code: "RESCUE_BLOCKED", warnings: ["RESCUE_WARNING"], limitations: ["RESCUE_LIMIT"] } } },
    TPEX: { status: "partial", coverage: 781, universe: 887 },
  },
  warnings: ["HEADER_WARNING"], limitations: ["HEADER_LIMIT"],
};
const details = (entry: StatusSource) => renderToStaticMarkup(createElement(SourceDetails, { source: entry }));

test("G3 successful Header with historical rescue blocked and breadth partial is limited, not request error", () => {
  const before = JSON.stringify(header);
  const entry = source(header);
  assert.equal(sourceCategory(entry), "部分受限");
  assert.equal(statusNotice(header), "部分受限");
  assert.deepEqual(new Set(criticalStatuses(header)), new Set(["partial", "blocked"]));
  const html = renderToStaticMarkup(createElement(WorkspaceStatusPanel, { sources: [entry] }));
  assert.match(html, /錯誤 0 · 部分受限 1/);
  assert.doesNotMatch(html, /RESCUE_WARNING|<pre/);
  const expanded = details(entry);
  for (const value of ["1044", "1080", "781", "887", "previous_session", "latest_completed_session", "blocked", "historical-provider", "RESCUE_BLOCKED", "RESCUE_WARNING", "RESCUE_LIMIT", "HEADER_WARNING", "HEADER_LIMIT"]) assert.ok(expanded.includes(value), value);
  assert.doesNotMatch(expanded, /role="alert"|更新錯誤|讀取失敗/);
  assert.ok(collectProvenance(header).some(({ path, value }) => path.endsWith("missing_z_rescue.status") && value === "blocked"));
  assert.equal(collectDiagnostics(header).length, 5);
  assert.equal(JSON.stringify(header), before);
});

test("G3 root failure, nested market failure and acquisition failure retain different scopes", () => {
  for (const status of ["blocked", "error", "failed", "rejected", "forbidden", "denied", "ERROR"]) {
    assert.equal(sourceCategory(source({ ...healthy, status })), "錯誤", status);
    const nested = { ...healthy, nested: { status } };
    assert.equal(sourceCategory(source(nested)), "部分受限", status);
    assert.doesNotMatch(statusNotice(nested) ?? "", /讀取失敗|後端狀態異常/);
    const historical = { ...healthy, nested: { acquisition_diagnostics: { missing_z_rescue: { status } } } };
    assert.equal(sourceCategory(source(historical)), "警告", status);
    assert.equal(statusNotice(historical), "資料限制");
    assert.match(details(source(historical)), /擷取診斷受限/);
    assert.ok(details(source(historical)).includes(status));
  }
  assert.equal(sourceCategory(source({ ...healthy, ok: false })), "錯誤");
  assert.equal(sourceCategory(source({ ...healthy, nested: { ok: false } })), "部分受限");
  assert.equal(statusNotice({ ...healthy, ok: false }), "讀取失敗");
});

test("G3 request error wins over retained healthy, degraded and absent data", () => {
  for (const data of [null, {}, healthy, header, { status: "blocked" }]) {
    const entry = source(data, { error: "request timeout", loading: true, key: "new" });
    assert.equal(sourceCategory(entry), "錯誤");
    assert.match(details(entry), /role="alert">更新錯誤：request timeout/);
  }
});

test("G3 pending and mismatched requests cannot inherit retained evidence classification", () => {
  for (const data of [null, {}, healthy, header, { status: "blocked" }, { freshness: { status: "stale" } }]) {
    assert.equal(sourceCategory(source(data, { loading: true })), "未確認");
    assert.equal(sourceCategory(source(data, { key: "new" })), "未確認");
    assert.equal(sourceCategory(source(data, { dataKey: null })), "未確認");
    assert.equal(sourceCategory(source(data, { key: null })), "未請求");
  }
  const expanded = details(source(header, { loading: true, key: "new" }));
  for (const label of ["讀取中", "保留上次結果", "舊選取快取", "partial", "blocked", "RESCUE_WARNING"]) assert.ok(expanded.includes(label), label);
});

test("G3 empty or incomplete root health never becomes normal merely from transport success", () => {
  for (const data of [null, {}, { status: "ready" }, { freshness: { status: "fresh" } }, { status: "unknown" }]) assert.notEqual(sourceCategory(source(data)), "正常");
  assert.equal(sourceCategory(source(healthy)), "正常");
  assert.equal(sourceCategory(source({ ...healthy, warnings: ["warning"] })), "警告");
  assert.equal(sourceCategory(source({ ...healthy, limitations: ["limitation"] })), "警告");
  assert.equal(sourceCategory({ ...source(healthy), presentation: { notice: "研究與圖表不符", facts: [] } }), "部分受限");
});

test("G3 stale and decision unusable remain visible alongside partial and rescue failure", () => {
  for (const status of ["stale", "delayed"]) {
    const data = { ...healthy, nested: { freshness_status: status } };
    assert.equal(sourceCategory(source(data)), "警告");
    assert.equal(statusNotice(data), "資料過期");
  }
  const data = { ...header, nested: { decision_usable: false, freshness_status: "stale", status: "partial" } };
  assert.equal(sourceCategory(source(data)), "部分受限");
  const badge = renderToStaticMarkup(createElement(StatusBadge, { data }));
  assert.equal(statusNotice(data), "不可供決策 · 資料過期");
  const expanded = details(source(data));
  for (const label of ["不可供決策", "資料過期", "部分受限", "擷取診斷受限"]) assert.ok(expanded.includes(label), label);
  assert.doesNotMatch(badge, /部分受限|擷取診斷受限/);
  assert.doesNotMatch(badge, /讀取失敗/);
});

test("G3 main badge has at most two short signals; source details keep all nested evidence", () => {
  const data = { ...header, freshness: { status: "stale" }, chart: { series_coverage: {
    version: "tw.bar.history_coverage.v1", status: "partial", limitations: ["HISTORY_LIMIT"],
  } } };
  assert.equal(statusNotice(data), "資料過期 · 部分受限");
  const badge = renderToStaticMarkup(createElement(StatusBadge, { data }));
  assert.equal((badge.match(/ · /g) ?? []).length, 1);
  assert.doesNotMatch(badge, /擷取診斷|歷史查詢覆蓋|RESCUE_|HISTORY_LIMIT|<pre/);
  const expanded = details(source(data));
  for (const label of ["資料過期", "部分受限", "擷取診斷受限", "歷史查詢覆蓋受限", "RESCUE_WARNING", "RESCUE_LIMIT", "HISTORY_LIMIT", "missing_z_rescue.status", "chart.series_coverage.status", "blocked"]) assert.ok(expanded.includes(label), label);
  assert.equal(sourceCategory(source(data)), "部分受限");
  assert.doesNotMatch(renderToStaticMarkup(createElement(WorkspaceStatusPanel, { sources: [source(data)] })), /RESCUE_WARNING|HISTORY_LIMIT|<pre/);
});

test("G3 nested missing, unavailable, unknown and truncated cannot be bleached by healthy root", () => {
  for (const status of ["partial", "missing", "unavailable", "not_ready", "not_provided", "decision_unusable", "insufficient"]) assert.equal(sourceCategory(source({ ...healthy, nested: { status } })), "部分受限", status);
  for (const status of ["unknown", "degraded"]) assert.equal(sourceCategory(source({ ...healthy, nested: { status } })), "警告", status);
  assert.equal(sourceCategory(source({ ...healthy, nested: { truncated: true } })), "部分受限");
  assert.equal(sourceCategory(source({ ...healthy, nested: { decision_usable: false } })), "部分受限");
});

for (const [stock_id, bars, first] of [["2330", 265, "09:00"], ["00631L", 263, "09:02"]] as const) {
  test(`G3 ${stock_id} multi-day history coverage does not determine October 8 bar completeness`, () => {
    // Bounds/counts supplied by the user; points are synthetic display fixtures.
    const points = Array.from({ length: bars }, (_, i) => ({ time: `2026-10-08T${i === 0 ? first : "13:24"}:00+08:00`, close: 100 }));
    const data = { ...healthy, stock_id, chart: { points, series_coverage: {
      version: "tw.bar.history_coverage.v1", status: "partial", warnings: ["MULTI_DAY_PARTIAL"],
    } } };
    const before = JSON.stringify(data);
    assert.equal(sourceCategory(source(data)), "部分受限");
    assert.equal(statusNotice(data), "資料限制");
    const html = details(source(data));
    assert.match(html, /不能據此判定特定當日缺 K/);
    assert.match(html, /chart.series_coverage.status/);
    assert.match(html, /MULTI_DAY_PARTIAL/);
    assert.equal(points.length, bars);
    assert.equal(JSON.stringify(data), before);
    // Even a contradictory synthetic point flag is not used to infer day health.
    assert.equal(statusNotice({ ...data, chart: { ...data.chart, points: [{ status: "blocked", decision_usable: false }] } }), "資料限制");
  });
}
