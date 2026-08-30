import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { McpAppsBridge } from "./bridge";
import InteractiveMarketChart, {
  type DashboardChartTimeframe,
} from "./InteractiveMarketChart";
import {
  backoffDelay,
  buildDashboardRequest,
  buildWatchlistTree,
  dashboardWatchlistItemBatch,
  dashboardWatchlistGroupId,
  type DashboardScope,
  type DashboardSnapshot,
  isRecord,
  parseDashboard,
  shouldAdoptSnapshot,
  type UnknownRecord,
  type WatchlistGroupNode,
  type WatchlistItemBatch,
} from "./state";

const POLL_INTERVAL_MS = 30_000;
const DETAIL_TIMEFRAMES: Array<{
  key: DashboardChartTimeframe;
  label: string;
}> = [
  { key: "today", label: "今日" },
  { key: "daily", label: "日 K" },
  { key: "weekly", label: "週 K" },
  { key: "monthly", label: "月 K" },
];
const DETAIL_BARS: Record<DashboardChartTimeframe, number> = {
  today: 500,
  daily: 240,
  weekly: 156,
  monthly: 120,
};

function text(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value ? value : fallback;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatNumber(value: unknown, digits = 2): string {
  const parsed = number(value);
  return parsed === null
    ? "—"
    : new Intl.NumberFormat("zh-TW", { maximumFractionDigits: digits }).format(parsed);
}

function formatPct(value: unknown): string {
  const parsed = number(value);
  return parsed === null ? "—" : `${parsed >= 0 ? "+" : ""}${parsed.toFixed(2)}%`;
}

function formatCoverage(value: unknown): string {
  const parsed = number(value);
  return parsed === null ? "—" : `${parsed.toFixed(1)}%`;
}

function formatTime(value: unknown): string {
  if (typeof value !== "string") return "尚無時間";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-TW", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date);
}

function formatDetailPointTime(value: unknown, timeframe: DashboardChartTimeframe): string {
  if (typeof value !== "string" || !value) return "—";
  if (timeframe !== "today") return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
}

function tone(value: unknown): string {
  const parsed = number(value);
  return parsed === null ? "neutral" : parsed > 0 ? "up" : parsed < 0 ? "down" : "neutral";
}

function structuredContent(value: unknown): unknown {
  return isRecord(value) && "structuredContent" in value
    ? value.structuredContent
    : value;
}

function toolResultError(value: unknown): string | null {
  if (!isRecord(value) || value.isError !== true || !Array.isArray(value.content)) {
    return null;
  }
  for (const item of value.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text) {
      return item.text;
    }
  }
  return "個股資料工具回傳失敗";
}

function Status({ value }: { value: unknown }) {
  const label = text(value, "unknown");
  return <span className={`status status-${label.replace(/[^a-z_-]/gi, "")}`}>{label}</span>;
}

function PanelTitle({
  code,
  title,
  aside,
}: {
  code: string;
  title: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="panel-title">
      <div><span>{code}</span><h2>{title}</h2></div>
      {aside && <div className="panel-aside">{aside}</div>}
    </div>
  );
}

function BreadthCard({ market, value }: { market: string; value: UnknownRecord }) {
  const advance = number(value.advance) ?? 0;
  const unchanged = number(value.unchanged) ?? 0;
  const decline = number(value.decline) ?? 0;
  const observed = advance + unchanged + decline;
  const coverage = number(value.coverage) ?? 0;
  const universe = number(value.universe) ?? 0;
  const advanceWidth = observed ? (advance / observed) * 100 : 0;
  const unchangedWidth = observed ? (unchanged / observed) * 100 : 0;
  const declineWidth = observed ? (decline / observed) * 100 : 0;

  return (
    <article className="breadth-card">
      <div className="card-heading">
        <div><span className="market-code">{market}</span><strong>{market === "TWSE" ? "上市" : "上櫃"}</strong></div>
        <Status value={value.status} />
      </div>
      <div className="breadth-counts" aria-label={`${market} 漲跌家數`}>
        <div><span>上漲</span><strong className="up">{formatNumber(advance, 0)}</strong></div>
        <div><span>平盤</span><strong>{formatNumber(unchanged, 0)}</strong></div>
        <div><span>下跌</span><strong className="down">{formatNumber(decline, 0)}</strong></div>
      </div>
      <div className="breadth-track" aria-hidden="true">
        <i className="breadth-up" style={{ width: `${advanceWidth}%` }} />
        <i className="breadth-flat" style={{ width: `${unchangedWidth}%` }} />
        <i className="breadth-down" style={{ width: `${declineWidth}%` }} />
      </div>
      <div className="coverage-row">
        <span>覆蓋 {formatNumber(coverage, 0)} / {formatNumber(universe, 0)}</span>
        <span>unknown {formatNumber(value.unknown, 0)}</span>
      </div>
      <p className="micro">{text(value.price_semantics)}</p>
    </article>
  );
}

function IndexCard({ item }: { item: UnknownRecord }) {
  const observedWeight = (number(item.observed_weight) ?? 0) * 100;
  const uncoveredWeight = (number(item.uncovered_weight) ?? 0) * 100;
  return (
    <article className="index-card">
      <div className="card-heading">
        <span className="market-code">{text(item.index_id)}</span>
        <Status value={item.status} />
      </div>
      <div className="index-quote">
        <strong className={tone(item.change_pct)}>{formatNumber(item.estimate)}</strong>
        <span className={tone(item.change_pct)}>{formatNumber(item.change)} / {formatPct(item.change_pct)}</span>
      </div>
      <div className="index-coverage">
        <span>OBS {formatCoverage(observedWeight)}</span>
        <span>GAP {formatCoverage(uncoveredWeight)}</span>
      </div>
      <p className="flag">PROVISIONAL · NON-OFFICIAL</p>
    </article>
  );
}

function mobileIndexLabel(item: UnknownRecord): string {
  const indexId = text(item.index_id, "");
  if (indexId === "TAIEX") return "加權指數";
  if (indexId === "TPEX") return "櫃買指數";
  return indexId || text(item.market, "市場指數");
}

function MobileIndexSummary({ item }: { item: UnknownRecord }) {
  const observedWeight = (number(item.observed_weight) ?? 0) * 100;
  const uncoveredWeight = (number(item.uncovered_weight) ?? 0) * 100;
  return (
    <article className="mobile-index-summary">
      <div className="mobile-index-line">
        <span>{mobileIndexLabel(item)}</span>
        <strong>{formatNumber(item.estimate)}</strong>
        <em className={tone(item.change_pct)}>{formatNumber(item.change)} / {formatPct(item.change_pct)}</em>
      </div>
      <div className="mobile-index-meta">
        <span>狀態 <strong>{text(item.status)}</strong></span>
        <span>OBS <strong>{formatCoverage(observedWeight)}</strong></span>
        <span>GAP <strong>{formatCoverage(uncoveredWeight)}</strong></span>
      </div>
    </article>
  );
}

function MobileBreadthSummary({ market, value }: { market: string; value: UnknownRecord }) {
  const advance = number(value.advance) ?? 0;
  const unchanged = number(value.unchanged) ?? 0;
  const decline = number(value.decline) ?? 0;
  const observed = advance + unchanged + decline;
  const advanceWidth = observed ? (advance / observed) * 100 : 0;
  const unchangedWidth = observed ? (unchanged / observed) * 100 : 0;
  const declineWidth = observed ? (decline / observed) * 100 : 0;
  return (
    <div className="mobile-breadth-summary">
      <div className="mobile-breadth-head">
        <span>{market === "TWSE" ? "上市廣度" : market === "TPEX" ? "上櫃廣度" : `${market} 廣度`}</span>
        <span>{formatNumber(value.coverage, 0)}/{formatNumber(value.universe, 0)}</span>
      </div>
      <div className="mobile-breadth-values">
        <strong className="up">↑{formatNumber(advance, 0)}</strong>
        <strong className="neutral">─{formatNumber(unchanged, 0)}</strong>
        <strong className="down">↓{formatNumber(decline, 0)}</strong>
      </div>
      <div className="mobile-breadth-track" aria-hidden="true">
        <i className="breadth-up" style={{ width: `${advanceWidth}%` }} />
        <i className="breadth-flat" style={{ width: `${unchangedWidth}%` }} />
        <i className="breadth-down" style={{ width: `${declineWidth}%` }} />
      </div>
    </div>
  );
}

