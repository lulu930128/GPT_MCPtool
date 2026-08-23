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
  qualityLabel,
} from "../format";
import type {
  Dashboard,
  ReviewComposition,
  ReviewCompositionItem,
  ReviewSpendingRange,
} from "../types";
import { EmptyState, Section } from "./Common";
import { DonutChart } from "./DonutChart";

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
  return (
    <div className="composition-note">
      <Caption1>{composition.policy}</Caption1>
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
      <section className="review-hero" aria-labelledby="review-title">
        <div className="review-ledger">
          <Caption1 className="review-eyebrow">
            PERSONAL REVIEW · {formatDate(dashboard.review.as_of)}
          </Caption1>
          <h1 id="review-title">資產複盤</h1>
          <p>把活動資金、股票、負債與本月流量放在同一張個人資產表上，先看金額，再看占比。</p>
          <dl className="balance-sheet">
            <div><dt>總資產</dt><dd>{formatCurrency(dashboard.review.summary.gross_assets)}</dd></div>
            <div><dt>信用與其他負債</dt><dd className="negative">− {formatCurrency(dashboard.review.summary.debt)}</dd></div>
            <div className="balance-total"><dt>暫估淨資產</dt><dd>{formatCurrency(dashboard.review.summary.provisional_net_worth)}</dd></div>
            <div><dt>活動資金</dt><dd>{formatCurrency(dashboard.metrics.liquid_cash)}</dd></div>
            <div><dt>本月收入</dt><dd>{formatCurrency(dashboard.metrics.monthly_income)}</dd></div>
            <div><dt>本月支出</dt><dd>{formatCurrency(dashboard.metrics.monthly_expense)}</dd></div>
          </dl>
          {Number(dashboard.review.summary.unpriced_investment_cost) > 0 ? (
            <Caption1 className="review-footnote">
              總資產含 {formatCurrency(dashboard.review.summary.unpriced_investment_cost)}
              缺價成本替代值；圓餅圖不納入。
            </Caption1>
          ) : null}
        </div>
        <div className="review-hero-chart">
          <div className="review-module-heading">
            <div><Caption1>全部資產</Caption1><h2>資產配置</h2></div>
            <Badge
              appearance="tint"
              color={dashboard.review.asset_allocation.status === "complete" ? "success" : "warning"}
            >
              {qualityLabel(dashboard.review.asset_allocation.status)}
            </Badge>
          </div>
          <DonutChart
            composition={dashboard.review.asset_allocation}
            centerLabel="資產合計"
            ariaLabel="活動資金、股票與其他資產占比"
          />
          <AllocationTable
            composition={dashboard.review.asset_allocation}
            kind="asset"
            ariaLabel="資產配置明細"
          />
          <CompositionNote composition={dashboard.review.asset_allocation} />
        </div>
      </section>

      <Section title="全部股票配置">
        <div className="review-module-heading review-section-intro">
          <div>
            <Caption1>台股與美股合併</Caption1>
            <p>以可追溯的 TWD 市值比較每檔持股；美股缺 FX 時保留持倉，但不進占比分母。</p>
          </div>
          <strong>{formatCurrency(dashboard.review.stock_allocation.total)}</strong>
        </div>
        <div className="allocation-layout">
          <DonutChart
            composition={dashboard.review.stock_allocation}
            centerLabel="股票市值"
            ariaLabel="台股與美股合併持倉占比"
          />
          <AllocationTable
            composition={dashboard.review.stock_allocation}
            kind="stock"
            ariaLabel="台美股持倉占比明細"
          />
        </div>
        <CompositionNote composition={dashboard.review.stock_allocation} />
      </Section>

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
            <p>同一分類、店家或描述會合併，金額仍以正式帳本為準。</p>
          </div>
          <strong>{formatCurrency(spending.total)}</strong>
        </div>
        <div className="allocation-layout">
          <DonutChart
            composition={spending}
            centerLabel={RANGE_LABELS[spendingRange]}
            ariaLabel={`${RANGE_LABELS[spendingRange]}消費去向占比`}
          />
          <AllocationTable
            composition={spending}
            kind="spending"
            ariaLabel={`${RANGE_LABELS[spendingRange]}消費去向明細`}
          />
        </div>
        <CompositionNote composition={spending} />
      </Section>

      {trend}

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
    </div>
  );
}
