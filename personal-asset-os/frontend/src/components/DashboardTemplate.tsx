import type { ReactNode } from "react";
import { Section } from "./Common";

/** Layout only: never manufacture a zero balance or a market observation. */
export function DashboardTemplate({ trend, failed }: { trend: ReactNode; failed: boolean }) {
  const message = failed ? "資料尚未載入，請重新整理重試" : "正在讀取最新資料…";
  return <div className="view-stack review-dashboard" aria-label="資產總覽載入框架">
    <header className="overview-heading"><h1>資產複盤</h1><span role="status">{message}</span></header>
    <dl className="overview-metrics">{["暫估淨資產", "活動資金", "e財庫現金", "股票市值", "信用與其他負債"].map(label => <div key={label}><dt>{label}</dt><dd aria-label="尚未取得">—</dd></div>)}</dl>
    <div className="overview-flow"><span>本月收入 —</span><span>本月支出 —</span><span>總資產 —</span></div>
    <Section title="資產配置"><div className="template-chart" /><p>{message}</p></Section>
    <div className="overview-columns">{trend}<Section title="全部股票配置"><div className="template-stock"><span>現價 —</span><span>股數 —</span><span>市值 —</span></div><p>{message}</p></Section></div>
    <div className="overview-columns"><Section title="消費去向"><p>{message}</p></Section><Section title="KGI 券商帳務"><p>{message}</p></Section></div>
  </div>;
}
