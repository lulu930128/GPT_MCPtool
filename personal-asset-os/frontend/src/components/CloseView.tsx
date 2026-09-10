import { Button, Field, Input, Select, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@fluentui/react-components";
import { Archive24Regular, Save24Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { formatCurrency, formatDate, localDateTimeValue, toIso } from "../format";
import type { Account, DecimalValue, Reconciliation, Snapshot } from "../types";
import { EmptyState, Section } from "./Common";

export function CloseView({ accounts, reconciliations, snapshots, reservedCash, mutate }: { accounts: Account[]; reconciliations: Reconciliation[]; snapshots: Snapshot[]; reservedCash: DecimalValue; mutate: (path: string, body: unknown, success: string, method?: "post" | "put") => Promise<void> }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  async function confirm(r: Reconciliation) {
    if (confirming) return;
    setConfirming(r.id);
    try { await mutate(`/api/reconciliations/${r.id}/confirm`, { expected_difference: r.difference }, "盤點差額已入帳，總覽已更新"); }
    finally { setConfirming(null); }
  }
  const personal = accounts.filter((a) => !a.is_system && (a.kind === "asset" || a.kind === "liability"));
  const [accountId, setAccountId] = useState(""); const [balance, setBalance] = useState(""); const [source, setSource] = useState(""); const [observedAt, setObservedAt] = useState(localDateTimeValue());
  const [reserve, setReserve] = useState(String(reservedCash));
  const now = new Date(); const [period, setPeriod] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`); const [closeAt, setCloseAt] = useState(localDateTimeValue());
  async function reconcile(event: React.FormEvent) { event.preventDefault(); await mutate("/api/reconciliations", { account_id: accountId, reported_balance: balance, observed_at: toIso(observedAt), source, reconciled: false }, "對帳觀察已保存"); setBalance(""); setSource(""); }
  async function saveReserve(event: React.FormEvent) { event.preventDefault(); await mutate("/api/settings/reserved-cash", { value: reserve }, "保留現金已更新", "put"); }
  async function closeMonth(event: React.FormEvent) { event.preventDefault(); await mutate("/api/snapshots/month-close", { period_key: period, as_of: toIso(closeAt) }, "月結快照已建立"); }
  return <div className="view-stack">
    <div className="split-grid">
      <Section title="記錄實際餘額"><form className="form-grid compact" onSubmit={reconcile}><Field label="帳戶" required><Select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">請選擇</option>{personal.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}</Select></Field><Field label="實際餘額"><Input placeholder="信用卡負債請輸入正數" type="number" step="0.01" value={balance} onChange={(_, d) => setBalance(d.value)} /></Field><Field label="來源" required><Input value={source} onChange={(_, d) => setSource(d.value)} placeholder="例如：銀行 App" /></Field><Field label="觀察時間"><Input type="datetime-local" value={observedAt} onChange={(_, d) => setObservedAt(d.value)} /></Field><div className="form-actions"><Button appearance="primary" type="submit" icon={<Save24Regular />} disabled={!accountId || !balance || !source}>保存觀察</Button></div></form></Section>
      <Section title="資金保留與月結"><form className="form-grid compact" onSubmit={saveReserve}><Field label="保留現金"><Input type="number" min="0" step="1" value={reserve} onChange={(_, d) => setReserve(d.value)} /></Field><div className="form-actions"><Button type="submit">更新保留現金</Button></div></form><form className="form-grid compact top-gap" onSubmit={closeMonth}><Field label="結算月份"><Input type="month" value={period} onChange={(_, d) => setPeriod(d.value)} /></Field><Field label="估值截止"><Input type="datetime-local" value={closeAt} onChange={(_, d) => setCloseAt(d.value)} /></Field><div className="form-actions"><Button type="submit" appearance="primary" icon={<Archive24Regular />}>建立月結</Button></div></form></Section>
    </div>
    <Section title="建立資料備份" action={<Button icon={<Archive24Regular />} onClick={() => void mutate("/api/backups", {}, "Verified backup 已建立")}>立即備份</Button>}>{null}</Section>
    <Section title="盤點確認">{reconciliations.length === 0 ? <EmptyState title="尚無對帳觀察" body="月底可從銀行或信用卡 App 輸入實際餘額。" /> : <div className="table-scroll"><Table aria-label="對帳狀態"><TableHeader><TableRow><TableHeaderCell>帳戶</TableHeaderCell><TableHeaderCell>觀察時間</TableHeaderCell><TableHeaderCell>實際</TableHeaderCell><TableHeaderCell>帳面</TableHeaderCell><TableHeaderCell>差額</TableHeaderCell><TableHeaderCell>確認</TableHeaderCell></TableRow></TableHeader><TableBody>{reconciliations.map((r) => <TableRow key={r.id}><TableCell>{r.account_name}</TableCell><TableCell>{formatDate(r.observed_at)}</TableCell><TableCell>{formatCurrency(r.reported_balance)}</TableCell><TableCell>{formatCurrency(r.ledger_balance)}</TableCell><TableCell className="number-cell">{formatCurrency(r.difference)}</TableCell><TableCell>{r.reconciled ? "已確認" : <Button appearance="primary" disabled={confirming !== null} onClick={() => void confirm(r)}>{confirming === r.id ? "處理中…" : "確定"}</Button>}</TableCell></TableRow>)}</TableBody></Table></div>}</Section>
    <Section title="月結歷史">{snapshots.length === 0 ? <EmptyState title="尚無月結" body="完成本月對帳與估值後建立第一份快照。" /> : <div className="table-scroll"><Table aria-label="月結歷史"><TableHeader><TableRow><TableHeaderCell>月份</TableHeaderCell><TableHeaderCell>截止</TableHeaderCell><TableHeaderCell>價格時間</TableHeaderCell><TableHeaderCell>計算版本</TableHeaderCell></TableRow></TableHeader><TableBody>{snapshots.map((s) => <TableRow key={s.id}><TableCell><strong>{s.period_key}</strong></TableCell><TableCell>{formatDate(s.as_of)}</TableCell><TableCell>{formatDate(s.price_as_of)}</TableCell><TableCell><code>{s.calculation_version}</code></TableCell></TableRow>)}</TableBody></Table></div>}</Section>
  </div>;
}
