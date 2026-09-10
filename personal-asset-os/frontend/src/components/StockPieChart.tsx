import { formatCurrency, numericValue } from "../format";
import type { ReviewComposition } from "../types";

export function StockPieChart({ composition }: { composition: ReviewComposition }) {
  const total = numericValue(composition.total);
  const items = composition.chart_items.filter(item => (numericValue(item.amount) ?? 0) > 0);
  const sum = items.reduce((value, item) => value + (numericValue(item.amount) ?? 0), 0);
  const slices = items.map((item, index) => {
    const preceding = items.slice(0, index).reduce((value, row) => value + (numericValue(row.amount) ?? 0), 0);
    const start = -Math.PI / 2 + preceding / sum * Math.PI * 2;
    const angle = start + ((numericValue(item.amount) ?? 0) / sum) * Math.PI * 2;
    const path = `M 160 100 L ${160 + 125 * Math.cos(start)} ${100 + 72 * Math.sin(start)} A 125 72 0 ${angle - start > Math.PI ? 1 : 0} 1 ${160 + 125 * Math.cos(angle)} ${100 + 72 * Math.sin(angle)} Z`;
    return { item, path, color: `var(--chart-${index % 6})` };
  });
  const usable = total !== null && total > 0 && sum > 0;
  return <figure className="stock-pie">
    <svg viewBox="0 0 320 205" role="img" aria-label={usable ? "股票市值占比，立體圓餅圖" : total === 0 ? "股票市值為零，透明圓餅輪廓" : "股票估值不可用"}>
      {usable ? <>
        <g transform="translate(0 13)" style={{filter: "brightness(0.72)"}} aria-hidden="true">{slices.map(({item, path, color}) => slices.length === 1 ? <ellipse key={item.key} cx="160" cy="100" rx="125" ry="72" fill={color} /> : <path key={item.key} d={path} fill={color} />)}</g>
        {slices.map(({item, path, color}) => <g key={item.key}><title>{`${item.label}：${formatCurrency(item.amount)} · ${item.share_percent}%`}</title>{slices.length === 1 ? <ellipse cx="160" cy="100" rx="125" ry="72" fill={color} /> : <path d={path} fill={color} stroke="var(--colorNeutralBackground1)" strokeWidth="1" />}</g>)}
      </> : <g fill="none" stroke="var(--colorNeutralStroke1)" strokeDasharray="5 4" opacity="0.5"><ellipse cx="160" cy="113" rx="125" ry="72" /><ellipse cx="160" cy="100" rx="125" ry="72" /></g>}
    </svg>
    <figcaption>{usable ? slices.map(({item, color}) => <span key={item.key}><i style={{background:color}} />{item.symbol ?? item.label} <strong>{item.share_percent}%</strong></span>) : <span>{total === 0 ? "市值為 0，尚無可分配占比" : "估值資料不足"}</span>}</figcaption>
  </figure>;
}
