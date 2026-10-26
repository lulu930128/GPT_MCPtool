import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { McpAppsBridge } from "./bridge";
import InteractiveMarketChart, { type DashboardChartTimeframe } from "./InteractiveMarketChart";
import { isRecord, type UnknownRecord } from "./state";
import { initialSelection, PaneLoader, readToolData, type PaneState } from "./workspace-state";
import { StatusBadge, WorkspaceStatusPanel, criticalStatuses } from "./workspace-evidence";
import { TechnicalSummary, technicalSummary, technicalPresentation } from "./workspace-technical";
import { GroupNavigation } from "./workspace-navigation";
import { holdingsArgs, parseHoldings, readHoldingsEnvelope } from "./workspace-holdings";
import { WorkspaceContext } from "./WorkspaceContext";
import { MarketCards, changeTone } from "./workspace-market";

const records = (value: unknown): UnknownRecord[] => Array.isArray(value) ? value.filter(isRecord) : [];
const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const label = (value: unknown, fallback = "—") => typeof value === "string" && value ? value : fallback;
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-TW", { maximumFractionDigits: 2 }) : "—";
const frames: [DashboardChartTimeframe, string][] = [["today", "今日"], ["daily", "日 K"], ["weekly", "週 K"], ["monthly", "月 K"]];
const bars = { today: 500, daily: 240, weekly: 156, monthly: 120 };

function usePane(bridge: McpAppsBridge, tool: string, args: UnknownRecord | null, cadence: number | null, kind: string, decode = readToolData) {
  const [state, setState] = useState<PaneState>({ data: null, dataKey: null, loading: false, error: null });
  const loader = useMemo(() => new PaneLoader(setState), []);
  const [retry, setRetry] = useState(0);
  const key = args === null ? null : JSON.stringify(args);
  useEffect(() => {
    if (key === null) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      await loader.load(key, async (signal) => {
        const data = decode(await bridge.callTool(tool, JSON.parse(key), signal), kind);
        const request = JSON.parse(key);
        for (const field of ["stock_id", "timeframe"]) {
          if (request[field] !== undefined && data[field] !== request[field]) throw new Error("回傳標的或週期不符");
        }
        if (request.watchlist_group_id !== undefined && record(data.selection).group_id !== request.watchlist_group_id) throw new Error("回傳自選群組不符");
        return data;
      });
      if (!disposed && cadence !== null) timer = setTimeout(tick, cadence);
    };
    const tick = () => {
      if (document.hidden && cadence !== null) timer = setTimeout(tick, cadence);
      else void run();
    };
    void run();
    return () => { disposed = true; clearTimeout(timer); loader.cancel(); };
  }, [bridge, tool, key, cadence, kind, decode, loader, retry]);
  return { ...state, key, retry: () => setRetry((value) => value + 1) };
}

function Pane({ title, pane, children, className = "" }: {
  title: string; pane: PaneState & { retry: () => void }; children: ReactNode; className?: string;
}) {
  return <section className={`workspace-pane ${className}`} aria-label={title} aria-busy={pane.loading}>
    <div className="workspace-pane-heading"><h2>{title}</h2><button type="button" onClick={pane.retry} disabled={pane.loading}>{pane.error ? "重試" : "重新讀取"}</button></div>
    {pane.loading && <p role="status" className="workspace-loading">讀取中…{pane.data ? " 保留上次結果" : ""}</p>}
    {pane.error && <p role="alert" className="workspace-error">讀取失敗{pane.data ? " · 保留上次結果" : ""}</p>}
    {children}
    {!pane.error && <StatusBadge data={pane.data} />}
  </section>;
}

export function HoldingsList({ data, selected, select }: { data: UnknownRecord; selected?: string; select: (symbol: string) => void }) {
  const view = parseHoldings(data);
  return <div className="workspace-holdings">
    <p role="status">{view.state === "unavailable" ? "讀取失敗、禁止存取或資料未提供；無法確認持股" : view.state === "empty" ? "本次完整回傳範圍內沒有已記錄台股持股" : view.state === "partial" ? "部分資料；無法確認完整持股清單" : `已讀取 ${view.items.length} 筆台股記錄`}</p>
    {view.truncated && <p>清單已截斷；僅顯示回傳範圍</p>}
    {view.atLimit && !view.truncated && <p>已達 20 筆請求上限；完整性未確認</p>}
    {view.invalidCount > 0 && <p>略過 {view.invalidCount} 筆格式不符的記錄</p>}
    {view.excludedCount > 0 && <small>已排除 {view.excludedCount} 筆非台股記錄</small>}
    {view.items.map((item, index) => <button type="button" className="workspace-stock" key={`${item.symbol}:${index}`} aria-pressed={selected === item.symbol} onClick={() => select(item.symbol)}>
      <strong>{item.symbol} {item.name ?? "名稱未提供"}</strong>
      {criticalStatuses({ status: item.priceStatus }).length > 0 && <StatusBadge data={{ status: item.priceStatus }} prefix="價格：" />}
    </button>)}
  </div>;
}

