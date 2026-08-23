import {
  Badge,
  Button,
  Caption1,
  Spinner,
  Text,
} from "@fluentui/react-components";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatCurrency, numericValue, qualityLabel } from "../format";
import type {
  DailyValuationPoint,
  DashboardHistory,
  DashboardHistoryRange,
  DecimalValue,
} from "../types";

type MetricKey =
  | "provisional_net_worth"
  | "available_cash"
  | "investment_market_value"
  | "debt";

interface MetricOption {
  key: MetricKey;
  label: string;
}

interface PlotPoint {
  source: DailyValuationPoint;
  timestamp: number;
  value: number;
  x: number;
  y: number;
}

const MIN_TREND_POINTS = 8;
const DAY_MS = 86_400_000;
const METRICS: MetricOption[] = [
  { key: "provisional_net_worth", label: "暫估淨資產" },
  { key: "available_cash", label: "可用現金" },
  { key: "investment_market_value", label: "投資市值" },
  { key: "debt", label: "負債" },
];
const RANGES: Array<{ key: DashboardHistoryRange; label: string }> = [
  { key: "1m", label: "1 個月" },
  { key: "3m", label: "3 個月" },
  { key: "1y", label: "1 年" },
];
const compactNumber = new Intl.NumberFormat("zh-TW", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const snapshotDate = new Intl.DateTimeFormat("zh-TW", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function dateTimestamp(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

function formatSnapshotDate(value: string): string {
  return snapshotDate.format(new Date(dateTimestamp(value)));
}

function metricValue(point: DailyValuationPoint, metric: MetricKey): number | null {
  return numericValue(point.metrics[metric]);
}

function metricDecimal(point: DailyValuationPoint, metric: MetricKey): DecimalValue {
  return point.metrics[metric];
}

function yDomain(values: number[]): [number, number] {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (minimum !== maximum) {
    const padding = (maximum - minimum) * 0.12;
    return [minimum - padding, maximum + padding];
  }
  const padding = Math.max(Math.abs(minimum) * 0.08, 1);
  return [minimum - padding, maximum + padding];
}

function splitContinuousSegments(points: PlotPoint[]): PlotPoint[][] {
  const segments: PlotPoint[][] = [];
  for (const point of points) {
    const current = segments.at(-1);
    const previous = current?.at(-1);
    if (!current || !previous || point.timestamp - previous.timestamp > DAY_MS * 1.5) {
      segments.push([point]);
    } else {
      current.push(point);
    }
  }
  return segments;
}

function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => setWidth(Math.max(element.clientWidth, 280));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

export function AssetTrendChart({
  history,
  range,
  loading,
  unavailable,
  onRangeChange,
}: {
  history: DashboardHistory | null;
  range: DashboardHistoryRange;
  loading: boolean;
  unavailable: boolean;
  onRangeChange: (range: DashboardHistoryRange) => void;
}) {
  const [metric, setMetric] = useState<MetricKey>("provisional_net_worth");
  const { ref: chartRef, width } = useContainerWidth();
  const metricOption = METRICS.find((option) => option.key === metric) ?? METRICS[0];
  const height = width < 520 ? 224 : 260;
  const margins = { top: 18, right: 18, bottom: 32, left: width < 520 ? 54 : 68 };

  const plot = useMemo(() => {
    if (!history) return { points: [] as PlotPoint[], ticks: [] as number[] };
    const candidates = history.series.flatMap((point) => {
      const value = metricValue(point, metric);
      return value == null ? [] : [{ point, timestamp: dateTimestamp(point.date), value }];
    });
    if (!candidates.length) return { points: [] as PlotPoint[], ticks: [] as number[] };

    const start = dateTimestamp(history.start_date);
    const end = dateTimestamp(history.end_date);
    const [minimum, maximum] = yDomain(candidates.map((candidate) => candidate.value));
    const plotWidth = Math.max(width - margins.left - margins.right, 1);
    const plotHeight = Math.max(height - margins.top - margins.bottom, 1);
    const points = candidates.map(({ point, timestamp, value }) => ({
      source: point,
      timestamp,
      value,
      x: margins.left + ((timestamp - start) / Math.max(end - start, DAY_MS)) * plotWidth,
      y: margins.top + ((maximum - value) / Math.max(maximum - minimum, 1)) * plotHeight,
    }));
    const ticks = Array.from({ length: 4 }, (_, index) => maximum - ((maximum - minimum) * index) / 3);
    return { points, ticks };
  }, [height, history, margins.bottom, margins.left, margins.right, margins.top, metric, width]);

  const pointCount = history?.coverage.point_count ?? 0;
  const latestPoint = plot.points.at(-1);
  const showLine = plot.points.length >= MIN_TREND_POINTS;
  const segments = showLine ? splitContinuousSegments(plot.points) : [];
  const xLabels = history
    ? [history.start_date, history.end_date]
    : [];

  return (
    <section className="app-section asset-trend-section" aria-labelledby="asset-trend-title">
      <div className="asset-trend-heading">
        <div>
          <div className="asset-trend-title-row">
            <h2 id="asset-trend-title">資產歷史</h2>
            {loading ? <Spinner size="tiny" label="讀取歷史資料" /> : null}
          </div>
          <Caption1>每日不可變估值快照 · TWD · 缺少日期不補零</Caption1>
        </div>
        <div className="asset-trend-range" aria-label="歷史區間">
          {RANGES.map((option) => (
            <Button
              key={option.key}
              size="small"
              appearance={range === option.key ? "primary" : "subtle"}
              aria-pressed={range === option.key}
              disabled={loading}
              onClick={() => onRangeChange(option.key)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="asset-trend-toolbar" aria-label="資產指標">
        {METRICS.map((option) => (
          <Button
            key={option.key}
            size="small"
            appearance={metric === option.key ? "secondary" : "subtle"}
            aria-pressed={metric === option.key}
            onClick={() => setMetric(option.key)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {plot.points.length ? (
        <div className="asset-trend-content">
          <div className="asset-trend-summary">
            <div>
              <Caption1>{metricOption?.label ?? "資產指標"} · 最新保存值</Caption1>
              <Text size={600} weight="semibold">
                {latestPoint ? formatCurrency(metricDecimal(latestPoint.source, metric)) : "缺少資料"}
              </Text>
            </div>
            <div className="asset-trend-evidence">
              <Badge appearance="outline" color={latestPoint?.source.provisional ? "warning" : "success"}>
                {latestPoint?.source.provisional ? "暫估" : "完整"}
              </Badge>
              <Caption1>{latestPoint ? `${formatSnapshotDate(latestPoint.source.date)} · ${qualityLabel(latestPoint.source.quality)}` : ""}</Caption1>
            </div>
          </div>

          <div className="asset-trend-chart" ref={chartRef}>
            <svg
              width="100%"
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={`${metricOption?.label ?? "資產指標"}，${pointCount} 個每日估值點`}
            >
              {plot.ticks.map((tick, index) => {
                const y = margins.top + ((height - margins.top - margins.bottom) * index) / 3;
                return (
                  <g key={`${tick}:${index}`}>
                    <line className="asset-trend-gridline" x1={margins.left} x2={width - margins.right} y1={y} y2={y} />
                    <text className="asset-trend-axis-label" x={margins.left - 10} y={y + 4} textAnchor="end">
                      {compactNumber.format(tick)}
                    </text>
                  </g>
                );
              })}
              {segments.map((segment) => segment.length > 1 ? (
                <polyline
                  key={`${segment[0]?.source.id ?? "segment"}:${segment.length}`}
                  className="asset-trend-line"
                  points={segment.map((point) => `${point.x},${point.y}`).join(" ")}
                />
              ) : null)}
              {plot.points.map((point) => (
                <circle
                  key={point.source.id}
                  className={point.source.provisional ? "asset-trend-point provisional" : "asset-trend-point"}
                  cx={point.x}
                  cy={point.y}
                  r={point.source.provisional ? 4.5 : 4}
                >
                  <title>{`${point.source.date} · ${formatCurrency(metricDecimal(point.source, metric))} · ${qualityLabel(point.source.quality)}`}</title>
                </circle>
              ))}
              {xLabels.map((label, index) => (
                <text
                  key={label}
                  className="asset-trend-axis-label"
                  x={index === 0 ? margins.left : width - margins.right}
                  y={height - 8}
                  textAnchor={index === 0 ? "start" : "end"}
                >
                  {formatSnapshotDate(label)}
                </text>
              ))}
            </svg>
          </div>

          <div className="asset-trend-caption">
            <Caption1>
              {showLine
                ? `${pointCount} 個保存點；線段遇到缺日會中斷。縱軸依目前區間縮放。`
                : `目前 ${pointCount} 個保存點；累積 ${MIN_TREND_POINTS} 點後才連成趨勢線，避免用稀疏資料製造趨勢。`}
            </Caption1>
            <span className="asset-trend-key"><i aria-hidden="true" />空心虛線點代表暫估資料</span>
          </div>
          <ol className="sr-only">
            {plot.points.map((point) => (
              <li key={`accessible:${point.source.id}`}>
                {point.source.date}，{metricOption?.label} {formatCurrency(metricDecimal(point.source, metric))}，{qualityLabel(point.source.quality)}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="asset-trend-empty">
          <Text weight="semibold">{unavailable ? "資產歷史目前無法讀取" : "每日資料正在累積"}</Text>
          <Caption1>
            {unavailable
              ? "詳細原因已放在上方更新狀態；其他資產資料仍可正常使用。"
              : "PAOS 會在每日取樣時間保存一個彙總估值點，累積後才顯示趨勢。"}
          </Caption1>
        </div>
      )}
    </section>
  );
}
