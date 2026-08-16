import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type LineData,
  type Logical,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

export type DashboardChartTimeframe = "today" | "daily" | "weekly" | "monthly";

type RawPoint = Record<string, unknown>;

type NormalizedPoint = {
  rawTime: string;
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

type HoveredPoint = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

const palette = {
  background: "#0b1119",
  grid: "#223147",
  axis: "#31445c",
  text: "#8fa5ba",
  up: "#ff4d61",
  down: "#16b8a6",
  ma5: "#59a8f5",
  ma20: "#f1b51c",
  ma60: "#a990f4",
  crosshair: "#71879d",
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toChartTime(value: unknown, timeframe: DashboardChartTimeframe): Time | null {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return null;
  if (timeframe !== "today") return raw.slice(0, 10);
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds)
    ? (Math.floor(milliseconds / 1000) as UTCTimestamp)
    : null;
}

function normalizePoints(
  points: RawPoint[],
  timeframe: DashboardChartTimeframe,
): NormalizedPoint[] {
  return points.flatMap((point) => {
    const time = toChartTime(point.time, timeframe);
    const open = finite(point.open);
    const high = finite(point.high);
    const low = finite(point.low);
    const close = finite(point.close);
    if (time === null || open === null || high === null || low === null || close === null) {
      return [];
    }
    return [{
      rawTime: String(point.time),
      time,
      open,
      high,
      low,
      close,
      volume: finite(point.volume),
    }];
  });
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("zh-TW", {
    maximumFractionDigits: 2,
  }).format(value);
}

function formatVolume(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("zh-TW", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatTime(value: Time, timeframe: DashboardChartTimeframe) {
  if (typeof value === "number") {
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value * 1000));
  }
  if (typeof value === "string") return value.slice(0, 10);
  const month = String(value.month).padStart(2, "0");
  const day = String(value.day).padStart(2, "0");
  return timeframe === "today"
    ? `${month}/${day}`
    : `${value.year}-${month}-${day}`;
}

function formatTickTime(value: Time, timeframe: DashboardChartTimeframe) {
  if (typeof value === "number") {
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value * 1000));
  }
  const raw = typeof value === "string"
    ? value
    : `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
  if (timeframe === "monthly") return raw.slice(0, 7).replace("-", "/");
  return raw.slice(5, 10).replace("-", "/");
}

function latestRange(pointCount: number, timeframe: DashboardChartTimeframe): LogicalRange {
  const visibleBars = timeframe === "today" ? 120 : timeframe === "daily" ? 90 : 72;
  return {
    from: Math.max(-2, pointCount - visibleBars) as Logical,
    to: (pointCount + 2) as Logical,
  };
}

export default function InteractiveMarketChart({
  stockId,
  timeframe,
  points,
  averages,
}: {
  stockId: string;
  timeframe: DashboardChartTimeframe;
  points: RawPoint[];
  averages: RawPoint[];
}) {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const pointCountRef = useRef(0);
  const [hovered, setHovered] = useState<HoveredPoint | null>(null);
  const normalized = useMemo(
    () => normalizePoints(points, timeframe),
    [points, timeframe],
  );

  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container || normalized.length === 0) return;

    const chart = createChart(container, {
      autoSize: false,
      width: Math.max(1, container.clientWidth),
      height: Math.max(320, container.clientHeight),
      layout: {
        background: { type: ColorType.Solid, color: palette.background },
        textColor: palette.text,
        fontSize: 11,
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        attributionLogo: false,
        panes: {
          separatorColor: palette.grid,
          separatorHoverColor: palette.axis,
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      rightPriceScale: {
        borderColor: palette.axis,
        scaleMargins: { top: 0.06, bottom: 0.28 },
      },
      timeScale: {
        borderColor: palette.axis,
        timeVisible: timeframe === "today",
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => formatTickTime(time, timeframe),
        rightOffset: 3,
        barSpacing: timeframe === "today" ? 7 : 8,
        minBarSpacing: 2,
        fixRightEdge: false,
        rightBarStaysOnScroll: false,
        lockVisibleTimeRangeOnResize: true,
      },
      crosshair: {
        mode: CrosshairMode.MagnetOHLC,
        vertLine: {
          color: palette.crosshair,
          labelBackgroundColor: "#d8e5f1",
          style: 2,
        },
        horzLine: {
          color: palette.crosshair,
          labelBackgroundColor: "#d8e5f1",
          style: 2,
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
      localization: {
        locale: "zh-TW",
        dateFormat: "yyyy/MM/dd",
        timeFormatter: (time: Time) => formatTime(time, timeframe),
        priceFormatter: formatPrice,
      },
    });
    chartRef.current = chart;
    pointCountRef.current = normalized.length;

    const candles = normalized.map<CandlestickData<Time>>((point) => ({
      time: point.time,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
    }));
    const volumes = normalized.flatMap<HistogramData<Time>>((point) => (
      point.volume === null
        ? []
        : [{
            time: point.time,
            value: point.volume,
            color: point.close >= point.open ? "#ff4d6178" : "#16b8a678",
          }]
    ));
    const candleSeries = chart.addSeries(CandlestickSeries, {
      title: "K",
      upColor: palette.up,
      downColor: palette.down,
      borderUpColor: palette.up,
      borderDownColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    candleSeries.setData(candles);

    const volumeSeries = chart.addSeries(HistogramSeries, {
      title: "成交量",
      priceScaleId: "",
      priceFormat: { type: "volume" },
      color: "#486a86",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.setData(volumes);
    chart.priceScale("").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    const averageByTime = new Map(
      averages.map((point) => [String(point.time), point]),
    );
    const addAverage = (key: "ma5" | "ma20" | "ma60", color: string) => {
      const series = chart.addSeries(LineSeries, {
        title: key.toUpperCase(),
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const data = normalized.flatMap<LineData<Time>>((point) => {
        const value = finite(averageByTime.get(point.rawTime)?.[key]);
        return value === null ? [] : [{ time: point.time, value }];
      });
      series.setData(data);
    };
    addAverage("ma5", palette.ma5);
    addAverage("ma20", palette.ma20);
    addAverage("ma60", palette.ma60);

    chart.subscribeCrosshairMove((event) => {
      if (!event.time || !event.point) {
        setHovered(null);
        return;
      }
      const candle = event.seriesData.get(candleSeries) as CandlestickData<Time> | undefined;
      if (!candle || !("open" in candle)) {
        setHovered(null);
        return;
      }
      const volume = event.seriesData.get(volumeSeries) as HistogramData<Time> | undefined;
      setHovered({
        time: formatTime(event.time, timeframe),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: volume?.value ?? null,
      });
    });

    chart.timeScale().setVisibleLogicalRange(latestRange(normalized.length, timeframe));

    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width > 0 && height > 0) chart.applyOptions({ width, height });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      pointCountRef.current = 0;
    };
  }, [averages, normalized, timeframe]);

  const adjustRange = (kind: "left" | "right" | "zoom-in" | "zoom-out") => {
    const chart = chartRef.current;
    const range = chart?.timeScale().getVisibleLogicalRange();
    if (!chart || !range) return;
    const span = Math.max(8, range.to - range.from);
    if (kind === "left" || kind === "right") {
      const shift = span * 0.42 * (kind === "left" ? -1 : 1);
      chart.timeScale().setVisibleLogicalRange({
        from: (range.from + shift) as Logical,
        to: (range.to + shift) as Logical,
      });
      return;
    }
    const nextSpan = Math.max(8, Math.min(pointCountRef.current + 8, span * (kind === "zoom-in" ? 0.78 : 1.28)));
    const center = (range.from + range.to) / 2;
    chart.timeScale().setVisibleLogicalRange({
      from: (center - nextSpan / 2) as Logical,
      to: (center + nextSpan / 2) as Logical,
    });
  };

  const latest = () => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().setVisibleLogicalRange(latestRange(pointCountRef.current, timeframe));
  };

  const all = () => chartRef.current?.timeScale().fitContent();

  if (normalized.length === 0) {
    return <div className="interactive-chart-empty">本機尚無此週期可繪製的 OHLCV</div>;
  }

  return (
    <div className="interactive-chart-shell">
      <div className="interactive-chart-controls" aria-label="K 線瀏覽控制">
        <span>{timeframe === "today" ? `${normalized.length} 根 1m K · 拖曳瀏覽` : `${normalized.length} 根 K 線`}</span>
        <div>
          <button type="button" aria-label="向左瀏覽" onClick={() => adjustRange("left")}>‹</button>
          <button type="button" aria-label="向右瀏覽" onClick={() => adjustRange("right")}>›</button>
          <button type="button" aria-label="放大 K 線" onClick={() => adjustRange("zoom-in")}>＋</button>
          <button type="button" aria-label="縮小 K 線" onClick={() => adjustRange("zoom-out")}>－</button>
          <button type="button" onClick={latest}>最新</button>
          <button type="button" onClick={all}>全部</button>
        </div>
      </div>
      <div className="interactive-chart-readout" aria-live="polite">
        {hovered ? (
          <>
            <strong>{hovered.time}</strong>
            <span>開 {formatPrice(hovered.open)}</span>
            <span>高 {formatPrice(hovered.high)}</span>
            <span>低 {formatPrice(hovered.low)}</span>
            <span>收 {formatPrice(hovered.close)}</span>
            <span>量 {formatVolume(hovered.volume)}</span>
          </>
        ) : (
          <>
            <strong>{stockId}</strong>
            <span>移動十字線查看單根量價</span>
          </>
        )}
      </div>
      <div
        ref={chartContainerRef}
        className="interactive-market-chart"
        role="img"
        aria-label={`${stockId} ${timeframe} K 線、均線與成交量`}
      />
      <div className="interactive-chart-legend" aria-label="圖表圖例">
        <span className="ma5">MA5</span>
        <span className="ma20">MA20</span>
        <span className="ma60">MA60</span>
        <span className="volume">成交量</span>
      </div>
    </div>
  );
}
