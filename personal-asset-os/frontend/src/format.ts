import type { DecimalValue } from "./types";

const currency = new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  maximumFractionDigits: 0,
});

const decimal = new Intl.NumberFormat("zh-TW", {
  maximumFractionDigits: 6,
});

const dateTime = new Intl.DateTimeFormat("zh-TW", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function numericValue(value: DecimalValue | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatCurrency(value: DecimalValue | null | undefined): string {
  const parsed = numericValue(value);
  return parsed == null ? "缺少資料" : currency.format(parsed);
}

export function formatDecimal(value: DecimalValue | null | undefined): string {
  const parsed = numericValue(value);
  return parsed == null ? "缺少資料" : decimal.format(parsed);
}

export function formatDate(value: string | null | undefined): string {
  return value ? dateTime.format(new Date(value)) : "尚無時間";
}

export function qualityLabel(value: string | null | undefined): string {
  if (!value) return "讀取中";
  return {
    not_initialized: "尚未初始化",
    complete: "資料完整",
    complete_manual: "手動估值完整",
    partial: "部分資料",
    unreconciled: "尚未對帳",
    mixed: "多項待處理",
    manual: "手動價格",
    stale: "價格過舊",
    missing: "缺少價格",
  }[value] ?? value;
}

export function valuationPolicyLabel(value: string): string {
  if (value === "manual prices older than 7 calendar days are marked stale") {
    return "手動價格超過 7 個日曆日即標示為過舊";
  }
  return value;
}

export function localDateTimeValue(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function toIso(value: string): string {
  return new Date(value).toISOString();
}
