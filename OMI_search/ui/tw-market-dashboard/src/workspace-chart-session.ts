import { isRecord, type UnknownRecord } from "./state";
const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const rows = (value: unknown): UnknownRecord[] => Array.isArray(value) ? value.filter(isRecord) : [];

// Consume Backend session identity; never choose a trading day from local time.
export function chartSession(data: UnknownRecord, previous = false) {
  const chart = record(data.intraday_chart), old = record(chart.previous_session);
  const selected = previous ? old : chart;
  const prior = previous || chart.presentation_state === "previous_session";
  const eligible = previous || chart.session_relation === "current_session"
    || (chart.session_relation === "previous_session" && chart.presentation_state === "previous_session");
  const date = typeof selected.trade_date === "string" ? selected.trade_date : "";
  const points = eligible && date ? rows(selected.points).filter(point => typeof point.time === "string" && point.time.slice(0, 10) === date) : [];
  const coverage = record(chart.series_coverage);
  return { points, date, prior, previousDate: typeof old.trade_date === "string" ? old.trade_date : null,
    label: `${prior ? "上一交易日" : "今日"} ${date || "交易日未確認"}`,
    status: previous ? "歷史快取" : points.length ? String(chart.status ?? coverage.status ?? "partial") : "missing",
    coverage: !previous && coverage.trade_date === date ? `${coverage.observed_bucket_count ?? "?"}/${coverage.expected_bucket_count ?? "?"} 根` : "",
    asOf: points.at(-1)?.time as string | undefined };
}
