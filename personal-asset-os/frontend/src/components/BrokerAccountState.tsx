import {
  Badge, Caption1, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
} from "@fluentui/react-components";
import type { Dashboard, DecimalValue } from "../types";
import { formatCurrencyAmount, formatDate } from "../format";
import { Section } from "./Common";

export function BrokerAccountState({ broker }: { broker: Dashboard["broker"] }) {
  const state = broker.account_state;
  const money = (value: DecimalValue | null | undefined) => value == null
    ? "目前不可用" : formatCurrencyAmount(value, "USD");
  return (
    <Section title="KGI 券商帳務" action={<Badge appearance="tint" color="warning">
      {!broker.enabled ? "未啟用" : !state || state.status === "unavailable" ? "目前不可用" : state.freshness === "stale" ? "資料已過期" : "待對帳"}
    </Badge>}>
      <div className="broker-account-sections">
      <div className="evidence-strip">
        <div><Caption1>e財庫現金（台幣估值）</Caption1><strong>{state?.settled_cash_twd == null ? "目前不可用" : formatCurrencyAmount(state.settled_cash_twd, "TWD")}</strong></div>
        <div><Caption1>美股原幣可交易餘額（USD）</Caption1><strong>{money(state?.buying_power)}</strong></div>
        <div><Caption1>原幣可出金（USD）</Caption1><strong>{money(state?.withdrawable_cash)}</strong></div>
        <div><Caption1>交割後預估現金</Caption1><strong>待交割入帳狀態確認</strong></div>
        <div><Caption1>券商讀取時間</Caption1><strong>{formatDate(state?.captured_at ?? null)}</strong></div>
      </div>
      <div className="evidence-strip">
        <div><Caption1>表列應收（TWD）</Caption1><strong>{formatCurrencyAmount(state?.settlement_schedule?.reported_receivable ?? null, "TWD")}</strong></div>
        <div><Caption1>表列應付（TWD）</Caption1><strong>{formatCurrencyAmount(state?.settlement_schedule?.reported_payable ?? null, "TWD")}</strong></div>
        <div><Caption1>表列淨額（TWD）</Caption1><strong>{formatCurrencyAmount(state?.settlement_schedule?.reported_net ?? null, "TWD")}</strong></div>
      </div>

      {state?.settlement_status === "reported" ? (
        <details open className="overview-details"><summary>交割明細（{state.settlements.length}）· 入帳狀態待確認</summary><div className="table-scroll">
          <Table aria-label="KGI 交割款明細">
            <TableHeader><TableRow>
              <TableHeaderCell>成交日</TableHeaderCell><TableHeaderCell>實際交割日</TableHeaderCell>
              <TableHeaderCell>應收付金額（TWD）</TableHeaderCell><TableHeaderCell>入帳狀態</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>{state.settlements.map(entry => (
              <TableRow key={entry.slot}>
                <TableCell>{entry.trade_date}</TableCell><TableCell>{entry.settlement_date}</TableCell>
                <TableCell>{Number(entry.amount) > 0 ? "+" : ""}{formatCurrencyAmount(entry.amount, "TWD")}</TableCell>
                <TableCell>待確認（券商標記 {entry.settle_mark || "未提供"}）</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>

        </div></details>
      ) : <p>交割款目前不可用，未以零值代替。</p>}
      </div>
    </Section>
  );
}

export function BrokerAccountNotes({ broker }: { broker: Dashboard["broker"] }) {
  const state = broker.account_state;
  const money = (value: DecimalValue | null | undefined) => value == null ? "目前不可用" : formatCurrencyAmount(value, "USD");
  return <Section title="券商對帳與估值依據">      <p>現金對帳：{({unmapped:"尚未對應",mapping_required:"需對應券商現金帳戶",invalid_mapping:"對應無效",matched:"帳面與估值一致",mismatch:"帳面與估值有差異"} as Record<string,string>)[state?.cash_reconciliation_status ?? ""] ?? "目前不可用"}
        {state?.ledger_cash != null ? ` · 帳面 ${formatCurrencyAmount(state.ledger_cash, "TWD")}` : ""}
        {state?.cash_difference != null ? ` · 估值差額 ${formatCurrencyAmount(state.cash_difference, "TWD")}` : ""}。匯率差異不自動記成收入或支出。</p>
      {state?.settled_cash != null ? <p>
        券商現金：{money(state.settled_cash)}。USD/TWD：{state.cash_fx?.rate ?? "目前不可用"}
        {state.cash_fx?.provider ? ` · ${state.cash_fx.provider}` : ""}
        {state.cash_fx?.effective_at ? ` · ${formatDate(state.cash_fx.effective_at)}` : ""}。
        依參考匯率換算，可能與券商 App 的台幣購買力不同。
      </p> : null}
      <p>{state?.cash_valuation_included ? "現金已納入暫估淨資產。" : "現金尚未納入暫估淨資產，請查看匯率與帳戶對應狀態。"}
        交割入帳狀態仍待確認，交割款不額外加總；可交易餘額與可出金也不另加為資產。</p>
      <p>以上為台股交割日期表的合計，未確認是否入帳；不與美股 USD 現金相加，也不是可用現金。帳戶互轉只適用實際轉入／轉出 e財庫，不能用來重複登記股票交割。</p></Section>;
}
