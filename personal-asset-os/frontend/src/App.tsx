import {
  Badge,
  Button,
  FluentProvider,
  Tab,
  TabList,
  Title1,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import { DarkTheme24Regular, WeatherSunny24Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { AssetTrendChart } from "./components/AssetTrendChart";
import { CloseView } from "./components/CloseView";
import { DataStatusPanel } from "./components/DataStatusPanel";
import { DashboardView } from "./components/DashboardView";
import { LoadingState, ReloadButton } from "./components/Common";
import { PendingEventsView } from "./components/PendingEventsView";
import { TransactionsView } from "./components/TransactionsView";
import { qualityLabel } from "./format";
import type { Account, Dashboard, DashboardHistory, DashboardHistoryRange, FinancialEvent, MobileUsbTransportStatus, Snapshot } from "./types";
import "./styles.css";

type View = "dashboard" | "pending" | "transactions" | "close";

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
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
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
  const loadedOnce = useRef(false);
  const historyRangeRef = useRef<DashboardHistoryRange>("1m");

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
    if (!loadedOnce.current) setLoading(true);
    setHistoryLoading(true);
    setError(null);
    setHistoryError(null);
    try {
      const [coreResult, historyResult] = await Promise.allSettled([
        Promise.all([api.dashboard(), api.accounts(), api.snapshots(), api.financialEvents(), api.mobileTransport()]),
        api.dashboardHistory(historyRangeRef.current),
      ]);
      if (coreResult.status === "fulfilled") {
        const [nextDashboard, nextAccounts, nextSnapshots, nextEvents, nextMobileTransport] = coreResult.value;
        setDashboard(nextDashboard); setAccounts(nextAccounts); setSnapshots(nextSnapshots); setFinancialEvents(nextEvents); setMobileTransport(nextMobileTransport);
      } else {
        setError(coreResult.reason instanceof Error ? coreResult.reason.message : "無法讀取資產資料");
      }
      if (historyResult.status === "fulfilled") {
        setHistory(historyResult.value);
      } else {
        setHistoryError(historyResult.reason instanceof Error ? historyResult.reason.message : "無法讀取資產歷史");
      }
    } finally {
      loadedOnce.current = true;
      setLoading(false);
      setHistoryLoading(false);
    }
  }, []);

  function changeHistoryRange(range: DashboardHistoryRange) {
    historyRangeRef.current = range;
    setHistoryRange(range);
    void loadHistory(range);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  async function mutate(path: string, body: unknown, successMessage: string, method: "post" | "put" = "post") {
    setBusy(true); setError(null); setSuccess(null);
    try {
      if (method === "put") await api.put(path, body); else await api.post(path, body);
      setSuccess(successMessage); await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.message} (${caught.code})` : caught instanceof Error ? caught.message : "操作失敗");
    } finally { setBusy(false); }
  }

  return <FluentProvider theme={dark ? webDarkTheme : webLightTheme} className="provider-root">
    <div className="app-shell">
      <header className="app-header">
        <div><Title1>Personal Asset OS</Title1><div className="header-meta"><Badge appearance="tint" color={qualityColor(dashboard?.quality)}>{qualityLabel(dashboard?.quality)}</Badge><span>本機帳本</span><span>TWD</span></div></div>
        <div className="header-actions"><ReloadButton onClick={() => void reload()} disabled={loading || busy} /><Button appearance="subtle" icon={dark ? <WeatherSunny24Regular /> : <DarkTheme24Regular />} onClick={() => setDark((value) => !value)} aria-label="切換明暗主題">{dark ? "淺色" : "深色"}</Button></div>
      </header>
      <nav className="app-nav" aria-label="主要功能"><TabList selectedValue={view} onTabSelect={(_, data) => setView(data.value as View)}>
        <Tab value="dashboard">總覽</Tab><Tab value="pending">待處理（{financialEvents.length}）</Tab><Tab value="transactions">交易</Tab><Tab value="close">對帳與月結</Tab>
      </TabList></nav>
      <main className="app-main" aria-busy={loading || busy}>
        <DataStatusPanel
          warnings={[...(dashboard?.warnings ?? []), ...mobileTransportWarning(mobileTransport), ...(historyError ? [`資產歷史：${historyError}`] : [])]}
          error={error}
          success={success}
          loading={loading || busy}
          onRefresh={() => void reload()}
        />
        {loading || !dashboard ? <LoadingState /> : <>
          {view === "dashboard" ? <DashboardView dashboard={dashboard} trend={<AssetTrendChart history={history} range={historyRange} loading={historyLoading} unavailable={Boolean(historyError)} onRangeChange={changeHistoryRange} />} /> : null}
          {view === "pending" ? <PendingEventsView events={financialEvents} accounts={accounts} onChanged={reload} /> : null}
          {view === "transactions" ? <TransactionsView accounts={accounts} mutate={mutate} /> : null}
          {view === "close" ? <CloseView accounts={accounts} reconciliations={dashboard.reconciliations} snapshots={snapshots} reservedCash={dashboard.metrics.reserved_cash} mutate={mutate} /> : null}
        </>}
      </main>
      <footer className="app-footer"><span>正式帳本只保存在本機</span><span>估值時間 {dashboard?.valuation.price_as_of_max ? new Date(dashboard.valuation.price_as_of_max).toLocaleString("zh-TW") : "尚無價格"}</span></footer>
    </div>
  </FluentProvider>;
}
