import { StockPieChart } from "./StockPieChart";
import {
  Badge,
  Button,
  Caption1,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from "@fluentui/react-components";
import { useState, type ReactNode } from "react";
import {
  formatCurrency,
  formatCurrencyAmount,
  formatDate,
  formatDecimal,
  qualityLabel,
} from "../format";
import type {
  Dashboard,
  ReviewComposition,
  ReviewCompositionItem,
  ReviewSpendingRange,
} from "../types";
import { EmptyState, Section } from "./Common";

import { BrokerAccountState } from "./BrokerAccountState";

const RANGE_LABELS: Record<ReviewSpendingRange, string> = {
  "1m": "本月",
  "3m": "近 3 個月",
  "1y": "近 1 年",
};

function labelSource(value: string): string {
  return {
    reporting_annotation: "分類修正",
    category_hint: "分類",
    merchant: "店家",
    transaction_description: "交易描述",
    activity_fund: "活動資金帳戶",
    portfolio_valuation: "投資估值",
    ledger: "正式帳本",
    asset_valuation: "帳本與券商現金估值",
    aggregate: "其餘合計",
    position: "持倉估值",
  }[value] ?? value;
}

function AllocationTable({
  composition,
  kind,
  ariaLabel,
}: {
  composition: ReviewComposition;
  kind: "asset" | "stock" | "spending";
  ariaLabel: string;
}) {
  if (composition.table_items.length === 0) {
    return <EmptyState title="尚無可比較金額" body="資料會保留空值，不會用零補出占比。" />;
  }
  return (
    <div className="table-scroll review-table-scroll">
      <Table aria-label={ariaLabel} size="small">
        <TableHeader>
          <TableRow>
            {kind === "stock" ? <TableHeaderCell>市場</TableHeaderCell> : null}
            <TableHeaderCell>
              {kind === "spending" ? "消費去向" : kind === "stock" ? "持股" : "資產"}
            </TableHeaderCell>
            {kind === "spending" ? <TableHeaderCell>依據</TableHeaderCell> : null}
            {kind === "stock" ? <><TableHeaderCell>現價（原幣）</TableHeaderCell><TableHeaderCell>股數</TableHeaderCell></> : null}
            <TableHeaderCell>金額</TableHeaderCell>
            <TableHeaderCell>占比</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {composition.table_items.map((item: ReviewCompositionItem, index) => (
            <TableRow key={item.key}>
              {kind === "stock" ? (
                <TableCell><Badge appearance="outline">{item.market}</Badge></TableCell>
              ) : null}
              <TableCell>
                <span className="review-table-label">
                  <i className={`allocation-swatch swatch-${Math.min(index, 5)}`} />
                  <span>
                    <Text weight="semibold">{item.label}</Text>
                    {item.symbol ? <Caption1>{item.symbol}</Caption1> : null}
                  </span>
                </span>
              </TableCell>
              {kind === "spending" ? (
                <TableCell><Caption1>{labelSource(item.label_source)}</Caption1></TableCell>
              ) : null}
              {kind === "stock" ? <>
                <TableCell className="number-cell">
                  <div>{item.native_price == null ? "缺少資料" : formatCurrencyAmount(item.native_price, item.native_currency ?? "TWD")}</div>
                  <Caption1>{item.price_quality === "broker_close" ? "收盤參考" : qualityLabel(item.valuation_status)}
                    {item.price_at ? ` · ${new Date(item.price_at).toLocaleString("zh-TW", {hour12: false})}` : ""}</Caption1>
                </TableCell>
                <TableCell className="number-cell">{formatDecimal(item.quantity)}</TableCell>
              </> : null}
              <TableCell className="number-cell">{formatCurrency(item.amount)}</TableCell>
              <TableCell className="number-cell">{item.share_percent}%</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CompositionNote({ composition }: { composition: ReviewComposition }) {
  if (composition.excluded_count === 0 && Number(composition.excluded_amount) <= 0) return null;
  return (
    <div className="composition-note">

      {composition.excluded_count > 0 || Number(composition.excluded_amount) > 0 ? (
        <Badge appearance="tint" color="warning">
          排除 {composition.excluded_count} 筆
          {Number(composition.excluded_amount) > 0
            ? ` · ${formatCurrency(composition.excluded_amount)}`
            : ""}
        </Badge>
      ) : null}
    </div>
  );
}

export function DashboardView({ dashboard, trend }: { dashboard: Dashboard; trend: ReactNode }) {
  const [spendingRange, setSpendingRange] = useState<ReviewSpendingRange>(
    dashboard.review.spending.default_range,
  );
  const spending = dashboard.review.spending.ranges[spendingRange];
  const brokerActive = dashboard.broker.status !== "disabled";

  return (
    <div className="view-stack review-dashboard">
      <header className="overview-heading"><div><Caption1>{formatDate(dashboard.review.as_of)}</Caption1><h1>資產複盤</h1></div><Badge appearance="tint">{qualityLabel(dashboard.quality)}</Badge></header>
      <dl className="overview-metrics">
        <div className="overview-net"><dt>暫估淨資產</dt><dd>{formatCurrency(dashboard.review.summary.provisional_net_worth)}</dd></div>
        <div><dt>活動資金</dt><dd>{formatCurrency(dashboard.metrics.liquid_cash)}</dd></div>
        <div><dt>e財庫現金</dt><dd>{dashboard.metrics.broker_cash_total == null ? "—" : formatCurrency(dashboard.metrics.broker_cash_total)}</dd></div>
        <div><dt>股票市值</dt><dd>{formatCurrency(dashboard.review.stock_allocation.total)}</dd></div>
        <div><dt>信用與其他負債</dt><dd>{formatCurrency(dashboard.review.summary.debt)}</dd></div>
      </dl>
      <div className="overview-flow"><span>本月收入 <strong>{formatCurrency(dashboard.metrics.monthly_income)}</strong></span><span>本月支出 <strong>{formatCurrency(dashboard.metrics.monthly_expense)}</strong></span><span>總資產 <strong>{formatCurrency(dashboard.review.summary.gross_assets)}</strong></span></div>
      {Number(dashboard.review.summary.unpriced_investment_cost) > 0 ? <Caption1>總資產含 {formatCurrency(dashboard.review.summary.unpriced_investment_cost)} 缺價成本替代值，配置圖不納入。</Caption1> : null}
      <Section title="資產配置">
        <div className="allocation-strip" aria-label="資產占比">{dashboard.review.asset_allocation.chart_items.map((item, index) => <div key={item.key} style={{flexGrow: Number(item.share_percent), background: `var(--chart-${Math.min(index, 5)})`}} title={`${item.label} ${item.share_percent}%`} />)}</div>
        <div className="allocation-inline">{dashboard.review.asset_allocation.table_items.map((item, index) => <div key={item.key}><i style={{background: `var(--chart-${Math.min(index, 5)})`}} /><span>{item.label}</span><strong>{formatCurrency(item.amount)}</strong><small>{item.share_percent}%</small></div>)}</div>
        <CompositionNote composition={dashboard.review.asset_allocation} />
      </Section>
      <div className="overview-columns">
      {trend}
      <Section title="全部股票配置">
        <div className="review-module-heading review-section-intro">
          <div>
            <Caption1>台股與美股合併</Caption1>

          </div>
          <strong>{formatCurrency(dashboard.review.stock_allocation.total)}</strong>
        </div>
        <StockPieChart composition={dashboard.review.stock_allocation} />
        <AllocationTable composition={dashboard.review.stock_allocation} kind="stock" ariaLabel="台美股持倉占比明細" />
        <CompositionNote composition={dashboard.review.stock_allocation} />
      </Section>

      </div>
      <div className="overview-columns">
      <Section
        title="消費去向"
        action={
          <div className="review-range" aria-label="消費期間">
            {(Object.keys(RANGE_LABELS) as ReviewSpendingRange[]).map((range) => (
              <Button
                appearance={spendingRange === range ? "primary" : "subtle"}
                key={range}
                onClick={() => setSpendingRange(range)}
                size="small"
              >
                {RANGE_LABELS[range]}
              </Button>
            ))}
          </div>
        }
      >
        <div className="review-module-heading review-section-intro">
          <div>
            <Caption1>
              {dashboard.review.spending.range_semantics[spendingRange]} · {spending.transaction_count}
              筆正式消費
            </Caption1>

          </div>
          <strong>{formatCurrency(spending.total)}</strong>
        </div>
        <div className="spending-bars">{spending.table_items.slice(0, 5).map((item, index) => <div key={item.key}><div><span>{item.label}</span><strong>{formatCurrency(item.amount)}</strong><small>{item.share_percent}%</small></div><div className="spending-track"><i style={{width: `${item.share_percent}%`, background: `var(--chart-${index})`}} /></div></div>)}</div>
        {spending.table_items.length === 0 ? <EmptyState title="尚無消費" body="此期間尚無可比較的消費資料。" /> : null}
        <details className="overview-details"><summary>全部消費明細（{spending.table_items.length}）</summary><AllocationTable composition={spending} kind="spending" ariaLabel="消費去向明細" /></details>
        <CompositionNote composition={spending} />
      </Section>

      <BrokerAccountState broker={dashboard.broker} />

      </div>

      <details open className="overview-details"><summary>估值與資料依據 · {qualityLabel(dashboard.quality)}</summary>
      <Section title="估值與資料依據">
        <div className="evidence-strip">
          <div><Caption1>總覽品質</Caption1><Badge appearance="tint">{qualityLabel(dashboard.quality)}</Badge></div>
          <div><Caption1>價格時間</Caption1><strong>{formatDate(dashboard.valuation.price_as_of_max)}</strong></div>
          <div><Caption1>KGI 讀取</Caption1><strong>{brokerActive ? qualityLabel(dashboard.broker.status) : "未啟用"}</strong></div>
          <div><Caption1>USD/TWD</Caption1><strong>{dashboard.broker.fx?.rate != null ? `${dashboard.broker.fx.rate}` : "目前不可用"}</strong></div>
          {dashboard.broker.native_market_values.USD != null ? (
            <div>
              <Caption1>美股原幣市值</Caption1>
              <strong>{formatCurrencyAmount(dashboard.broker.native_market_values.USD, "USD")}</strong>
            </div>
          ) : null}
        </div>
      </Section>

      </details>
      <details open className="overview-details"><summary>最近交易（{dashboard.recent_transactions.length}）</summary>
      <Section title="最近交易">
        {dashboard.recent_transactions.length === 0 ? (
          <EmptyState title="尚無交易" body="從手機記錄並同步後，正式入帳的交易會出現在這裡。" />
        ) : (
          <div className="table-scroll">
            <Table aria-label="最近交易">
              <TableHeader><TableRow>
                <TableHeaderCell>時間</TableHeaderCell><TableHeaderCell>分類</TableHeaderCell>
                <TableHeaderCell>備註</TableHeaderCell>
                <TableHeaderCell>來源</TableHeaderCell><TableHeaderCell>狀態</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {dashboard.recent_transactions.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{formatDate(item.occurred_at)}</TableCell>
                    <TableCell><Text weight="semibold">{item.category ?? "未分類"}</Text></TableCell>
                    <TableCell>{item.note ?? item.description}</TableCell>
                    <TableCell>{item.source}</TableCell>
                    <TableCell>
                      <Badge
                        appearance="tint"
                        color={item.status === "reversed" ? "warning" : "success"}
                      >
                        {item.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
      </details>
    </div>
  );
}