function MobileMarketOverview({ dashboard }: { dashboard: DashboardSnapshot }) {
  return (
    <section className="mobile-market-overview" aria-label="行動版市場概況">
      <div className="mobile-market-title">
        <strong>市場概況</strong>
        <span>{formatTime(dashboard.as_of)}</span>
      </div>
      <div className="mobile-index-grid">
        {dashboard.indices.slice(0, 2).map((item, index) => (
          <MobileIndexSummary key={`${text(item.index_id)}-${index}`} item={item} />
        ))}
      </div>
      <div className="mobile-breadth-grid">
        {Object.entries(dashboard.breadth).slice(0, 2).map(([market, value]) => (
          <MobileBreadthSummary key={market} market={market} value={value} />
        ))}
      </div>
    </section>
  );
}

function MobileWarningConsole({ warnings, pollError }: { warnings: string[]; pollError: string | null }) {
  const count = warnings.length + (pollError ? 1 : 0);
  if (count === 0) return null;
  return (
    <details className="mobile-warning-console">
      <summary><span>⚠ 資料限制 · {count}</span><span>展開</span></summary>
      <div>
        {pollError && <p>Dashboard 更新：{pollError}</p>}
        {warnings.slice(0, 6).map((warning) => <p key={warning}>{warning}</p>)}
      </div>
    </details>
  );
}

function FullscreenIndexSummary({ item }: { item: UnknownRecord }) {
  const observedWeight = (number(item.observed_weight) ?? 0) * 100;
  return (
    <article className="fullscreen-index-summary">
      <div>
        <span>{mobileIndexLabel(item)}</span>
        <small>{text(item.index_id)}</small>
      </div>
      <strong>{formatNumber(item.estimate)}</strong>
      <em className={tone(item.change_pct)}>{formatNumber(item.change)} / {formatPct(item.change_pct)}</em>
      <span className="fullscreen-index-coverage">OBS {formatCoverage(observedWeight)}</span>
    </article>
  );
}

function FullscreenBreadthSummary({ market, value }: { market: string; value: UnknownRecord }) {
  const advance = number(value.advance) ?? 0;
  const unchanged = number(value.unchanged) ?? 0;
  const decline = number(value.decline) ?? 0;
  const observed = advance + unchanged + decline;
  const advanceWidth = observed ? (advance / observed) * 100 : 0;
  const unchangedWidth = observed ? (unchanged / observed) * 100 : 0;
  const declineWidth = observed ? (decline / observed) * 100 : 0;
  return (
    <article className="fullscreen-breadth-summary">
      <div className="fullscreen-breadth-heading">
        <strong>{market === "TWSE" ? "上市廣度" : market === "TPEX" ? "上櫃廣度" : `${market} 廣度`}</strong>
        <span>{formatNumber(value.coverage, 0)} / {formatNumber(value.universe, 0)}</span>
      </div>
      <div className="fullscreen-breadth-counts">
        <span className="up">漲 {formatNumber(advance, 0)}</span>
        <span>平 {formatNumber(unchanged, 0)}</span>
        <span className="down">跌 {formatNumber(decline, 0)}</span>
      </div>
      <div className="fullscreen-breadth-track" aria-hidden="true">
        <i className="breadth-up" style={{ width: `${advanceWidth}%` }} />
        <i className="breadth-flat" style={{ width: `${unchangedWidth}%` }} />
        <i className="breadth-down" style={{ width: `${declineWidth}%` }} />
      </div>
    </article>
  );
}

function FullscreenMarketOverview({ dashboard }: { dashboard: DashboardSnapshot }) {
  return (
    <section className="fullscreen-market-overview" aria-label="台股市場概況">
      <div className="fullscreen-section-heading">
        <div><span>MARKET / TW</span><h2>市場概況</h2></div>
        <span>{formatTime(dashboard.as_of)}</span>
      </div>
      <div className="fullscreen-index-list">
        {dashboard.indices.slice(0, 2).map((item, index) => (
          <FullscreenIndexSummary key={`${text(item.index_id)}-${index}`} item={item} />
        ))}
      </div>
      <div className="fullscreen-breadth-list">
        {Object.entries(dashboard.breadth).slice(0, 2).map(([market, value]) => (
          <FullscreenBreadthSummary key={market} market={market} value={value} />
        ))}
      </div>
    </section>
  );
}

function FullscreenCalendarTile({ dashboard }: { dashboard: DashboardSnapshot }) {
  const session = dashboard.session;
  return (
    <section className="fullscreen-calendar" aria-label="市場行事曆狀態">
      <div className="fullscreen-section-heading">
        <div><span>CALENDAR</span><h2>行事曆</h2></div>
        <span className="fullscreen-pending-label">待接通</span>
      </div>
      <div className="fullscreen-calendar-date">
        <strong>{dashboard.trade_date}</strong>
        <span>{text(session.presentation_state)}</span>
      </div>
      <p>目前只顯示 backend 交易日與 session；台股／美股公司事件尚未加入這個 widget 的唯讀契約。</p>
    </section>
  );
}

function MarketChart({ detail }: { detail: UnknownRecord }) {
  const chart = isRecord(detail.chart) ? detail.chart : {};
  const points = list(chart.points).slice(-60);
  const averages = list(detail.moving_averages).slice(-60);
  if (points.length === 0) return <div className="chart-empty">本機尚無可繪製 K 線</div>;
  const values = points
    .flatMap((point) => [number(point.high), number(point.low)])
    .filter((value): value is number => value !== null);
  for (const item of averages) {
    for (const key of ["ma5", "ma20", "ma60"] as const) {
      const value = number(item[key]);
      if (value !== null) values.push(value);
    }
  }
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = maximum - minimum || 1;
  const width = 720;
  const height = 260;
  const x = (index: number) => 20 + (index * (width - 42)) / Math.max(points.length - 1, 1);
  const y = (value: number) => 14 + ((maximum - value) * (height - 42)) / spread;
  const line = (key: "ma5" | "ma20" | "ma60") => averages
    .map((item, index) => {
      const value = number(item[key]);
      return value === null ? null : `${x(index)},${y(value)}`;
    })
    .filter((value): value is string => value !== null)
    .join(" ");

  return (
    <svg className="market-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${text(detail.stock_id)} K 線與均線`}>
      {[0.2, 0.4, 0.6, 0.8].map((ratio) => <line key={`h-${ratio}`} className="grid-line" x1="12" x2={width - 12} y1={height * ratio} y2={height * ratio} />)}
      {[0.2, 0.4, 0.6, 0.8].map((ratio) => <line key={`v-${ratio}`} className="grid-line" x1={width * ratio} x2={width * ratio} y1="10" y2={height - 24} />)}
      {points.map((point, index) => {
        const open = number(point.open);
        const close = number(point.close);
        const high = number(point.high);
        const low = number(point.low);
        if (open === null || close === null || high === null || low === null) return null;
        const className = close >= open ? "candle-up" : "candle-down";
        const candleWidth = Math.max(2, Math.min(8, (width - 46) / points.length - 1));
        return <g key={`${text(point.time)}-${index}`} className={className}>
          <line x1={x(index)} x2={x(index)} y1={y(high)} y2={y(low)} />
          <rect x={x(index) - candleWidth / 2} y={Math.min(y(open), y(close))} width={candleWidth} height={Math.max(1, Math.abs(y(open) - y(close)))} />
        </g>;
      })}
      <polyline className="ma ma5" points={line("ma5")} />
      <polyline className="ma ma20" points={line("ma20")} />
      <polyline className="ma ma60" points={line("ma60")} />
      <g className="legend"><text x="18" y={height - 7}>MA5</text><text x="70" y={height - 7}>MA20</text><text x="132" y={height - 7}>MA60</text></g>
    </svg>
  );
}

