export const LEGACY_OUTBOX_SCHEMA_VERSION = 1;
export const PREVIOUS_OUTBOX_SCHEMA_VERSION = 2;
export const OUTBOX_SCHEMA_VERSION = 3;
export type OutboxSchemaVersion =
  | typeof LEGACY_OUTBOX_SCHEMA_VERSION
  | typeof PREVIOUS_OUTBOX_SCHEMA_VERSION
  | typeof OUTBOX_SCHEMA_VERSION;

export type FinancialEventKind = 'expense' | 'income';
export type OutboxStatus = 'pending' | 'syncing' | 'synced' | 'needs_review' | 'failed';

export interface CaptureInput {
  eventKind: FinancialEventKind;
  occurredAt: string;
  amount: string;
  categoryHint: string;
  description: string;
  merchant?: string | null;
  note?: string | null;
  paymentHint?: string | null;
}

export interface MobileEventPayload extends CaptureInput {
  schemaVersion: OutboxSchemaVersion;
  id: string;
  currency: 'TWD';
  capturedAt: string;
  source: 'mobile_sync';
  deviceId: string;
  localSequence: number;
  idempotencyKey: string;
}

export interface OutboxEvent extends MobileEventPayload {
  payloadHash: string;
  payloadJson: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryUsage {
  value: string;
  usageCount: number;
  lastUsedAt: string | null;
}

export interface CategorySuggestion extends CategoryUsage {
  isDefault: boolean;
}

export class CaptureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureValidationError';
  }
}

function cleanOptional(value: string | null | undefined, maxLength: number): string | null {
  const cleaned = value?.trim() ?? '';
  if (!cleaned) return null;
  if (cleaned.length > maxLength) {
    throw new CaptureValidationError(`內容不可超過 ${maxLength} 個字`);
  }
  return cleaned;
}

export function normalizeMoneyInput(rawValue: string): string {
  const normalized = rawValue.trim().replaceAll(',', '');
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) {
    throw new CaptureValidationError('金額必須是正數，且小數最多兩位');
  }

  const [wholeRaw, fractionRaw = ''] = normalized.split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '');
  const fraction = fractionRaw.replace(/0+$/, '');
  if (whole.length > 12) {
    throw new CaptureValidationError('金額超過手機快速記錄上限');
  }
  if (/^0+$/.test(whole) && !fraction) {
    throw new CaptureValidationError('金額必須大於零');
  }
  return fraction ? `${whole}.${fraction}` : whole;
}

export function normalizeCaptureInput(input: CaptureInput): CaptureInput {
  const categoryHint = input.categoryHint.trim();
  if (!categoryHint) {
    throw new CaptureValidationError('請選擇或輸入分類');
  }
  if (categoryHint.length > 120) {
    throw new CaptureValidationError('分類不可超過 120 個字');
  }
  const description = cleanOptional(input.description, 240) ?? '';
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new CaptureValidationError('發生時間格式不正確');
  }

  return {
    eventKind: input.eventKind,
    occurredAt: occurredAt.toISOString(),
    amount: normalizeMoneyInput(input.amount),
    categoryHint,
    description,
    merchant: cleanOptional(input.merchant, 120),
    note: cleanOptional(input.note, 500),
    paymentHint: cleanOptional(input.paymentHint, 120),
  };
}

export function buildIdempotencyKey(deviceId: string, localSequence: number, eventId: string): string {
  return `mobile:${deviceId}:${localSequence}:${eventId}`;
}

export function buildCaptureIdempotencyKey(deviceId: string, requestId: string): string {
  return `mobile-capture:${deviceId}:${requestId}`;
}

