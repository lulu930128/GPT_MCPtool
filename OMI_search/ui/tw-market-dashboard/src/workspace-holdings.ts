import { isRecord, type UnknownRecord } from "./state";

export const HOLDINGS_LIMIT = 20;
// This UI request only consumes the existing backend-owned portfolio capability.
export function holdingsArgs(): UnknownRecord {
  return {
    question: "讀取已記錄的台股持股清單，只作前端顯示；不得同步或更新",
    target: { type: "portfolio" }, mode: "data_only", output: "evidence_only",
    selection: { include: ["portfolio.holdings"], limits: { "portfolio.holdings": HOLDINGS_LIMIT } },
    realtime_policy: "cache_only",
    refresh_policy: { mode: "off", before_answer: false, fallback_to_cached: true },
    tool_budget: { max_calls: 1, max_external_fetches: 0, max_total_seconds: 12 },
    payload_level: "compact", refresh_if_missing: false,
  };
}

export function readHoldingsEnvelope(response: unknown): UnknownRecord {
  if (isRecord(response) && response.isError === true) throw new Error("持股工具讀取失敗或禁止存取；無法確認持股");
  const data = isRecord(response) && "structuredContent" in response ? response.structuredContent : response;
  if (!isRecord(data) || data.contract_version !== "omi.decision.v4") throw new Error("持股資料格式不符；無法確認持股");
  return data;
}

const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
export type HoldingItem = { symbol: string; name?: string; source?: string; priceSource?: string; priceAsOf?: string; priceStatus?: string };
export type HoldingsView = {
  items: HoldingItem[]; state: "unavailable" | "empty" | "available" | "partial";
  status: string; truncated: boolean; atLimit: boolean; invalidCount: number; excludedCount: number;
};

export function parseHoldings(data: UnknownRecord): HoldingsView {
  const evidence = record(data.evidence);
  const capabilities = record(evidence.manifest).capabilities;
  const capability = record(Array.isArray(capabilities) ? capabilities.find((item) => isRecord(item) && item.capability === "portfolio.holdings") : null);
  const rows = record(evidence.data)["portfolio.holdings"];
  const status = text(capability.status) ?? "unknown";
  const view: HoldingsView = { items: [], state: "unavailable", status, truncated: capability.truncated === true, atLimit: false, invalidCount: 0, excludedCount: 0 };
  // A transport success is not permission or evidence success. Unknown statuses fail closed.
  if (data.ok !== true || data.request_status !== "completed" || capability.payload_included !== true ||
      !["ready", "available", "partial", "stale", "delayed", "cached", "empty", "not_applicable"].includes(status) || !Array.isArray(rows)) return view;
  view.atLimit = rows.length >= HOLDINGS_LIMIT;
  view.truncated ||= typeof capability.canonical_available_count === "number" && capability.canonical_available_count > rows.length;
  for (const row of rows) {
    if (!isRecord(row) || !text(row.market)) { view.invalidCount++; continue; }
    if (String(row.market).toLowerCase() !== "tw") { view.excludedCount++; continue; }
    if (!text(row.symbol)) { view.invalidCount++; continue; }
    view.items.push({ symbol: String(row.symbol), name: text(row.display_name) ?? text(row.symbol_name), source: text(row.source),
      priceSource: text(row.price_source), priceAsOf: text(row.price_as_of), priceStatus: text(row.price_resolved_status) });
  }
  const incomplete = view.truncated || view.atLimit || view.invalidCount > 0 ||
    ["partial", "stale", "delayed"].includes(status) || capability.coverage_status === "partial";
  view.state = incomplete ? "partial" : view.items.length ? "available" : "empty";
  return view;
}
