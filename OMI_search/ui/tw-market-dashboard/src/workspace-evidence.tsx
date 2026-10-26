import { useState, type ReactNode } from "react";
import { isRecord, type UnknownRecord } from "./state";
import type { PaneState } from "./workspace-state";

const diagnosticKeys = new Set(["warnings", "limitations", "missing", "warning", "reason_code", "price_limitations", "quality_issues"]);
export type Diagnostic = { path: string; kind: string; value: unknown };
export function collectDiagnostics(data: unknown): Diagnostic[] {
  const notices: Diagnostic[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      if (diagnosticKeys.has(key) && item) {
        for (const entry of Array.isArray(item) ? item : [item]) notices.push({ path: next, kind: key, value: entry });
      } else if (key !== "points" && key !== "moving_averages") visit(item, next);
    }
  };
  visit(data, "");
  return notices;
}

// Native details hides paint, but React must also avoid creating its closed content.
export function LazyDetails({ summary, children, className }: { summary: ReactNode; children: () => ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return <details className={className} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>{open ? children() : null}
  </details>;
}

const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
type StatusScope = "root" | "domain" | "acquisition" | "historyCoverage";
type CriticalStatus = { scope: StatusScope; value: string };
// Keep the backend field's scope: nested evidence is not a request failure.
// No timestamp, calendar, provider or bar-completeness inference belongs here.
function scopedCriticalStatuses(data: unknown): CriticalStatus[] {
  const statuses: CriticalStatus[] = [];
  const visit = (value: unknown, scope: StatusScope) => {
    if (Array.isArray(value)) { value.forEach((item) => visit(item, scope)); return; }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const add = (value: string) => statuses.push({ scope, value });
      if ((key === "status" || key.endsWith("_status") || key.includes("freshness") || key === "data_quality") && typeof item === "string" && /partial|stale|missing|blocked|error|unavailable|unusable|forbidden|denied|failed|rejected|unknown|not_ready|not_provided|delayed|degraded|insufficient/i.test(item)) add(item);
      if (key === "truncated" && item === true) add("truncated");
      if (key === "decision_usable" && item === false) add("decision_unusable");
      if (key === "ok" && item === false) add("error");
      const nestedScope = scope === "acquisition" || scope === "historyCoverage" ? scope
        : key === "acquisition_diagnostics" ? "acquisition"
        : key === "series_coverage" ? "historyCoverage" : "domain";
      if (!diagnosticKeys.has(key) && key !== "points" && key !== "moving_averages") visit(item, nestedScope);
    }
  };
  visit(data, "root");
  return statuses;
}

// Retain the existing public helper for callers that only need a degradation flag.
export function criticalStatuses(data: unknown): string[] {
  return [...new Set(scopedCriticalStatuses(data).map(({ value }) => value))];
}

// Translate explicit evidence only. This is a display label, never a new quality verdict.
function statusLabels(data: unknown, details = false): string[] {
  if (!data) return ["尚無資料"];
  const statuses = scopedCriticalStatuses(data);
  const critical = statuses.filter(({ scope }) => scope === "root" || scope === "domain").map(({ value }) => value).join(" ");
  const labels: string[] = [];
  if (statuses.some(({ scope, value }) => scope === "root" && /error|failed|rejected/i.test(value))) labels.push("讀取失敗");
  if (/blocked|forbidden|denied/i.test(critical)) labels.push("存取受限");
  if (/unusable/i.test(critical)) labels.push("不可供決策");
  if (/stale|delayed/i.test(critical)) labels.push("資料過期");
  if (/partial|missing|unavailable|not_ready|not_provided|truncated|insufficient|degraded/i.test(critical)
    || statuses.some(({ scope, value }) => scope === "domain" && /error|failed|rejected/i.test(value))) labels.push("部分受限");
  if (/unknown/i.test(critical)) labels.push("狀態未確認");
  if (details && statuses.some(({ scope }) => scope === "acquisition")) labels.push("擷取診斷受限");
  if (details && statuses.some(({ scope }) => scope === "historyCoverage")) labels.push("歷史查詢覆蓋受限");
  return labels.length ? labels : statuses.length || collectDiagnostics(data).length ? ["資料限制"] : [];
}

export function statusNotice(data: unknown): string | null {
  // Main badges stay compact; the source disclosure retains every signal.
  return statusLabels(data).slice(0, 2).join(" · ") || null;
}

export function StatusBadge({ data, prefix = "" }: { data: unknown; prefix?: string }) {
  const notice = statusNotice(data);
  return notice ? <small className="workspace-quality-badge" role="status">{prefix}{notice}</small> : null;
}