export function buildMobileEventPayload(args: {
  input: CaptureInput;
  id: string;
  capturedAt: string;
  deviceId: string;
  localSequence: number;
  idempotencyKey?: string;
}): MobileEventPayload {
  const input = normalizeCaptureInput(args.input);
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    id: args.id,
    eventKind: input.eventKind,
    occurredAt: input.occurredAt,
    capturedAt: new Date(args.capturedAt).toISOString(),
    amount: input.amount,
    currency: 'TWD',
    categoryHint: input.categoryHint,
    description: input.description,
    merchant: input.merchant ?? null,
    note: input.note ?? null,
    paymentHint: input.paymentHint ?? null,
    source: 'mobile_sync',
    deviceId: args.deviceId,
    localSequence: args.localSequence,
    idempotencyKey:
      args.idempotencyKey ?? buildIdempotencyKey(args.deviceId, args.localSequence, args.id),
  };
}

export function serializeMobileEventPayload(payload: MobileEventPayload): string {
  return JSON.stringify({
    schema_version: payload.schemaVersion,
    id: payload.id,
    event_kind: payload.eventKind,
    occurred_at: payload.occurredAt,
    captured_at: payload.capturedAt,
    amount: payload.amount,
    currency: payload.currency,
    description: payload.description,
    ...(payload.schemaVersion >= 3 ? { category_hint: payload.categoryHint } : {}),
    merchant: payload.merchant ?? null,
    note: payload.note ?? null,
    payment_hint: payload.paymentHint ?? null,
    source: payload.source,
    device_id: payload.deviceId,
    local_sequence: payload.localSequence,
    idempotency_key: payload.idempotencyKey,
  });
}

const DEFAULT_CAPTURE_CATEGORIES: Record<FinancialEventKind, readonly string[]> = {
  expense: ['吃飯', '油費', '日用品', '交通', '娛樂', '醫療'],
  income: ['薪資', '獎金', '退款', '其他收入'],
};

export function rankCategorySuggestions(
  eventKind: FinancialEventKind,
  usage: readonly CategoryUsage[],
  limit = 30,
): CategorySuggestion[] {
  const defaultOrder = new Map(
    DEFAULT_CAPTURE_CATEGORIES[eventKind].map((value, index) => [
      value.toLocaleLowerCase('zh-TW'),
      index,
    ]),
  );
  const suggestions = new Map<string, CategorySuggestion>();

  for (const value of DEFAULT_CAPTURE_CATEGORIES[eventKind]) {
    suggestions.set(value.toLocaleLowerCase('zh-TW'), {
      value,
      usageCount: 0,
      lastUsedAt: null,
      isDefault: true,
    });
  }

  for (const item of usage) {
    const value = item.value.trim();
    const key = value.toLocaleLowerCase('zh-TW');
    if (!value || !Number.isFinite(item.usageCount) || item.usageCount <= 0) continue;
    const existing = suggestions.get(key);
    suggestions.set(key, {
      value: existing?.value ?? value,
      usageCount: (existing?.usageCount ?? 0) + Math.floor(item.usageCount),
      lastUsedAt:
        !existing?.lastUsedAt || (item.lastUsedAt && item.lastUsedAt > existing.lastUsedAt)
          ? item.lastUsedAt
          : existing.lastUsedAt,
      isDefault: existing?.isDefault ?? false,
    });
  }

  return [...suggestions.values()]
    .sort((left, right) => {
      if (left.usageCount !== right.usageCount) return right.usageCount - left.usageCount;
      const recentCompare = (right.lastUsedAt ?? '').localeCompare(left.lastUsedAt ?? '');
      if (recentCompare !== 0) return recentCompare;
      const leftDefaultOrder = defaultOrder.get(left.value.toLocaleLowerCase('zh-TW'));
      const rightDefaultOrder = defaultOrder.get(right.value.toLocaleLowerCase('zh-TW'));
      if (leftDefaultOrder !== undefined || rightDefaultOrder !== undefined) {
        return (leftDefaultOrder ?? Number.MAX_SAFE_INTEGER) -
          (rightDefaultOrder ?? Number.MAX_SAFE_INTEGER);
      }
      return left.value.localeCompare(right.value, 'zh-TW');
    })
    .slice(0, Math.max(1, limit));
}

export function formatTwd(amount: string): string {
  return new Intl.NumberFormat('zh-TW', {
    style: 'currency',
    currency: 'TWD',
    maximumFractionDigits: 2,
  }).format(Number(amount));
}