function indexWatchlistGroups(
  tree: WatchlistGroupNode[],
): Map<number, WatchlistGroupNode> {
  const index = new Map<number, WatchlistGroupNode>();
  const visit = (nodes: WatchlistGroupNode[]) => {
    for (const node of nodes) {
      index.set(node.groupId, node);
      visit(node.children);
    }
  };
  visit(tree);
  return index;
}

function WatchlistTreeNodeView({
  node,
  depth,
  expandedIds,
  selectedGroupId,
  itemBatches,
  loadingGroupIds,
  itemErrors,
  selectedStockId,
  onToggle,
  onSelect,
  onSelectStock,
  onRetryItems,
}: {
  node: WatchlistGroupNode;
  depth: number;
  expandedIds: Set<number>;
  selectedGroupId: number | null;
  itemBatches: Map<number, WatchlistItemBatch>;
  loadingGroupIds: Set<number>;
  itemErrors: Map<number, string>;
  selectedStockId: string;
  onToggle: (groupId: number, expanding: boolean) => void;
  onSelect: (groupId: number) => void;
  onSelectStock: (stockId: string, stockName: string) => void;
  onRetryItems: (groupId: number) => void;
}) {
  const itemBatch = itemBatches.get(node.groupId);
  const itemsLoading = loadingGroupIds.has(node.groupId);
  const itemsError = itemErrors.get(node.groupId) ?? null;
  const hasGroupChildren = node.children.length > 0;
  const stockItems = itemBatch?.items ?? [];
  const canExpand = hasGroupChildren
    || itemBatch === undefined
    || stockItems.length > 0
    || itemsLoading
    || Boolean(itemsError)
    || expandedIds.has(node.groupId);
  const expanded = canExpand && expandedIds.has(node.groupId);
  const selected = node.groupId === selectedGroupId;
  const count = node.subtreeItemCount ?? node.directItemCount;

  return (
    <div
      className="watchlist-tree-node"
      role="treeitem"
      data-watchlist-group-id={node.groupId}
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={canExpand ? expanded : undefined}
    >
      <div
        className={`watchlist-tree-row${selected ? " is-selected" : ""}`}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
      >
        {canExpand ? (
          <button
            type="button"
            className="watchlist-tree-toggle"
            aria-label={`${expanded ? "收合" : "展開"}${node.groupName}`}
            onClick={() => onToggle(node.groupId, !expanded)}
          >
            {expanded ? "⌄" : "›"}
          </button>
        ) : <span className="watchlist-tree-spacer" aria-hidden="true">·</span>}
        <button
          type="button"
          className="watchlist-tree-select"
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelect(node.groupId)}
          title={node.groupName}
        >
          <span>{node.groupName}</span>
          {count !== null && <strong>{formatNumber(count, 0)}</strong>}
        </button>
      </div>
      {expanded && (
        <div role="group">
          {node.children.map((child) => (
            <WatchlistTreeNodeView
              key={child.groupId}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              selectedGroupId={selectedGroupId}
              itemBatches={itemBatches}
              loadingGroupIds={loadingGroupIds}
              itemErrors={itemErrors}
              selectedStockId={selectedStockId}
              onToggle={onToggle}
              onSelect={onSelect}
              onSelectStock={onSelectStock}
              onRetryItems={onRetryItems}
            />
          ))}
          {itemsLoading && (
            <div className="watchlist-tree-state" role="status" style={{ paddingLeft: `${44 + depth * 13}px` }}>
              讀取此層股票…
            </div>
          )}
          {!itemsLoading && itemsError && (
            <div className="watchlist-tree-state is-error" style={{ paddingLeft: `${44 + depth * 13}px` }}>
              <span>股票載入失敗</span>
              <button type="button" onClick={() => onRetryItems(node.groupId)}>重試</button>
            </div>
          )}
          {!itemsLoading && !itemsError && itemBatch && stockItems.map((item, index) => {
            const stockId = text(item.stock_id, "");
            const stockName = text(item.stock_name, "");
            if (!stockId) return null;
            return (
              <button
                type="button"
                role="treeitem"
                aria-level={depth + 2}
                aria-selected={selectedStockId === stockId}
                className={`watchlist-tree-stock ${tone(item.change_pct)}`}
                style={{ paddingLeft: `${44 + depth * 13}px` }}
                key={`${node.groupId}-${stockId}-${index}`}
                onClick={() => onSelectStock(stockId, stockName)}
                title={`${stockId} ${stockName}`.trim()}
              >
                <span><strong>{stockId}</strong><small>{stockName || "未命名標的"}</small></span>
                <em><b>{formatNumber(item.price)}</b><small>{formatPct(item.change_pct)}</small></em>
              </button>
            );
          })}
          {!itemsLoading && !itemsError && itemBatch && stockItems.length === 0 && (
            <div className="watchlist-tree-state" style={{ paddingLeft: `${44 + depth * 13}px` }}>
              {hasGroupChildren ? "此層沒有直接標的，請繼續展開下層群組" : "此群組目前沒有股票"}
            </div>
          )}
          {!itemsLoading && !itemsError && itemBatch?.truncated && (
            <div className="watchlist-tree-state is-limited" style={{ paddingLeft: `${44 + depth * 13}px` }}>
              僅顯示 backend 回傳的前 40 檔
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OrderShell({ stockId, stockName }: { stockId?: string; stockName?: string }) {
  return (
    <section className="order-shell" aria-label="委託草稿介面">
      <div className="order-shell-head">
        <div><span>EXECUTION / PREVIEW</span><h3>委託草稿</h3></div>
        <span className="connection-badge">尚未連線</span>
      </div>
      <div className="order-symbol-line">
        <div><strong>{stockId || "尚未選股"}</strong><span>{stockName || "請先從自選或搜尋選擇標的"}</span></div>
        <div className="order-side" aria-label="交易方向尚未啟用">
          <button type="button" disabled>買進</button>
          <button type="button" disabled>賣出</button>
        </div>
      </div>
      <div className="order-fields">
        <label>委託類型<select disabled defaultValue="limit"><option value="limit">限價</option></select></label>
        <label>價格<input disabled inputMode="decimal" placeholder="—" /></label>
        <label>數量<input disabled inputMode="numeric" placeholder="— 張" /></label>
        <label>風險條件<input disabled placeholder="尚未設定" /></label>
      </div>
      <div className="order-gate">
        <p><strong>介面預覽</strong> 尚未連接券商、模擬撮合或任何寫入工具；此區保留原始操作版位。</p>
        <button type="button" disabled>送出委託（未啟用）</button>
      </div>
    </section>
  );
}

export function App({ bridge }: { bridge: McpAppsBridge }) {
  const [presentationDiagnostic, setPresentationDiagnostic] = useState(
    () => bridge.getPresentationDiagnostic(),
  );
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const dashboardRef = useRef<DashboardSnapshot | null>(null);
  const [selectedWatchlistGroupId, setSelectedWatchlistGroupId] = useState<number | null>(null);
  const selectedWatchlistGroupIdRef = useRef<number | null>(null);
  const [expandedWatchlistGroupIds, setExpandedWatchlistGroupIds] = useState<Set<number>>(new Set());
  const watchlistTreeRef = useRef<HTMLDivElement | null>(null);
  const [watchlistTreeScrollState, setWatchlistTreeScrollState] = useState({
    canScroll: false,
    atTop: true,
    atBottom: true,
  });
  const watchlistTreeItemBatchesRef = useRef<Map<number, WatchlistItemBatch>>(new Map());
  const [watchlistTreeItemBatches, setWatchlistTreeItemBatches] = useState<Map<number, WatchlistItemBatch>>(new Map());
  const watchlistTreeItemControllers = useRef<Map<number, AbortController>>(new Map());
  const [watchlistTreeLoadingGroupIds, setWatchlistTreeLoadingGroupIds] = useState<Set<number>>(new Set());
  const [watchlistTreeItemErrors, setWatchlistTreeItemErrors] = useState<Map<number, string>>(new Map());
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const failureCount = useRef(0);
  const [keyword, setKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<UnknownRecord[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedStockId, setSelectedStockId] = useState("");
  const [selectedStockName, setSelectedStockName] = useState("");
  const [detail, setDetail] = useState<UnknownRecord | null>(null);
  const [detailTimeframe, setDetailTimeframe] = useState<DashboardChartTimeframe>("daily");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mobileOrderOpen, setMobileOrderOpen] = useState(false);
  const inFlight = useRef(false);
  const activeController = useRef<AbortController | null>(null);
  const activeDetailController = useRef<AbortController | null>(null);
  const detailRequestGeneration = useRef(0);

  const cacheWatchlistItemBatch = useCallback((batch: WatchlistItemBatch) => {
    const next = new Map(watchlistTreeItemBatchesRef.current);
    next.set(batch.groupId, batch);
    watchlistTreeItemBatchesRef.current = next;
    setWatchlistTreeItemBatches(next);
  }, []);

  const adopt = useCallback((value: unknown, requestedScope?: DashboardScope) => {
    const candidate = parseDashboard(structuredContent(value));
    if (!candidate) return false;
    const expectedScope = requestedScope ?? {
      watchlistGroupId: selectedWatchlistGroupIdRef.current,
    };
    if (!shouldAdoptSnapshot(dashboardRef.current, candidate, expectedScope)) return false;
    dashboardRef.current = candidate;
    setDashboard(candidate);
    const adoptedGroupId = dashboardWatchlistGroupId(candidate);
    if (adoptedGroupId !== null) {
      const batch = dashboardWatchlistItemBatch(candidate, adoptedGroupId);
      if (batch) cacheWatchlistItemBatch(batch);
    }
    if (selectedWatchlistGroupIdRef.current === null && adoptedGroupId !== null) {
      selectedWatchlistGroupIdRef.current = adoptedGroupId;
      setSelectedWatchlistGroupId(adoptedGroupId);
    }
    setPollError(null);
    setWatchlistLoading(false);
    failureCount.current = 0;
    return true;
  }, [cacheWatchlistItemBatch]);

  useEffect(() => {
    const unsubscribe = bridge.subscribe(adopt);
    const unsubscribePresentation = bridge.subscribePresentation(setPresentationDiagnostic);
    bridge.start();
    return () => {
      unsubscribe();
      unsubscribePresentation();
      activeController.current?.abort();
      activeDetailController.current?.abort();
      for (const controller of watchlistTreeItemControllers.current.values()) {
        controller.abort();
      }
      watchlistTreeItemControllers.current.clear();
      bridge.stop();
    };
  }, [adopt, bridge]);

  useEffect(() => {
    let timer = 0;
    let disposed = false;
    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      if (!disposed) timer = window.setTimeout(run, delay);
    };
    const run = async () => {
      if (disposed) return;
      if (document.hidden) {
        schedule(POLL_INTERVAL_MS);
        return;
      }
      if (inFlight.current) {
        const loadedGroupId = dashboardWatchlistGroupId(dashboardRef.current);
        const scopeStillPending = selectedWatchlistGroupId !== null
          && loadedGroupId !== selectedWatchlistGroupId;
        schedule(scopeStillPending ? 250 : POLL_INTERVAL_MS);
        return;
      }
      inFlight.current = true;
      const controller = new AbortController();
      activeController.current = controller;
      const requestedScope = {
        watchlistGroupId: selectedWatchlistGroupId,
      };
      try {
        const result = await bridge.callTool(
          "omi_read_tw_market_dashboard",
          buildDashboardRequest(requestedScope),
          controller.signal,
        );
        if (disposed || controller.signal.aborted) return;
        if (!adopt(result, requestedScope) && !dashboardRef.current) {
          throw new Error("Dashboard response contract mismatch");
        }
        schedule(POLL_INTERVAL_MS);
      } catch (error) {
        if (!controller.signal.aborted) {
          failureCount.current += 1;
          setPollError(error instanceof Error ? error.message : "更新失敗");
          if (requestedScope.watchlistGroupId === selectedWatchlistGroupIdRef.current) {
            setWatchlistLoading(false);
          }
          schedule(backoffDelay(failureCount.current, Math.random()));
        }
      } finally {
        inFlight.current = false;
        if (activeController.current === controller) activeController.current = null;
      }
    };
    const onVisibility = () => {
      if (!document.hidden) schedule(250);
    };
    document.addEventListener("visibilitychange", onVisibility);
    const currentGroupId = dashboardWatchlistGroupId(dashboardRef.current);
    const needsScopeRefresh = selectedWatchlistGroupId !== null
      && currentGroupId !== selectedWatchlistGroupId;
    schedule(needsScopeRefresh ? 120 : dashboard ? POLL_INTERVAL_MS : 500);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [adopt, bridge, dashboard, selectedWatchlistGroupId]);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const query = keyword.trim();
    if (!query) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = structuredContent(await bridge.callTool("omi_search_tw_symbols", { keyword: query, limit: 12 }));
      setSearchResults(isRecord(result) ? list(result.items) : []);
    } catch (error) {
      setSearchResults([]);
      setSearchError(error instanceof Error ? error.message : "搜尋失敗");
    } finally {
      setSearching(false);
    }
  };

  const readDetail = async (
    stockId: string,
    stockName = "",
    timeframe: DashboardChartTimeframe = detailTimeframe,
  ) => {
    const generation = detailRequestGeneration.current + 1;
    detailRequestGeneration.current = generation;
    activeDetailController.current?.abort();
    const controller = new AbortController();
    activeDetailController.current = controller;
    setSelectedStockId(stockId);
    setSelectedStockName(stockName);
    setDetailTimeframe(timeframe);
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await bridge.callTool(
        "omi_read_tw_stock_dashboard_detail",
        { stock_id: stockId, timeframe, bars: DETAIL_BARS[timeframe] },
        controller.signal,
      );
      if (generation !== detailRequestGeneration.current || controller.signal.aborted) return;
      const resultError = toolResultError(response);
      if (resultError) throw new Error(resultError);
      const result = structuredContent(response);
      if (
        !isRecord(result)
        || result.kind !== "omi.tw_stock_dashboard_detail"
        || result.version !== "omi.tw_stock_dashboard_detail.v2"
      ) throw new Error("個股資料格式不符或 backend 尚未採用 detail v2");
      setDetail(result);
      setSelectedStockName(text(result.stock_name, stockName));
      setSearchResults([]);
      window.openai?.setWidgetState?.({
        selectedStockId: stockId,
        selectedWatchlistGroupId: selectedWatchlistGroupIdRef.current,
      });
    } catch (error) {
      if (!controller.signal.aborted && generation === detailRequestGeneration.current) {
        setDetailError(error instanceof Error ? error.message : "個股讀取失敗");
      }
    } finally {
      if (generation === detailRequestGeneration.current) {
        setDetailLoading(false);
      }
      if (activeDetailController.current === controller) {
        activeDetailController.current = null;
      }
    }
  };

  const loadWatchlistGroupItems = useCallback(async (groupId: number, force = false) => {
    if (!force && watchlistTreeItemBatchesRef.current.has(groupId)) return;
    if (watchlistTreeItemControllers.current.has(groupId)) return;

    const controller = new AbortController();
    watchlistTreeItemControllers.current.set(groupId, controller);
    setWatchlistTreeLoadingGroupIds((previous) => {
      const next = new Set(previous);
      next.add(groupId);
      return next;
    });
    setWatchlistTreeItemErrors((previous) => {
      if (!previous.has(groupId)) return previous;
      const next = new Map(previous);
      next.delete(groupId);
      return next;
    });

    try {
      const result = await bridge.callTool(
        "omi_read_tw_market_dashboard",
        buildDashboardRequest({ watchlistGroupId: groupId }),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const candidate = parseDashboard(structuredContent(result));
      const batch = dashboardWatchlistItemBatch(candidate, groupId);
      if (!batch) throw new Error("群組股票回傳範圍不符");
      cacheWatchlistItemBatch(batch);
    } catch (error) {
      if (!controller.signal.aborted) {
        setWatchlistTreeItemErrors((previous) => {
          const next = new Map(previous);
          next.set(groupId, error instanceof Error ? error.message : "股票載入失敗");
          return next;
        });
      }
    } finally {
      if (watchlistTreeItemControllers.current.get(groupId) === controller) {
        watchlistTreeItemControllers.current.delete(groupId);
      }
      setWatchlistTreeLoadingGroupIds((previous) => {
        if (!previous.has(groupId)) return previous;
        const next = new Set(previous);
        next.delete(groupId);
        return next;
      });
    }
  }, [bridge, cacheWatchlistItemBatch]);

  const updateWatchlistTreeScrollState = useCallback(() => {
    const tree = watchlistTreeRef.current;
    if (!tree) return;
    const maxScrollTop = Math.max(0, tree.scrollHeight - tree.clientHeight);
    const next = {
      canScroll: maxScrollTop > 2,
      atTop: tree.scrollTop <= 2,
      atBottom: tree.scrollTop >= maxScrollTop - 2,
    };
    setWatchlistTreeScrollState((previous) => (
      previous.canScroll === next.canScroll
      && previous.atTop === next.atTop
      && previous.atBottom === next.atBottom
        ? previous
        : next
    ));
  }, []);

  const scrollWatchlistTree = useCallback((direction: -1 | 1) => {
    const tree = watchlistTreeRef.current;
    if (!tree) return;
    const distance = Math.max(140, Math.floor(tree.clientHeight * .78));
    const maxScrollTop = Math.max(0, tree.scrollHeight - tree.clientHeight);
    tree.scrollTop = Math.max(0, Math.min(maxScrollTop, tree.scrollTop + direction * distance));
    updateWatchlistTreeScrollState();
  }, [updateWatchlistTreeScrollState]);

  const selectWatchlistGroup = (groupId: number) => {
    void loadWatchlistGroupItems(groupId);
    if (groupId === selectedWatchlistGroupIdRef.current) return;
    selectedWatchlistGroupIdRef.current = groupId;
    setSelectedWatchlistGroupId(groupId);
    setWatchlistLoading(true);
    setPollError(null);
    activeController.current?.abort();
    window.openai?.setWidgetState?.({
      selectedStockId: selectedStockId || undefined,
      selectedWatchlistGroupId: groupId,
    });
  };

  const toggleWatchlistGroup = (groupId: number, expanding: boolean) => {
    setExpandedWatchlistGroupIds((previous) => {
      const next = new Set(previous);
      if (expanding) {
        next.add(groupId);
      } else next.delete(groupId);
      return next;
    });
    if (expanding) void loadWatchlistGroupItems(groupId);
  };

  const session = dashboard?.session ?? {};
  const freshness = dashboard?.freshness ?? {};
  const watchlist = isRecord(dashboard?.watchlist) ? dashboard.watchlist : {};
  const watchlistGroups = useMemo(() => list(watchlist.groups), [watchlist.groups]);
  const watchlistTree = useMemo(
    () => buildWatchlistTree(watchlistGroups),
    [watchlistGroups],
  );
  const watchlistGroupIndex = useMemo(
    () => indexWatchlistGroups(watchlistTree),
    [watchlistTree],
  );
  const watchlistSelection = isRecord(watchlist.selection) ? watchlist.selection : {};
  const loadedWatchlistGroupId = number(watchlistSelection.group_id);
  const watchlistScopeMatches = selectedWatchlistGroupId === null
    || loadedWatchlistGroupId === selectedWatchlistGroupId;
  const watchlistItems = watchlistScopeMatches ? list(watchlist.items) : [];
  const selectedWatchlistGroup = selectedWatchlistGroupId === null
    ? null
    : watchlistGroupIndex.get(selectedWatchlistGroupId) ?? null;
  const selectedTechnical = isRecord(detail?.technical) ? detail.technical : {};
  const technicalRows = list(selectedTechnical.rows);
  const detailChart = isRecord(detail?.chart) ? detail.chart : {};
  const detailIntradayChart = isRecord(detail?.intraday_chart) ? detail.intraday_chart : {};
  const activeDetailChart = detailTimeframe === "today" ? detailIntradayChart : detailChart;
  const detailPoints = useMemo(() => list(activeDetailChart.points), [activeDetailChart]);
  const detailAverages = useMemo(() => list(detail?.moving_averages), [detail]);
  const latestPoint = detailPoints.at(-1) ?? {};
  const warnings = useMemo(() => Array.from(new Set([
    ...(dashboard?.warnings ?? []),
    ...(dashboard?.limitations ?? []),
  ])), [dashboard]);
  const detailWarnings = detail
    ? Array.from(new Set([...strings(detail.warnings), ...strings(detail.limitations)]))
    : [];
  const isMobileLayout = presentationDiagnostic.viewportWidth <= 820;
  const isFullscreenLayout = presentationDiagnostic.actualDisplayMode === "fullscreen";

  useEffect(() => {
    const update = () => {
      updateWatchlistTreeScrollState();
    };
    const frame = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
    };
  }, [
    expandedWatchlistGroupIds,
    updateWatchlistTreeScrollState,
    watchlistTree,
  ]);

  if (!dashboard) {
    return (
      <main className={`dashboard-shell loading-shell${isMobileLayout ? " is-mobile-layout" : ""}${isFullscreenLayout ? " fullscreen-workspace fullscreen-loading" : ""}`}>
        <div className="loading-terminal"><span>OMI / TW</span><i /></div>
        <h1>市場情報工作台</h1>
        <p>等待 backend-owned dashboard snapshot…</p>
        {pollError && <p className="error-text">{pollError}</p>}
      </main>
    );
  }

  if (isFullscreenLayout) {
    return (
      <main className="fullscreen-workspace" data-display-mode="fullscreen">
        <aside className="fullscreen-sidebar" aria-label="OMI 市場與自選導覽">
          <header className="fullscreen-sidebar-brand">
            <span>OPEN MARKET INTELLIGENCE</span>
            <h1>Market Dashboard</h1>
            <nav className="fullscreen-market-tabs" aria-label="市場選擇">
              <button type="button" aria-current="page">台股</button>
              <button type="button" disabled title="美股 dashboard contract 尚未接通">美股</button>
            </nav>
          </header>

          <section className="fullscreen-sidebar-selection">
            <div><span>自選股</span><strong>{selectedWatchlistGroup?.groupName ?? "我的自選"}</strong></div>
            <small>唯讀 · {watchlistGroupIndex.size} 群組</small>
          </section>

          <form onSubmit={search} className="fullscreen-sidebar-search" role="search">
            <input
              aria-label="搜尋台股代碼或名稱"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              maxLength={80}
              autoComplete="off"
              placeholder="股票代碼或名稱，例如 2330"
            />
            <button type="submit" disabled={searching}>{searching ? "搜尋中" : "搜尋"}</button>
          </form>

          {(searchError || searchResults.length > 0) && (
            <section className="fullscreen-search-results" aria-label="搜尋結果">
              {searchError && <p role="alert">搜尋失敗：{searchError}</p>}
              {searchResults.map((item) => (
                <button
                  type="button"
                  key={text(item.stock_id)}
                  onClick={() => void readDetail(text(item.stock_id), text(item.stock_name, ""))}
                >
                  <strong>{text(item.stock_id)} {text(item.stock_name)}</strong>
                  <span>{text(item.market)}</span>
                </button>
              ))}
            </section>
          )}

          <div className="fullscreen-watchlist-frame">
            <div
              ref={watchlistTreeRef}
              className="watchlist-tree fullscreen-watchlist-tree"
              role="tree"
              tabIndex={0}
              aria-label="我的自選群組"
              aria-busy={watchlistLoading}
              aria-describedby={watchlistTreeScrollState.canScroll ? "fullscreen-watchlist-scroll-status" : undefined}
              onScroll={updateWatchlistTreeScrollState}
            >
              {watchlistTree.length > 0 ? watchlistTree.map((node) => (
                <WatchlistTreeNodeView
                  key={node.groupId}
                  node={node}
                  depth={0}
                  expandedIds={expandedWatchlistGroupIds}
                  selectedGroupId={selectedWatchlistGroupId}
                  itemBatches={watchlistTreeItemBatches}
                  loadingGroupIds={watchlistTreeLoadingGroupIds}
                  itemErrors={watchlistTreeItemErrors}
                  selectedStockId={selectedStockId}
                  onToggle={toggleWatchlistGroup}
                  onSelect={selectWatchlistGroup}
                  onSelectStock={(stockId, stockName) => void readDetail(stockId, stockName)}
                  onRetryItems={(groupId) => void loadWatchlistGroupItems(groupId, true)}
                />
              )) : <p className="empty-row">Backend 尚未提供可用的自選群組</p>}
            </div>
            {watchlistTreeScrollState.canScroll && (
              <div className="watchlist-tree-nav fullscreen-watchlist-nav" aria-label="自選群組分段瀏覽">
                <span id="fullscreen-watchlist-scroll-status" aria-live="polite">
                  {watchlistTreeScrollState.atBottom
                    ? "已到最下方"
                    : watchlistTreeScrollState.atTop
                      ? "下方仍有群組"
                      : "上下皆可瀏覽"}
                </span>
                <div>
                  <button type="button" disabled={watchlistTreeScrollState.atTop} onClick={() => scrollWatchlistTree(-1)}>上一段</button>
                  <button type="button" disabled={watchlistTreeScrollState.atBottom} onClick={() => scrollWatchlistTree(1)}>下一段</button>
                </div>
              </div>
            )}
          </div>

          <FullscreenCalendarTile dashboard={dashboard} />

          <section className="fullscreen-update-state" aria-label="更新狀態">
            <div><strong>更新狀態</strong><Status value={freshness.status} /></div>
            <span>{text(session.presentation_state)} · {formatTime(dashboard.as_of)}</span>
          </section>
        </aside>

        <section className="fullscreen-content">
          <FullscreenMarketOverview dashboard={dashboard} />

          {(warnings.length > 0 || pollError) && (
            <details className="fullscreen-limitations">
              <summary><span>資料限制</span><strong>{warnings.length + (pollError ? 1 : 0)}</strong></summary>
              <div>
                {pollError && <p>Dashboard 更新：{pollError}</p>}
                {warnings.slice(0, 8).map((warning) => <p key={warning}>{warning}</p>)}
              </div>
            </details>
          )}

          <section className="fullscreen-research-layout">
            <section className="fullscreen-instrument-panel" aria-label="個股研究">
              <div className="fullscreen-panel-heading fullscreen-stock-panel-heading">
                <div><span>股票</span><h2>{selectedStockId ? `${selectedStockId} ${selectedStockName}` : "個股研究"}</h2></div>
                {detail ? (
                  <div className="fullscreen-stock-heading-quote">
                    <strong>{formatNumber(latestPoint.close)}</strong>
                    <Status value={activeDetailChart.freshness_status ?? activeDetailChart.cache_status} />
                  </div>
                ) : <span>TWSE · 今日／日／週／月 K</span>}
              </div>

              {detailLoading && (
                <div className="fullscreen-instrument-state" aria-live="polite">
                  <span>READING</span><strong>讀取 {selectedStockId} 的本機 evidence…</strong>
                </div>
              )}
              {!detail && !detailLoading && detailError && (
                <div className="fullscreen-instrument-state is-error" role="alert">
                  <span>{selectedStockId}</span><strong>個股資料讀取失敗</strong><p>{detailError}</p>
                  <button type="button" onClick={() => void readDetail(selectedStockId, selectedStockName)}>重新讀取</button>
                </div>
              )}
              {!detail && !detailLoading && !detailError && (
                <div className="fullscreen-instrument-state fullscreen-empty-chart">
                  <span>{selectedStockId ? `已選取 ${selectedStockId}` : "尚未選擇標的"}</span>
                  <strong>{selectedStockId ? selectedStockName || "等待個股資料" : "從左側自選股選擇標的"}</strong>
                  <p>選取股票後顯示 backend 回傳的 Quote、Daily OHLC 與 technical evidence。</p>
                </div>
              )}
              {detail && (
                <div className="fullscreen-detail-panel">
                  <div className="fullscreen-quote-grid">
                    <div>
                      <span>{detailTimeframe === "today" ? "時間" : "日期"}</span>
                      <strong>{formatDetailPointTime(latestPoint.time, detailTimeframe)}</strong>
                    </div>
                    <div><span>開</span><strong>{formatNumber(latestPoint.open)}</strong></div>
                    <div><span>高</span><strong>{formatNumber(latestPoint.high)}</strong></div>
                    <div><span>低</span><strong>{formatNumber(latestPoint.low)}</strong></div>
                    <div><span>收</span><strong>{formatNumber(latestPoint.close)}</strong></div>
                    <div><span>量</span><strong>{formatNumber(latestPoint.volume, 0)}</strong></div>
                  </div>

                  <div className="fullscreen-chart-heading fullscreen-kline-toolbar">
                    <div role="tablist" aria-label="K 線週期">
                      {DETAIL_TIMEFRAMES.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          role="tab"
                          aria-selected={detailTimeframe === item.key}
                          className={detailTimeframe === item.key ? "active" : ""}
                          disabled={detailLoading}
                          onClick={() => {
                            if (detailTimeframe === item.key) return;
                            void readDetail(selectedStockId, selectedStockName, item.key);
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <small>
                      {detailTimeframe === "today"
                        ? `${text(detailIntradayChart.source, "INTRADAY CACHE")} · ${text(detailIntradayChart.interval, "1m")}`
                        : "BACKEND OHLC"}
                      {" · CACHE ONLY"}
                    </small>
                  </div>
                  <div className="fullscreen-chart-stage fullscreen-interactive-chart-stage">
                    <InteractiveMarketChart
                      key={`${selectedStockId}:${detailTimeframe}`}
                      stockId={selectedStockId}
                      timeframe={detailTimeframe}
                      points={detailPoints}
                      averages={detailAverages}
                    />
                  </div>
                </div>
              )}
            </section>

            <aside className="fullscreen-insight-panel" aria-label="技術研究資訊">
              <div className="fullscreen-panel-heading">
                <div><span>TECHNICAL</span><h2>技術研究</h2></div>
                <span>{detail ? `${Math.min(technicalRows.length, 6)} 項` : "等待選股"}</span>
              </div>

              {detail ? (
                <>
                  <section className="fullscreen-technical-summary">
                    <span>目前結構</span>
                    <strong>{text(selectedTechnical.title)}</strong>
                    <p>{text(selectedTechnical.summary)}</p>
                  </section>
                  <div className="fullscreen-technical-rows">
                    {technicalRows.slice(0, 6).map((row, index) => (
                      <details className="fullscreen-evidence-row" key={text(row.key)} open={index === 0}>
                        <summary><span>{text(row.label)}</span><strong>{text(row.display_value)}</strong></summary>
                        <p>{text(row.description)}</p>
                      </details>
                    ))}
                  </div>
                  {detailWarnings.length > 0 && (
                    <details className="fullscreen-detail-limits">
                      <summary>個股資料限制 · {detailWarnings.length}</summary>
                      <div>{detailWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
                    </details>
                  )}
                </>
              ) : (
                <div className="fullscreen-insight-empty">
                  <strong>尚未選擇標的</strong>
                  <p>這裡會顯示 backend technical evidence、風險條件與資料限制。</p>
                </div>
              )}

              <section className="fullscreen-broker-reserve" aria-label="手動委託預留區">
                <div><span>MANUAL ORDER</span><strong>手動委託預留</strong></div>
                <p>券商 API、帳戶驗證與確認流程尚未接通；目前沒有任何下單或寫入控制。</p>
                <small>{selectedStockId || "尚未選股"}</small>
              </section>
            </aside>
          </section>

          <footer className="fullscreen-footer">
            <span><i className={pollError ? "signal-bad" : "signal-ok"} /> 30 秒更新 · {pollError ? "DEGRADED" : "READY"}</span>
            <span>SNAPSHOT {dashboard.snapshot_id}</span>
            <span>研究用途 · 唯讀 · 不含自動交易</span>
          </footer>
        </section>
      </main>
    );
  }

  return (
    <main
      className={`dashboard-shell${isMobileLayout ? " is-mobile-layout" : ""}`}
      data-display-mode={presentationDiagnostic.actualDisplayMode}
    >
      <header className="terminal-header">
        <div className="brand-lockup">
          <span className="brand-mark">OMI</span>
          <div><strong>台股研究工作台</strong><span>TAIWAN MARKET INTELLIGENCE</span></div>
        </div>
        <div className="system-status">
          <span className="system-chip chip-local">LOCAL</span>
          <span className="system-chip chip-ok">MCP</span>
          <Status value={freshness.status} />
        </div>
        <div className="header-stamp"><strong>{formatTime(dashboard.as_of)}</strong><span>交易日 {dashboard.trade_date}</span></div>
      </header>

      <form onSubmit={search} className="command-bar" role="search">
        <span className="command-prefix">TW</span>
        <label htmlFor="symbol-search">搜尋台股代碼或名稱</label>
        <input id="symbol-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} maxLength={80} autoComplete="off" placeholder="2330 / 台積電" />
        <button type="submit" disabled={searching}>{searching ? "搜尋中…" : "搜尋"}</button>
      </form>

      {searchError && <p className="search-error" role="alert">搜尋失敗：{searchError}</p>}
      {searchResults.length > 0 && (
        <div className="search-results" aria-label="搜尋結果">
          {searchResults.map((item) => (
            <button type="button" key={text(item.stock_id)} onClick={() => void readDetail(text(item.stock_id), text(item.stock_name, ""))}>
              <strong>{text(item.stock_id)}</strong><span>{text(item.stock_name)} / {text(item.market)}</span>
            </button>
          ))}
        </div>
      )}

      <MobileMarketOverview dashboard={dashboard} />

      <section className="mobile-truth-strip" aria-label="行動版資料狀態">
        <strong>{text(session.presentation_state)}</strong>
        <span>CACHE ONLY</span>
        <span>SNAPSHOT {formatTime(dashboard.as_of)}</span>
        <span>V{dashboard.state_version}</span>
      </section>

      <section className="truth-strip desktop-truth-strip" aria-label="資料狀態">
        <div><span>市場階段</span><strong>{text(session.presentation_state)}</strong></div>
        <div><span>SESSION</span><strong>{text(session.phase)}</strong></div>
        <div><span>資料路徑</span><strong>CACHE ONLY</strong></div>
        <div><span>狀態版本</span><strong>V{dashboard.state_version}</strong></div>
      </section>

      <MobileWarningConsole warnings={warnings} pollError={pollError} />

      {(warnings.length > 0 || pollError) && (
        <section className="warning-console desktop-warning-console" aria-live="polite">
          <div><span>!</span><strong>資料限制</strong></div>
          <div>
            {pollError && <p className="poll-error">Dashboard 更新：{pollError}</p>}
            {warnings.slice(0, 6).map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        </section>
      )}

      <section className="terminal-panel index-panel desktop-market-section">
        <PanelTitle code="01 / MARKET" title="指數估算" aside={<span>盤前投影 · 非官方</span>} />
        <div className="index-grid">{dashboard.indices.map((item, index) => <IndexCard key={`${text(item.index_id)}-${index}`} item={item} />)}</div>
      </section>

      <section className="terminal-panel desktop-market-section">
        <PanelTitle code="02 / BREADTH" title="市場廣度" aside={<span>紅漲 · 綠跌</span>} />
        <div className="breadth-grid">
          {Object.entries(dashboard.breadth).map(([market, value]) => <BreadthCard key={market} market={market} value={value} />)}
        </div>
      </section>

      <section className="workbench">
        <aside className="terminal-panel market-sidebar">
          <div className="radar-section">
            <PanelTitle code="03 / RADAR" title="市場雷達" aside={<Status value={watchlist.status} />} />

            <div className="subsection-label"><span>熱門族群</span><span>中位數 / 覆蓋</span></div>
            <div className="hot-group-list">
              {dashboard.hot_groups.length > 0 ? dashboard.hot_groups.map((group) => (
                <div className="group-row" key={text(group.group_id)}>
                  <div><strong>{text(group.label)}</strong><span>{text(group.market)} · {formatNumber(group.coverage, 0)}/{formatNumber(group.universe, 0)}</span></div>
                  <div className={tone(group.median_change_pct)}><strong>{formatPct(group.median_change_pct)}</strong><span>中位數</span></div>
                </div>
              )) : <p className="empty-row">尚無族群排行</p>}
            </div>
          </div>

          <div className="subsection-label watchlist-label tree-label"><span>我的自選</span><span>唯讀 · {watchlistGroupIndex.size} 群組</span></div>
          <div className="watchlist-tree-frame">
            <div
              ref={watchlistTreeRef}
              className="watchlist-tree"
              role="tree"
              tabIndex={0}
              aria-label="我的自選群組"
              aria-busy={watchlistLoading}
              aria-describedby={watchlistTreeScrollState.canScroll ? "watchlist-tree-scroll-status" : undefined}
              onScroll={updateWatchlistTreeScrollState}
            >
              {watchlistTree.length > 0 ? watchlistTree.map((node) => (
                <WatchlistTreeNodeView
                  key={node.groupId}
                  node={node}
                  depth={0}
                  expandedIds={expandedWatchlistGroupIds}
                  selectedGroupId={selectedWatchlistGroupId}
                  itemBatches={watchlistTreeItemBatches}
                  loadingGroupIds={watchlistTreeLoadingGroupIds}
                  itemErrors={watchlistTreeItemErrors}
                  selectedStockId={selectedStockId}
                  onToggle={toggleWatchlistGroup}
                  onSelect={selectWatchlistGroup}
                  onSelectStock={(stockId, stockName) => void readDetail(stockId, stockName)}
                  onRetryItems={(groupId) => void loadWatchlistGroupItems(groupId, true)}
                />
              )) : <p className="empty-row">Backend 尚未提供可用的自選群組</p>}
            </div>
            {watchlistTreeScrollState.canScroll && (
              <div className="watchlist-tree-nav" aria-label="自選群組分段瀏覽">
                <span id="watchlist-tree-scroll-status" aria-live="polite">
                  {watchlistTreeScrollState.atBottom
                    ? "已到最下方"
                    : watchlistTreeScrollState.atTop
                      ? "下方仍有群組"
                      : "上下皆可瀏覽"}
                </span>
                <div>
                  <button
                    type="button"
                    disabled={watchlistTreeScrollState.atTop}
                    aria-label="向上瀏覽自選群組"
                    onClick={() => scrollWatchlistTree(-1)}
                  >↑ 上一段</button>
                  <button
                    type="button"
                    disabled={watchlistTreeScrollState.atBottom}
                    aria-label="向下瀏覽更多自選群組"
                    onClick={() => scrollWatchlistTree(1)}
                  >下一段 ↓</button>
                </div>
              </div>
            )}
          </div>

          <div className="direct-watchlist-section">
            <div className="subsection-label watchlist-label">
              <span>{selectedWatchlistGroup?.groupName ?? text(watchlistSelection.group_name, "自選標的")}</span>
              <span>直接標的 / 價格</span>
            </div>
            <div className="watchlist" role="list" aria-busy={watchlistLoading}>
              {!watchlistScopeMatches ? (
                <p className="empty-row">
                  {watchlistLoading ? `讀取 ${selectedWatchlistGroup?.groupName ?? "所選群組"} 的直接標的…` : "尚未取得所選群組資料，等待重新整理。"}
                </p>
              ) : watchlistItems.length > 0 ? watchlistItems.map((item) => {
                const stockId = text(item.stock_id);
                const stockName = text(item.stock_name, "");
                return (
                  <button type="button" role="listitem" aria-pressed={selectedStockId === stockId} key={stockId} onClick={() => void readDetail(stockId, stockName)}>
                    <div><strong>{stockId}</strong><span>{stockName || "未命名標的"}</span></div>
                    <div className={tone(item.change_pct)}><strong>{formatNumber(item.price)}</strong><span>{formatPct(item.change_pct)}</span></div>
                  </button>
                );
              }) : <p className="empty-row">
                {selectedWatchlistGroup?.children.length
                  ? "此群組沒有直接標的；請展開並選擇子群組。"
                  : "自選群組目前沒有可顯示標的"}
              </p>
              }
            </div>
          </div>
        </aside>

        <div className="instrument-column">
          <section className="terminal-panel instrument-panel">
            <div className="desktop-instrument-title">
              <PanelTitle code="04 / RESEARCH" title="個股工作台" aside={<span>BACKEND K 線 · MA5/20/60</span>} />
            </div>
            {detailLoading && <div className="detail-loading" aria-live="polite"><i />讀取 {selectedStockId} 的本機 evidence…</div>}
            {!detail && !detailLoading && detailError && (
              <div className="instrument-error" role="alert">
                <span>已選取 {selectedStockId}</span>
                <strong>個股資料讀取失敗</strong>
                <p>{detailError}</p>
                <button type="button" onClick={() => void readDetail(selectedStockId, selectedStockName)}>重新讀取</button>
              </div>
            )}
            {!detail && !detailLoading && !detailError && (
              <div className="instrument-empty">
                <span>{selectedStockId ? `已選取 ${selectedStockId}` : "尚未選擇標的"}</span>
                <strong>{selectedStockId ? selectedStockName || "等待個股資料" : "從左側自選股或上方搜尋選擇標的"}</strong>
                <p>Quote / Daily OHLC / backend technical evidence 會顯示在這裡。</p>
              </div>
            )}
            {detail && (
              <div className="detail-panel">
                <div className="detail-heading">
                  <div><span>{text(detail.market)} / {text(detail.timeframe).toUpperCase()}</span><h3>{text(detail.stock_name, "未命名標的")} <small>{text(detail.stock_id)}</small></h3></div>
                  <div className="detail-price"><strong>{formatNumber(latestPoint.close)}</strong><Status value={detailChart.freshness_status} /></div>
                </div>

                <div className="quote-grid">
                  <div><span>開</span><strong>{formatNumber(latestPoint.open)}</strong></div>
                  <div><span>高</span><strong>{formatNumber(latestPoint.high)}</strong></div>
                  <div><span>低</span><strong>{formatNumber(latestPoint.low)}</strong></div>
                  <div><span>收</span><strong>{formatNumber(latestPoint.close)}</strong></div>
                  <div><span>量</span><strong>{formatNumber(latestPoint.volume, 0)}</strong></div>
                  <div><span>BARS</span><strong>{formatNumber(detail.bars, 0)}</strong></div>
                </div>

                <div className="chart-toolbar"><span className="active">日 K</span><span>MA5</span><span>MA20</span><span>MA60</span><i /> <small>CACHE ONLY</small></div>
                <div className="chart-stage"><MarketChart detail={detail} /></div>

                <div className="technical-summary"><span>OMI TECHNICAL EVIDENCE</span><strong>{text(selectedTechnical.title)}</strong><p>{text(selectedTechnical.summary)}</p></div>
                <div className="technical-rows">
                  {technicalRows.slice(0, 6).map((row) => <div key={text(row.key)}><span>{text(row.label)}</span><strong>{text(row.display_value)}</strong><p>{text(row.description)}</p></div>)}
                </div>
                {[...strings(detail.warnings), ...strings(detail.limitations)].length > 0 && (
                  <div className="detail-warnings">{Array.from(new Set([...strings(detail.warnings), ...strings(detail.limitations)])).map((warning) => <span key={warning}>{warning}</span>)}</div>
                )}
                {detailWarnings.length > 0 && (
                  <details className="mobile-detail-limits">
                    <summary>資料限制 · {detailWarnings.length}</summary>
                    <div>{detailWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
                  </details>
                )}
              </div>
            )}
          </section>

          <div className="desktop-order-shell">
            <OrderShell stockId={selectedStockId || undefined} stockName={selectedStockName || undefined} />
          </div>
        </div>
      </section>

      <div className="mobile-primary-actions" aria-label="行動版主要操作">
        <button type="button" className="mobile-fullscreen-action" onClick={() => void bridge.requestFullscreen("manual")}>⛶ 全螢幕</button>
        <button
          type="button"
          className="mobile-order-action"
          aria-expanded={mobileOrderOpen}
          onClick={() => setMobileOrderOpen((open) => !open)}
        >下單介面</button>
      </div>

      {mobileOrderOpen && (
        <div className="mobile-order-panel">
          <OrderShell stockId={selectedStockId || undefined} stockName={selectedStockName || undefined} />
        </div>
      )}

      <footer className="terminal-footer">
        <span><i className={pollError ? "signal-bad" : "signal-ok"} /> 30 秒更新 · {pollError ? "DEGRADED" : "READY"}</span>
        <span>SNAPSHOT {dashboard.snapshot_id}</span>
        <span>研究用途 · 盤前估算非官方 · 不可作為自動交易依據</span>
      </footer>
    </main>
  );
}
