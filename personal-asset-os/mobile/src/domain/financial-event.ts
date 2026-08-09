export const OUTBOX_SCHEMA_VERSION = 1;

export type FinancialEventKind = 'expense' | 'income';
export type OutboxStatus = 'pending' | 'syncing' | 'synced' | 'needs_review' | 'failed';

export interface CaptureInput {
  eventKind: FinancialEventKind;
  occurredAt: string;
  amount: string;
  description: string;
  merchant?: string | null;
  note?: string | null;
  paymentHint?: string | null;
}

export interface MobileEventPayload extends CaptureInput {
  schemaVersion: typeof OUTBOX_SCHEMA_VERSION;
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
  const description = input.description.trim();
  if (!description) {
    throw new CaptureValidationError('請輸入這筆記錄的描述');
  }
  if (description.length > 240) {
    throw new CaptureValidationError('描述不可超過 240 個字');
  }
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new CaptureValidationError('發生時間格式不正確');
  }

  return {
    eventKind: input.eventKind,
    occurredAt: occurredAt.toISOString(),
    amount: normalizeMoneyInput(input.amount),
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
    merchant: payload.merchant ?? null,
    note: payload.note ?? null,
    payment_hint: payload.paymentHint ?? null,
    source: payload.source,
    device_id: payload.deviceId,
    local_sequence: payload.localSequence,
    idempotency_key: payload.idempotencyKey,
  });
}

export function formatTwd(amount: string): string {
  return new Intl.NumberFormat('zh-TW', {
    style: 'currency',
    currency: 'TWD',
    maximumFractionDigits: 2,
  }).format(Number(amount));
}