export type PresentationEvidence = { notice: string | null; facts: { label: string; value: string }[] };
export type StatusSource = { id: string; name: string; pane: PaneState & { key: string | null }; presentation?: PresentationEvidence };
export type SourceCategory = "正常" | "警告" | "錯誤" | "部分受限" | "未確認" | "未請求";
export function sourceCategory({ pane, presentation }: StatusSource): SourceCategory {
  if (pane.error) return "錯誤";
  if (pane.key === null) return "未請求";
  if (!pane.data || pane.dataKey !== pane.key || pane.loading) return "未確認";
  const statuses = scopedCriticalStatuses(pane.data);
  if (statuses.some(({ scope, value }) => scope === "root" && /error|failed|rejected|forbidden|denied|blocked/i.test(value))) return "錯誤";
  const evidence = statuses.filter(({ scope }) => scope !== "acquisition").map(({ value }) => value).join(" ");
  if (/partial|missing|unavailable|not_ready|not_provided|truncated|unusable|insufficient|error|failed|rejected|forbidden|denied|blocked/i.test(evidence) || presentation?.notice) return "部分受限";
  if (statuses.length || collectDiagnostics(pane.data).length) return "警告";
  // Transport success alone is not evidence of healthy market data.
  const status = pane.data.status ?? pane.data.quality_status;
  const freshness = record(pane.data.freshness).status;
  return /^(ready|ok|complete|available)$/.test(String(status)) && /^(fresh|current|latest_completed_session)$/.test(String(freshness)) ? "正常" : "未確認";
}

export function collectProvenance(data: unknown): { path: string; value: string }[] {
  const result: { path: string; value: string }[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, `${path}[${i}]`)); return; }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      if (/source|provider|freshness|status|generated_at|as_of|event_time|received_at|trade_date|latest_data_date|_time$|^time$|authority|decision_usable|presentation_state|phase|index_id|market|_unit$|coverage|universe|truncated/.test(key) && (typeof item === "string" || typeof item === "boolean" || typeof item === "number")) result.push({ path: next, value: String(item) });
      if (!diagnosticKeys.has(key) && key !== "points" && key !== "moving_averages") visit(item, next);
    }
  };
  visit(data, "");
  return result;
}

export function SourceDetails({ source }: { source: StatusSource }) {
  const { pane } = source;
  const notices = collectDiagnostics(pane.data);
  const provenance = collectProvenance(pane.data);
  const notice = statusLabels(pane.data, true).join(" · ");
  return <div className="workspace-source-details">
    <p>各來源獨立更新；產生時間不代表市場資料時間。</p>
    {pane.loading && <p role="status">讀取中{pane.data ? " · 保留上次結果" : ""}</p>}
    {pane.error && <p role="alert">更新錯誤：{pane.error}{pane.data ? " · 以下為上次快取" : ""}</p>}
    {pane.data && pane.dataKey !== pane.key && <p role="status">保留舊選取快取，尚未對應目前請求</p>}
    <div>目前請求：{pane.key ?? "未請求"}</div><div>已載入：{pane.dataKey ?? "無資料"}</div>
    {pane.data && notice && <p role="status">後端／市場證據：{notice}</p>}
    {scopedCriticalStatuses(pane.data).some(({ scope }) => scope === "historyCoverage") && <p>歷史查詢覆蓋描述整段查詢範圍，不能據此判定特定當日缺 K。</p>}
    {source.presentation && <div aria-label="圖表與研究對應詳情">
      {source.presentation.notice && <p role="status">{source.presentation.notice}</p>}
      <dl>{source.presentation.facts.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </div>}
    {!provenance.some((item) => /time|date|as_of|_at/.test(item.path)) && <p>來源時間未提供</p>}
    {!provenance.some((item) => /freshness/.test(item.path)) && <p>freshness 未提供</p>}
    <dl>{provenance.map((item) => <div key={item.path}><dt>{item.path}</dt><dd>{item.value}</dd></div>)}</dl>
    <div>警告／限制 {notices.length} 項</div>
    <div className="workspace-diagnostics">{notices.map((item, i) => <p key={i}>{item.path}: {typeof item.value === "string" ? item.value : JSON.stringify(item.value)}</p>)}</div>
    <LazyDetails summary="必要原始證據">{() => <pre>{JSON.stringify(pane.data, null, 2)}</pre>}</LazyDetails>
  </div>;
}

export function WorkspaceStatusPanel({ sources }: { sources: StatusSource[] }) {
  const classified = sources.map((source) => ({ source, category: sourceCategory(source) }));
  const counts = new Map<SourceCategory, number>();
  for (const { category } of classified) counts.set(category, (counts.get(category) ?? 0) + 1);
  const categories: SourceCategory[] = ["正常", "警告", "錯誤", "部分受限", "未確認", "未請求"];
  return <section className="workspace-status-panel" aria-label="資料狀態／更新狀態">
    <LazyDetails summary={<><strong>資料狀態／更新狀態</strong><span className="workspace-status-counts" role="status">{categories.filter((key) => counts.has(key) || ["正常", "警告", "錯誤", "部分受限"].includes(key)).map((key) => `${key} ${counts.get(key) ?? 0}`).join(" · ")}{sources.some(({ pane }) => pane.loading) ? ` · 讀取中 ${sources.filter(({ pane }) => pane.loading).length}` : ""}</span></>}>
      {() => <div className="workspace-status-scroll" tabIndex={0} role="region" aria-label="各來源更新詳情">
        <p>計數按來源分類，每個來源只計一次；各區塊並非同一份快照。</p>
        {classified.map(({ source, category }) => <LazyDetails key={source.id} summary={`${source.name} · ${category}${source.pane.loading ? " · 讀取中" : ""}`}>
          {() => <SourceDetails source={source} />}
        </LazyDetails>)}
      </div>}
    </LazyDetails>
  </section>;
}
