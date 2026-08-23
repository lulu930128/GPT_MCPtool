import type { CSSProperties } from "react";
import { formatCurrency, numericValue } from "../format";
import type { ReviewComposition } from "../types";

const COLORS = ["#67a7ff", "#e1ae5a", "#7db39b", "#c98ba2", "#8f9ec2", "#717987"];
const RADIUS = 82;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function DonutChart({
  composition,
  centerLabel,
  ariaLabel,
}: {
  composition: ReviewComposition;
  centerLabel: string;
  ariaLabel: string;
}) {
  const total = numericValue(composition.total) ?? 0;
  if (total <= 0 || composition.chart_items.length === 0) {
    return (
      <div className="donut-empty" role="img" aria-label={`${ariaLabel}：目前沒有可顯示資料`}>
        <strong>尚無資料</strong>
        <span>有正式金額後會開始累積占比。</span>
      </div>
    );
  }

  const segments = composition.chart_items.map((item, index) => {
    const share = Math.max(0, Math.min(numericValue(item.share_percent) ?? 0, 100));
    const length = CIRCUMFERENCE * (share / 100);
    const precedingShare = composition.chart_items
      .slice(0, index)
      .reduce((sum, preceding) => sum + (numericValue(preceding.share_percent) ?? 0), 0);
    return {
      item,
      color: COLORS[index % COLORS.length],
      length,
      offset: CIRCUMFERENCE * (precedingShare / 100),
    };
  });

  return (
    <figure className="donut-figure" aria-label={ariaLabel}>
      <div className="donut-canvas">
        <svg viewBox="0 0 240 240" role="img" aria-label={ariaLabel}>
          <circle className="donut-track" cx="120" cy="120" r={RADIUS} />
          {segments.map(({ item, color, length, offset: segmentOffset }) => (
            <circle
              className="donut-segment"
              cx="120"
              cy="120"
              r={RADIUS}
              key={item.key}
              pathLength={CIRCUMFERENCE}
              stroke={color}
              strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
              strokeDashoffset={-segmentOffset}
              transform="rotate(-90 120 120)"
            >
              <title>{`${item.label}：${formatCurrency(item.amount)}，${item.share_percent}%`}</title>
            </circle>
          ))}
        </svg>
        <div className="donut-center">
          <span>{centerLabel}</span>
          <strong>{formatCurrency(composition.total)}</strong>
        </div>
      </div>
      <figcaption className="donut-legend">
        {composition.chart_items.map((item, index) => (
          <span key={item.key}>
            <i style={{ "--legend-color": COLORS[index % COLORS.length] } as CSSProperties} />
            <b>{item.label}</b>
            <em>{item.share_percent}%</em>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
