import {
  Badge,
  Button,
  FluentProvider,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Tab,
  TabList,
  Title1,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import { DarkTheme24Regular, WeatherSunny24Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { AccountsView } from "./components/AccountsView";
import { CloseView } from "./components/CloseView";
import { DashboardView } from "./components/DashboardView";
import { InvestmentsView } from "./components/InvestmentsView";
import { LoadingState, ReloadButton } from "./components/Common";
import { PendingEventsView } from "./components/PendingEventsView";
import { QuickCapture } from "./components/QuickCapture";
import { TransactionsView } from "./components/TransactionsView";
import { qualityLabel } from "./format";
import type { Account, Dashboard, FinancialEvent, Instrument, Snapshot } from "./types";
import "./styles.css";

type View = "dashboard" | "pending" | "accounts" | "transactions" | "investments" | "close";

function initialView(): View {
  return new URLSearchParams(window.location.search).get("view") === "pending"
    ? "pending"
    : "dashboard";
}

function qualityColor(quality: string | undefined): "success" | "warning" | "informative" {
  if (!quality || quality === "not_initialized") return "informative";
  return quality === "complete" || quality === "complete_manual" ? "success" : "warning";
}

export default function App() {
  const [view, setView] = useState<View>(initialView);
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [financialEvents, setFinancialEvents] = useState<FinancialEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const loadedOnce = useRef(false);

  const reload = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    setError(null);
    try {
      const [nextDashboard, nextAccounts, nextInstruments, nextSnapshots, nextEvents] = await Promise.all([api.dashboard(), api.accounts(), api.instruments(), api.snapshots(), api.financialEvents()]);
      setDashboard(nextDashboard); setAccounts(nextAccounts); setInstruments(nextInstruments); setSnapshots(nextSnapshots); setFinancialEvents(nextEvents);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取資產資料");
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, []);

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
        <Tab value="dashboard">總覽</Tab><Tab value="pending">待處理（{financialEvents.length}）</Tab><Tab value="accounts">帳戶</Tab><Tab value="transactions">交易</Tab><Tab value="investments">投資</Tab><Tab value="close">對帳與月結</Tab>
      </TabList></nav>
      <main className="app-main" aria-busy={loading || busy}>
        {error ? <MessageBar intent="error"><MessageBarBody><MessageBarTitle>操作未完成</MessageBarTitle>{error}</MessageBarBody></MessageBar> : null}
        {success ? <MessageBar intent="success"><MessageBarBody><MessageBarTitle>完成</MessageBarTitle>{success}</MessageBarBody></MessageBar> : null}
        {loading || !dashboard ? <LoadingState /> : <>
          {view === "dashboard" ? <div className="view-stack"><QuickCapture accounts={accounts} onChanged={reload} /><DashboardView dashboard={dashboard} /></div> : null}
          {view === "pending" ? <PendingEventsView events={financialEvents} accounts={accounts} onChanged={reload} /> : null}
          {view === "accounts" ? <AccountsView accounts={accounts} mutate={mutate} /> : null}
          {view === "transactions" ? <TransactionsView accounts={accounts} mutate={mutate} /> : null}
          {view === "investments" ? <InvestmentsView accounts={accounts} instruments={instruments} positions={dashboard.positions} mutate={mutate} /> : null}
          {view === "close" ? <CloseView accounts={accounts} reconciliations={dashboard.reconciliations} snapshots={snapshots} reservedCash={dashboard.metrics.reserved_cash} mutate={mutate} /> : null}
        </>}
      </main>
      <footer className="app-footer"><span>正式帳本只保存在本機</span><span>估值時間 {dashboard?.valuation.price_as_of_max ? new Date(dashboard.valuation.price_as_of_max).toLocaleString("zh-TW") : "尚無價格"}</span></footer>
    </div>
  </FluentProvider>;
}
