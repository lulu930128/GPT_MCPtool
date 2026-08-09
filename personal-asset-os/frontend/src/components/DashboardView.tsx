import {
  Badge,
  Caption1,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from "@fluentui/react-components";
import type { Dashboard } from "../types";
import { formatCurrency, formatDate, numericValue, qualityLabel, valuationPolicyLabel } from "../format";
import { EmptyState, MetricCard, Section } from "./Common";

export function DashboardView({ dashboard }: { dashboard: Dashboard }) {
  const partial = dashboard.valuation.missing_count > 0;
  return (
    <div className="view-stack">
      <div className="metric-grid">
        <MetricCard
          label="暫估淨資產"
          value={dashboard.metrics.provisional_net_worth}
          note={`資料時間 ${formatDate(dashboard.as_of)}`}
          quality={partial ? "partial" : "good"}
        />
        <MetricCard
          label="可用現金"
          value={dashboard.metrics.available_cash}
          note={`已扣除負債與保留 ${formatCurrency(dashboard.metrics.reserved_cash)}`}
          quality={(numericValue(dashboard.metrics.available_cash) ?? 0) < 0 ? "warning" : "good"}
        />
        <MetricCard
          label="投資市值"
          value={dashboard.metrics.investment_market_value}
          note={`缺價 ${dashboard.valuation.missing_count}，舊價 ${dashboard.valuation.stale_count}`}
          quality={dashboard.valuation.missing_count || dashboard.valuation.stale_count ? "warning" : "good"}
        />
        <MetricCard
          label="信用與其他負債"
          value={dashboard.metrics.debt}
          note={`未對帳差額 ${formatCurrency(dashboard.metrics.unresolved_total)}`}
          quality={dashboard.metrics.unresolved_count ? "warning" : "good"}
        />
      </div>

      <Section title="日常記錄狀態">
        <div className="capture-summary">
          <div><Caption1>待處理</Caption1><strong>{dashboard.capture.pending_count}</strong></div>
          <div><Caption1>需檢查</Caption1><strong>{dashboard.capture.needs_review_count}</strong></div>
          <div><Caption1>尚未入帳金額</Caption1><strong>{formatCurrency(dashboard.capture.pending_amount)}</strong></div>
          <Text>待處理金額不會混入正式淨資產與本月收支。</Text>
        </div>
      </Section>

      {dashboard.warnings.length ? (
        <div className="warning-stack">
          {dashboard.warnings.map((warning) => (
            <MessageBar intent="warning" key={warning}>
              <MessageBarBody><MessageBarTitle>資料提醒</MessageBarTitle>{warning}</MessageBarBody>
            </MessageBar>
          ))}
        </div>
      ) : null}

      <div className="split-grid">
        <Section title="本月資金變化">
          <dl className="definition-grid">
            <div><dt>收入</dt><dd>{formatCurrency(dashboard.metrics.monthly_income)}</dd></div>
            <div><dt>支出</dt><dd>{formatCurrency(dashboard.metrics.monthly_expense)}</dd></div>
            <div><dt>流動現金</dt><dd>{formatCurrency(dashboard.metrics.liquid_cash)}</dd></div>
            <div><dt>投資帳面成本</dt><dd>{formatCurrency(dashboard.metrics.investment_book_value)}</dd></div>
          </dl>
        </Section>
        <Section title="估值依據">
          <dl className="definition-grid">
            <div><dt>最早價格</dt><dd>{formatDate(dashboard.valuation.price_as_of_min)}</dd></div>
            <div><dt>最新價格</dt><dd>{formatDate(dashboard.valuation.price_as_of_max)}</dd></div>
            <div><dt>估值品質</dt><dd><Badge appearance="tint">{qualityLabel(dashboard.quality)}</Badge></dd></div>
            <div><dt>政策</dt><dd><Caption1>{valuationPolicyLabel(dashboard.valuation.policy)}</Caption1></dd></div>
          </dl>
        </Section>
      </div>

      <Section title="最近交易">
        {dashboard.recent_transactions.length === 0 ? (
          <EmptyState title="尚無交易" body="先到帳戶頁建立帳戶，再新增期初餘額或第一筆收入。" />
        ) : (
          <div className="table-scroll">
            <Table aria-label="最近交易">
              <TableHeader><TableRow>
                <TableHeaderCell>時間</TableHeaderCell><TableHeaderCell>描述</TableHeaderCell>
                <TableHeaderCell>來源</TableHeaderCell><TableHeaderCell>狀態</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {dashboard.recent_transactions.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{formatDate(item.occurred_at)}</TableCell>
                    <TableCell><Text weight="semibold">{item.description}</Text></TableCell>
                    <TableCell>{item.source}</TableCell>
                    <TableCell><Badge appearance="tint" color={item.status === "reversed" ? "warning" : "success"}>{item.status}</Badge></TableCell>
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