export function WorkspaceApp({ bridge }: { bridge: McpAppsBridge }) {
  const [selection, setSelection] = useState(() => initialSelection(window.openai?.toolOutput ?? window.openai?.toolInput));
  const userSelected = useRef(false);
  const [presentation, setPresentation] = useState(bridge.getPresentationDiagnostic());
  useEffect(() => {
    const unsubscribe = bridge.subscribe((value) => {
      const data = isRecord(value) && "structuredContent" in value ? value.structuredContent : value;
      if (!userSelected.current && isRecord(data) && !("kind" in data)) setSelection(initialSelection(data));
    });
    const unpresent = bridge.subscribePresentation(setPresentation);
    bridge.start();
    return () => { unsubscribe(); unpresent(); bridge.stop(); };
  }, [bridge]);
  const timeframe = selection.timeframe ?? "daily";
  const header = usePane(bridge, "omi_read_tw_workspace_header", {}, 30_000, "omi.tw_workspace_header");
  // Read on mount/manual retry only; existing market polling cadences stay unchanged.
  const holdings = usePane(bridge, "omi_ask", holdingsArgs(), null, "omi.decision.v4", readHoldingsEnvelope);
  const watchlist = usePane(bridge, "omi_read_tw_workspace_watchlist", {
    ...(selection.watchlist_group_id ? { watchlist_group_id: selection.watchlist_group_id } : {}),
    include_watchlist_children: false, watchlist_limit: 100,
  }, 30_000, "omi.tw_workspace_watchlist");
  const hot = usePane(bridge, "omi_read_tw_workspace_hot_groups", {}, 120_000, "omi.tw_workspace_hot_groups");
  const chart = usePane(bridge, "omi_read_tw_stock_chart", selection.stock_id ? {
    stock_id: selection.stock_id, timeframe, bars: bars[timeframe],
  } : null, 30_000, "omi.tw_stock_chart");
  const research = usePane(bridge, "omi_read_tw_stock_research", selection.stock_id ? {
    stock_id: selection.stock_id, timeframe, projection: "workspace",
  } : null, 120_000, "omi.tw_stock_research");
  const [keyword, setKeyword] = useState("");
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const search = usePane(bridge, "omi_search_tw_symbols", searchQuery ? { keyword: searchQuery, limit: 20 } : null, 300_000, "omi.tw_symbol_search");
  const choose = (patch: Partial<typeof selection>) => {
    userSelected.current = true;
    setSelection((previous) => ({ ...previous, ...patch }));
  };
  const displayed = chart.data;
  const displayedFrame = (displayed?.timeframe ?? timeframe) as DashboardChartTimeframe;
  const activeChart = record(displayedFrame === "today" ? displayed?.intraday_chart : displayed?.chart);
  const points = useMemo(() => records(activeChart.points), [activeChart.points]);
  const averages = useMemo(() => records(displayed?.moving_averages), [displayed?.moving_averages]);
  const technical = record(research.data?.technical);
  const researchCurrent = research.dataKey === research.key;
  const summary = technicalSummary(chart, research);
  const presentationEvidence = displayed ? technicalPresentation(summary) : undefined;

  return <main className="tw-workspace" data-display-mode={presentation.actualDisplayMode}>
    <header className="workspace-title"><div><span className="brand-mark">OMI</span><h1>台股研究工作台</h1></div><button onClick={() => void bridge.requestFullscreen("manual")}>全螢幕</button></header>
    {presentation.requestStatus === "error" && <p role="status">全螢幕未開啟：{presentation.requestError}</p>}
    <div className="workspace-columns">
      <aside className="workspace-watchlist">
        <Pane title="搜尋台股" pane={search}>
          <form onSubmit={(event) => { event.preventDefault(); const query = keyword.trim(); if (query === searchQuery) search.retry(); else setSearchQuery(query || null); }}><label htmlFor="workspace-search">代碼或名稱</label><div className="workspace-search-row"><input id="workspace-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} maxLength={80} placeholder="2330 / 台積電"/><button>搜尋</button></div></form>
          {records(search.data?.items).map((item) => <button className="workspace-stock" key={label(item.stock_id)} onClick={() => choose({ stock_id: label(item.stock_id) })}>{label(item.stock_id)} {label(item.stock_name)}</button>)}
          {search.data && !records(search.data.items).length && <p>沒有符合的標的</p>}
        </Pane>
        <Pane title="OMI 已記錄台股持股" pane={holdings}>
          <p><small>OMI 已記錄持股 ≠ 即時券商庫存</small></p>
          {holdings.data && <HoldingsList data={holdings.data} selected={selection.stock_id} select={(symbol) => choose({ stock_id: symbol })} />}
        </Pane>
        <GroupNavigation pane={watchlist} selected={selection.watchlist_group_id ?? (record(watchlist.data?.selection).group_id as number)} select={(id) => choose({ watchlist_group_id: id })} selectedStock={selection.stock_id} selectStock={(symbol) => choose({ stock_id: symbol })}/>
        <WorkspaceStatusPanel sources={[
          { id: "header", name: "市場 header", pane: header },
          { id: "watchlist", name: "自選 watchlist", pane: watchlist },
          { id: "holdings", name: "持股 holdings", pane: holdings },
          { id: "search", name: "搜尋 search", pane: search },
          { id: "hot", name: "熱門族群 hot groups", pane: hot },
          { id: "chart", name: "圖表／研究對應 chart", pane: chart, presentation: presentationEvidence },
          { id: "research", name: "研究 research", pane: research },
        ]} />
      </aside>
      <MarketCards pane={header} />
      <Pane title="個股圖表" pane={{ ...chart, retry: () => { chart.retry(); research.retry(); } }} className="workspace-chart-pane">
        <div className="workspace-target"><strong>{displayed ? `${label(displayed.stock_id)} ${label(displayed.stock_name, "")} · ${frames.find(([key]) => key === displayedFrame)?.[1] ?? displayedFrame}` : selection.stock_id ?? "請從自選或搜尋選擇標的"}</strong><div role="group" aria-label="圖表週期">{frames.map(([key, name]) => <button key={key} aria-pressed={timeframe === key} onClick={() => choose({ timeframe: key })}>{name}</button>)}</div></div>
        {selection.stock_id && chart.dataKey !== chart.key && <p className="workspace-pending" role="status">待載入 {selection.stock_id} / {timeframe}。{displayed ? `目前保留 ${label(displayed.stock_id)} / ${label(displayed.timeframe)} 圖表。` : ""}</p>}
        {displayed ? <><TechnicalSummary view={summary}/><InteractiveMarketChart stockId={label(displayed.stock_id)} timeframe={displayedFrame} points={points} averages={averages}/></> : <div className="workspace-chart-placeholder">選擇標的後顯示 K 線與均線</div>}
      </Pane>
      <WorkspaceContext symbol={selection.stock_id}>
        <Pane title="技術研究" pane={research}>
          {research.data && <><p>{label(research.data.stock_id)} / {label(research.data.timeframe)}{!researchCurrent ? " · 上次結果，等待所選標的" : ""}</p><strong>{label(technical.title)}</strong><p>{label(technical.summary)}</p><p>{label(technical.phase)} · {label(technical.confidence)}</p>{records(technical.rows).map((row) => <details key={label(row.key)}><summary>{label(row.label)} · {label(row.display_value)}</summary><p>{label(row.description)}</p><small>{label(row.basis)} · {label(row.source)}</small></details>)}</>}
          {!research.data && <p>{selection.stock_id ? "研究資料獨立載入" : "選擇標的查看研究"}</p>}
        </Pane>
        <Pane title="熱門族群" pane={hot}>
          {records(hot.data?.hot_groups).map((item) => <div className="workspace-hot-row" key={label(item.group_id)}><strong>{label(item.label)}</strong><span className={changeTone(item.median_change_pct)}>{numeric(item.median_change_pct)}{numeric(item.median_change_pct) !== "—" ? "%" : ""}</span><StatusBadge data={item} /></div>)}
        </Pane>
      </WorkspaceContext>
    </div>
    <footer className="workspace-footer">不同區塊非原子快照；委託為 SYNTHETIC，非券商連線。</footer>
  </main>;
}
