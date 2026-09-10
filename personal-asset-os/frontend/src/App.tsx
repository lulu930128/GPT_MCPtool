import { ExplanationView } from "./components/ExplanationView";
import { BrokerAccountNotes } from "./components/BrokerAccountState";
import { DashboardTemplate } from "./components/DashboardTemplate";
import { darkTheme, lightTheme } from "./theme";
import {
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Badge,
  Button,
  FluentProvider,
  Tab,
  TabList,
  Title1,
} from "@fluentui/react-components";
import { DarkTheme24Regular, WeatherSunny24Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { AssetTrendChart } from "./components/AssetTrendChart";
import { CloseView } from "./components/CloseView";
import { DataStatusPanel } from "./components/DataStatusPanel";
import { DashboardView } from "./components/DashboardView";
import { ReloadButton } from "./components/Common";
import { PendingEventsView } from "./components/PendingEventsView";
import { TransactionsView } from "./components/TransactionsView";
import { qualityLabel } from "./format";
import type { Account, Dashboard, DashboardHistory, DashboardHistoryRange, FinancialEvent, MobileUsbTransportStatus, Snapshot } from "./types";
import "./styles.css";

type View = "dashboard" | "pending" | "transactions" | "close" | "help" | "status";

function initialView(): View {
  return new URLSearchParams(window.location.search).get("view") === "pending"
    ? "pending"
    : "dashboard";
}

function qualityColor(quality: string | undefined): "success" | "warning" | "informative" {
  if (!quality || quality === "not_initialized") return "informative";
  return quality === "complete" || quality === "complete_manual" ? "success" : "warning";
}

function mobileTransportWarning(status: MobileUsbTransportStatus | null): string[] {
  if (!status?.enabled || status.ready) return [];
  return [`mobile_usb_bridge:${status.status}`];
}

export default function App() {
  const [view, setView] = useState<View>(initialView);
  const [dark, setDark] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [history, setHistory] = useState<DashboardHistory | null>(null);
  const [historyRange, setHistoryRange] = useState<DashboardHistoryRange>("1m");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [financialEvents, setFinancialEvents] = useState<FinancialEvent[]>([]);
  const [mobileTransport, setMobileTransport] = useState<MobileUsbTransportStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const dashboardRequest = useRef<Promise<Dashboard> | null>(null);
  const [stockRefreshError, setStockRefreshError] = useState<string | null>(null);
  const historyRangeRef = useRef<DashboardHistoryRange>("1m");

  const readDashboard = useCallback(() => {
    if (dashboardRequest.current) return dashboardRequest.current;
    const request = api.dashboard().finally(() => {
      if (dashboardRequest.current === request) dashboardRequest.current = null;
    });
    dashboardRequest.current = request;
    return request;
  }, []);

  const loadHistory = useCallback(async (range: DashboardHistoryRange) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistory(await api.dashboardHistory(range));
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : "無法讀取資產歷史");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const capture = (label: string) => (caught: unknown) => {
      setError(previous => [previous, `${label}：${caught instanceof Error ? caught.message : "讀取失敗"}`].filter(Boolean).join("；"));
    };
    // Publish each response immediately; the broker must not gate history or account data.
    await Promise.allSettled([
      readDashboard().then(setDashboard).catch(capture("資產總覽")).finally(() => setLoading(false)),
      api.accounts().then(setAccounts).catch(capture("帳戶")),
      api.snapshots().then(setSnapshots).catch(capture("月結")),
      api.financialEvents().then(setFinancialEvents).catch(capture("待處理")),
      api.mobileTransport().then(setMobileTransport).catch(capture("手機連線")),
      loadHistory(historyRangeRef.current),
    ]);
  }, [readDashboard, loadHistory]);

  function changeHistoryRange(range: DashboardHistoryRange) {
    historyRangeRef.current = range;
    setHistoryRange(range);
    void loadHistory(range);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  useEffect(() => {
    if (view !== "dashboard" || loading || busy) return;
    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;
    const refresh = async () => {
      if (cancelled || document.hidden || inFlight) return;
      inFlight = true;
      const started = Date.now();
      try {
        const next = await readDashboard();
        if (!cancelled && !document.hidden) {
          setDashboard(next);
          setStockRefreshError(null);
        }
      } catch {
        if (!cancelled) setStockRefreshError("股票自動更新失敗，保留上次畫面，請留意報價時間");
      } finally {
        inFlight = false;
        if (!cancelled && !document.hidden) {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => void refresh(), Math.max(1000, 25000 - (Date.now() - started)));
        }
      }
    };
    const visibility = () => {
      window.clearTimeout(timer);
      if (!document.hidden && !inFlight) timer = window.setTimeout(() => void refresh(), 25000);
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [view, loading, busy, readDashboard]);

  async function mutate(path: string, body: unknown, successMessage: string, method: "post" | "put" = "post") {
    setBusy(true); setError(null); setSuccess(null);
    try {
      if (method === "put") await api.put(path, body); else await api.post(path, body);
      setSuccess(successMessage); await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.message} (${caught.code})` : caught instanceof Error ? caught.message : "操作失敗");
    } finally { setBusy(false); }
  }

  return <FluentProvider theme={dark ? darkTheme : lightTheme} className="provider-root" data-theme={dark ? "dark" : "light"}>
    <div className="app-shell">
      <header className="app-header">
        <div><Title1>Personal Asset OS</Title1><div className="header-meta"><Badge appearance="tint" color={qualityColor(dashboard?.quality)}>{qualityLabel(dashboard?.quality)}</Badge><span>本機帳本</span><span>TWD</span></div></div>
        <div className="header-actions"><ReloadButton onClick={() => void reload()} disabled={loading || busy} /><Button appearance="subtle" icon={dark ? <WeatherSunny24Regular /> : <DarkTheme24Regular />} onClick={() => setDark((value) => !value)} aria-label="切換明暗主題">{dark ? "淺色" : "深色"}</Button></div>
      </header>
      <nav className="app-nav" aria-label="主要功能"><TabList selectedValue={view} onTabSelect={(_, data) => setView(data.value as View)}>
        <Tab value="dashboard">總覽</Tab><Tab value="pending">待處理（{financialEvents.length}）</Tab><Tab value="transactions">交易</Tab><Tab value="close">對帳與月結</Tab>
      </TabList><Menu><MenuTrigger disableButtonEnhancement><Button appearance="subtle">設定</Button></MenuTrigger><MenuPopover><MenuList><MenuItem onClick={() => setView("help")}>說明</MenuItem><MenuItem onClick={() => setView("status")}>更新狀態</MenuItem></MenuList></MenuPopover></Menu></nav>
      <main className="app-main" aria-busy={loading || busy}>
        {view === "status" ? <><h1>更新狀態</h1><DataStatusPanel
          warnings={[...(dashboard?.warnings ?? []), ...mobileTransportWarning(mobileTransport), ...(historyError ? [`資產歷史：${historyError}`] : []), ...(stockRefreshError ? [stockRefreshError] : [])]}
          error={error}
          success={success}
          loading={loading || busy}
          onRefresh={() => void reload()}
        />{dashboard ? <BrokerAccountNotes broker={dashboard.broker} /> : null}</> : null}
        {view !== "status" && (error || success) ? <div role={error ? "alert" : "status"}>{error ?? success} <Button appearance="subtle" onClick={() => setView("status")}>查看更新狀態</Button></div> : null}
        {view === "help" ? <ExplanationView dashboard={dashboard} /> : null}
        {view !== "help" && view !== "status" ? (!dashboard ? <DashboardTemplate failed={!loading} trend={<AssetTrendChart history={history} range={historyRange} loading={historyLoading} unavailable={Boolean(historyError)} onRangeChange={changeHistoryRange} />} /> : <>
          {view === "dashboard" ? <DashboardView dashboard={dashboard} trend={<AssetTrendChart history={history} range={historyRange} loading={historyLoading} unavailable={Boolean(historyError)} onRangeChange={changeHistoryRange} />} /> : null}
          {view === "pending" ? <PendingEventsView events={financialEvents} accounts={accounts} onChanged={reload} /> : null}
          {view === "transactions" ? <TransactionsView accounts={accounts} mutate={mutate} /> : null}
          {view === "close" ? <CloseView accounts={accounts} reconciliations={dashboard.reconciliations} snapshots={snapshots} reservedCash={dashboard.metrics.reserved_cash} mutate={mutate} /> : null}
        </>) : null}
      </main>
      <footer className="app-footer"><span>正式帳本只保存在本機</span><span>估值時間 {dashboard?.valuation.price_as_of_max ? new Date(dashboard.valuation.price_as_of_max).toLocaleString("zh-TW") : "尚無價格"}</span></footer>
    </div>
  </FluentProvider>;
}
