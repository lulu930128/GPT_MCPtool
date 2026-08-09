import {
  Badge,
  Body1,
  Button,
  Card,
  Caption1,
  makeStyles,
  Skeleton,
  SkeletonItem,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwise24Regular } from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { formatCurrency } from "../format";
import type { DecimalValue } from "../types";

const useStyles = makeStyles({
  metricCard: {
    padding: tokens.spacingHorizontalL,
    minHeight: "118px",
    display: "grid",
    alignContent: "space-between",
    borderRadius: tokens.borderRadiusLarge,
  },
  metricValue: {
    fontSize: tokens.fontSizeHero700,
    lineHeight: tokens.lineHeightHero700,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.025em",
  },
  metricFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
  },
  empty: {
    minHeight: "180px",
    display: "grid",
    placeItems: "center",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalXXL,
  },
  loading: {
    display: "grid",
    gap: tokens.spacingVerticalM,
  },
});

export function MetricCard({
  label,
  value,
  note,
  quality,
}: {
  label: string;
  value: DecimalValue;
  note: string;
  quality?: "good" | "warning" | "partial";
}) {
  const styles = useStyles();
  return (
    <Card className={styles.metricCard} appearance="outline">
      <Caption1>{label}</Caption1>
      <div className={styles.metricValue}>{formatCurrency(value)}</div>
      <div className={styles.metricFooter}>
        <Caption1>{note}</Caption1>
        {quality ? (
          <Badge
            appearance="tint"
            color={quality === "good" ? "success" : quality === "warning" ? "warning" : "informative"}
          >
            {quality === "good" ? "完整" : quality === "warning" ? "注意" : "部分"}
          </Badge>
        ) : null}
      </div>
    </Card>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  const styles = useStyles();
  return (
    <div className={styles.empty}>
      <div>
        <div><Body1><strong>{title}</strong></Body1></div>
        <Caption1>{body}</Caption1>
      </div>
    </div>
  );
}

export function LoadingState() {
  const styles = useStyles();
  return (
    <Skeleton className={styles.loading} aria-label="正在讀取資產資料">
      <SkeletonItem size={32} />
      <SkeletonItem size={96} />
      <SkeletonItem size={96} />
      <SkeletonItem size={32} />
    </Skeleton>
  );
}

export function ReloadButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <Button icon={<ArrowClockwise24Regular />} appearance="subtle" onClick={onClick} disabled={disabled}>
      重新整理
    </Button>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="app-section">
      <div className="section-heading">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
