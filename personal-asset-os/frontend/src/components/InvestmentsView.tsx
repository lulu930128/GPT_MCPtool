import { Badge, Button, Field, Input, Select, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@fluentui/react-components";
import { Add24Regular, Save24Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { formatCurrency, formatCurrencyAmount, formatDate, formatDecimal, localDateTimeValue, qualityLabel, toIso } from "../format";
import type { Account, Instrument, Position } from "../types";
import { EmptyState, Section } from "./Common";

export function InvestmentsView({ accounts, instruments, positions, mutate }: { accounts: Account[]; instruments: Instrument[]; positions: Position[]; mutate: (path: string, body: unknown, success: string) => Promise<void> }) {
  const investmentAccounts = accounts.filter((a) => !a.is_system && a.subtype === "investment");
  const cashAccounts = accounts.filter((a) => !a.is_system && a.kind === "asset" && a.subtype !== "investment");
  const [symbol, setSymbol] = useState(""); const [market, setMarket] = useState("TWSE"); const [name, setName] = useState("");
  const [instrumentId, setInstrumentId] = useState(""); const [investmentId, setInvestmentId] = useState(""); const [cashId, setCashId] = useState("");
  const [side, setSide] = useState("buy"); const [quantity, setQuantity] = useState(""); const [price, setPrice] = useState(""); const [fee, setFee] = useState("0"); const [tax, setTax] = useState("0"); const [tradeAt, setTradeAt] = useState(localDateTimeValue());
  const [priceInstrument, setPriceInstrument] = useState(""); const [manualPrice, setManualPrice] = useState(""); const [priceAt, setPriceAt] = useState(localDateTimeValue());

  async function createInstrument(event: React.FormEvent) { event.preventDefault(); await mutate("/api/instruments", { symbol, market, name, asset_class: "equity", currency: "TWD" }, "投資商品已建立"); setSymbol(""); setName(""); }
  async function createTrade(event: React.FormEvent) { event.preventDefault(); const selected = instruments.find((item) => item.id === instrumentId); await mutate("/api/trades", { instrument_id: instrumentId, investment_account_id: investmentId, cash_account_id: cashId, side, quantity, execution_price: price, fee, tax, occurred_at: toIso(tradeAt), description: `${side === "buy" ? "買進" : "賣出"} ${selected?.symbol ?? "投資商品"}`, idempotency_key: crypto.randomUUID() }, "投資交易已入帳"); setQuantity(""); setPrice(""); }
  async function updatePrice(event: React.FormEvent) { event.preventDefault(); await mutate("/api/prices", { instrument_id: priceInstrument, price: manualPrice, price_at: toIso(priceAt), provider: "manual", quality: "manual" }, "手動價格已保存"); setManualPrice(""); }

  return <div className="view-stack">
    <Section title="投資部位">
      {positions.length === 0 ? <EmptyState title="尚無持倉" body="先建立投資帳戶與商品，再記錄第一筆買進。" /> : <div className="table-scroll"><Table aria-label="投資部位">
        <TableHeader><TableRow><TableHeaderCell>商品</TableHeaderCell><TableHeaderCell>數量</TableHeaderCell><TableHeaderCell>成本</TableHeaderCell><TableHeaderCell>市值</TableHeaderCell><TableHeaderCell>未實現</TableHeaderCell><TableHeaderCell>來源／估值</TableHeaderCell></TableRow></TableHeader>
        <TableBody>{positions.map((item) => <TableRow key={`${item.instrument_id}-${item.investment_account_id}`}><TableCell><strong>{item.symbol}</strong><br /><small>{item.market} · {item.name}</small></TableCell><TableCell>{formatDecimal(item.quantity)}{item.reconciliation_status === "quantity_mismatch" ? <><br /><small>帳本 {formatDecimal(item.ledger_quantity)}</small></> : null}</TableCell><TableCell>{formatCurrency(item.cost_basis)}</TableCell><TableCell>{item.valuation_included ? formatCurrency(item.market_value) : "未計入"}{item.native_currency !== "TWD" ? <><br /><small>原幣 {formatCurrencyAmount(item.native_market_value, item.native_currency)}</small></> : null}</TableCell><TableCell>{formatCurrency(item.unrealized_pnl)}{item.broker_unrealized_pnl != null ? <><br /><small>券商參考 {formatCurrency(item.broker_unrealized_pnl)}</small></> : null}</TableCell><TableCell><Badge appearance="tint" color={item.valuation_status === "manual" || item.valuation_status === "broker_live" ? "success" : "warning"}>{qualityLabel(item.valuation_status)}</Badge><br /><small>{item.position_source === "kgi_broker" ? "KGI 唯讀" : "PAOS 帳本"} · {qualityLabel(item.reconciliation_status)}</small>{item.fx_rate != null && item.native_currency !== "TWD" ? <><br /><small>USD/TWD {formatDecimal(item.fx_rate)} · {formatDate(item.fx_at)}</small></> : null}<br /><small>{formatDate(item.price_at)}</small></TableCell></TableRow>)}</TableBody>
      </Table></div>}
    </Section>
    <div className="split-grid">
      <Section title="建立商品"><form className="form-grid compact" onSubmit={createInstrument}>
        <Field label="代號" required><Input value={symbol} onChange={(_, d) => setSymbol(d.value)} /></Field><Field label="市場" required><Input value={market} onChange={(_, d) => setMarket(d.value)} /></Field><Field label="名稱" required><Input value={name} onChange={(_, d) => setName(d.value)} /></Field><div className="form-actions"><Button type="submit" appearance="primary" icon={<Add24Regular />} disabled={!symbol || !market || !name}>建立商品</Button></div>
      </form></Section>
      <Section title="更新手動價格"><form className="form-grid compact" onSubmit={updatePrice}>
        <Field label="商品" required><Select value={priceInstrument} onChange={(e) => setPriceInstrument(e.target.value)}><option value="">請選擇</option>{instruments.map((i) => <option value={i.id} key={i.id}>{i.market} {i.symbol}</option>)}</Select></Field><Field label="價格" required><Input type="number" step="0.01" min="0.000001" value={manualPrice} onChange={(_, d) => setManualPrice(d.value)} /></Field><Field label="價格時間" required><Input type="datetime-local" value={priceAt} onChange={(_, d) => setPriceAt(d.value)} /></Field><div className="form-actions"><Button type="submit" appearance="primary" icon={<Save24Regular />} disabled={!priceInstrument || !manualPrice}>保存價格</Button></div>
      </form></Section>
    </div>
    <Section title="記錄買賣"><form className="form-grid" onSubmit={createTrade}>
      <Field label="方向" required><Select value={side} onChange={(e) => setSide(e.target.value)}><option value="buy">買進</option><option value="sell">賣出</option></Select></Field>
      <Field label="商品" required><Select value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)}><option value="">請選擇</option>{instruments.map((i) => <option value={i.id} key={i.id}>{i.market} {i.symbol}</option>)}</Select></Field>
      <Field label="投資帳戶" required><Select value={investmentId} onChange={(e) => setInvestmentId(e.target.value)}><option value="">請選擇</option>{investmentAccounts.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}</Select></Field>
      <Field label="現金帳戶" required><Select value={cashId} onChange={(e) => setCashId(e.target.value)}><option value="">請選擇</option>{cashAccounts.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}</Select></Field>
      <Field label="數量" required><Input type="number" min="0.000001" step="0.000001" value={quantity} onChange={(_, d) => setQuantity(d.value)} /></Field><Field label="成交價" required><Input type="number" min="0.000001" step="0.01" value={price} onChange={(_, d) => setPrice(d.value)} /></Field>
      <Field label="手續費"><Input type="number" min="0" step="0.01" value={fee} onChange={(_, d) => setFee(d.value)} /></Field><Field label="稅"><Input type="number" min="0" step="0.01" value={tax} onChange={(_, d) => setTax(d.value)} /></Field>
      <Field label="成交時間" required><Input type="datetime-local" value={tradeAt} onChange={(_, d) => setTradeAt(d.value)} /></Field><div className="form-actions"><Button type="submit" appearance="primary" icon={<Save24Regular />} disabled={!instrumentId || !investmentId || !cashId || !quantity || !price}>正式入帳</Button></div>
    </form></Section>
  </div>;
}
