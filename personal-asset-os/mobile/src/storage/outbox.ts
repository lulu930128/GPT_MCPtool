import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  type CaptureInput,
  type CategorySuggestion,
  type FinancialEventKind,
  type OutboxEvent,
  type OutboxSchemaVersion,
  type OutboxStatus,
  LEGACY_OUTBOX_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION,
  PREVIOUS_OUTBOX_SCHEMA_VERSION,
  buildCaptureIdempotencyKey,
  buildMobileEventPayload,
  normalizeCaptureInput,
  rankCategorySuggestions,
  serializeMobileEventPayload,
} from '@/src/domain/financial-event';
import { MOBILE_DATABASE_VERSION } from '@/src/storage/database';

interface OutboxRow {
  id: string;
  schema_version: number;
  event_kind: FinancialEventKind;
  occurred_at: string;
  captured_at: string;
  amount: string;
  currency: 'TWD';
  description: string;
  category_hint: string | null;
  merchant: string | null;
  note: string | null;
  payment_hint: string | null;
  source: 'mobile_sync';
  device_id: string;
  local_sequence: number;
  idempotency_key: string;
  payload_hash: string;
  payload_json: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutboxSummary {
  total: number;
  pending: number;
  synced: number;
  needsReview: number;
  failed: number;
}

export interface MobileDatabaseInfo extends OutboxSummary {
  databaseVersion: number;
  deviceId: string;
}

function rowToEvent(row: OutboxRow): OutboxEvent {
  if (
    row.schema_version !== LEGACY_OUTBOX_SCHEMA_VERSION &&
    row.schema_version !== PREVIOUS_OUTBOX_SCHEMA_VERSION &&
    row.schema_version !== OUTBOX_SCHEMA_VERSION
  ) {
    throw new Error(`不支援的手機事件 schema version：${row.schema_version}`);
  }
  return {
    schemaVersion: row.schema_version as OutboxSchemaVersion,
    id: row.id,
    eventKind: row.event_kind,
    occurredAt: row.occurred_at,
    capturedAt: row.captured_at,
    amount: row.amount,
    currency: row.currency,
    categoryHint: row.category_hint ?? '',
    description: row.description,
    merchant: row.merchant,
    note: row.note,
    paymentHint: row.payment_hint,
    source: row.source,
    deviceId: row.device_id,
    localSequence: row.local_sequence,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    payloadJson: row.payload_json,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowMatchesCaptureInput(row: OutboxRow, input: CaptureInput): boolean {
  const normalized = normalizeCaptureInput(input);
  return (
    row.event_kind === normalized.eventKind &&
    row.occurred_at === normalized.occurredAt &&
    row.amount === normalized.amount &&
    row.category_hint === normalized.categoryHint &&
    row.description === normalized.description &&
    row.merchant === (normalized.merchant ?? null) &&
    row.note === (normalized.note ?? null) &&
    row.payment_hint === (normalized.paymentHint ?? null)
  );
}

export interface CreateOutboxEventOptions {
  requestId?: string;
}

export async function getOrCreateDeviceId(db: SQLiteDatabase): Promise<string> {
  const existing = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM app_metadata WHERE key = 'device_id'",
  );
  if (existing?.value) return existing.value;

  const now = new Date().toISOString();
  const candidate = Crypto.randomUUID();
  await db.runAsync(
    `INSERT INTO app_metadata (key, value, updated_at)
     VALUES ('device_id', ?, ?)
     ON CONFLICT (key) DO NOTHING`,
    candidate,
    now,
  );
  const stored = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM app_metadata WHERE key = 'device_id'",
  );
  if (!stored?.value) throw new Error('無法建立手機裝置識別碼');
  return stored.value;
}

async function takeNextSequence(db: SQLiteDatabase): Promise<number> {
  const existing = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM app_metadata WHERE key = 'local_sequence'",
  );
  const current = existing ? Number.parseInt(existing.value, 10) : 0;
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error('手機 local sequence 已損壞');
  }
  const next = current + 1;
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_metadata (key, value, updated_at)
     VALUES ('local_sequence', ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    String(next),
    now,
  );
  return next;
}

export async function createOutboxEvent(
  db: SQLiteDatabase,
  input: CaptureInput,
  options: CreateOutboxEventOptions = {},
): Promise<{ event: OutboxEvent; created: boolean }> {
  const deviceId = await getOrCreateDeviceId(db);
  const requestId = options.requestId ?? Crypto.randomUUID();
  const idempotencyKey = buildCaptureIdempotencyKey(deviceId, requestId);
  let result: { event: OutboxEvent; created: boolean } | undefined;

  await db.withExclusiveTransactionAsync(async (transaction) => {
    const existing = await transaction.getFirstAsync<OutboxRow>(
      'SELECT * FROM outbox_events WHERE idempotency_key = ?',
      idempotencyKey,
    );
    if (existing) {
      if (!rowMatchesCaptureInput(existing, input)) {
        throw new Error('相同 idempotency key 對應不同手機記錄');
      }
      result = { event: rowToEvent(existing), created: false };
      return;
    }

    const localSequence = await takeNextSequence(transaction);
    const id = requestId;
    const capturedAt = new Date().toISOString();
    const payload = buildMobileEventPayload({
      input,
      id,
      capturedAt,
      deviceId,
      localSequence,
      idempotencyKey,
    });
    const payloadJson = serializeMobileEventPayload(payload);
    const payloadHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      payloadJson,
      { encoding: Crypto.CryptoEncoding.HEX },
    );

    await transaction.runAsync(
      `INSERT INTO outbox_events (
        id, schema_version, event_kind, occurred_at, captured_at, amount, currency,
        description, category_hint, merchant, note, payment_hint, source, device_id, local_sequence,
        idempotency_key, payload_hash, payload_json, status, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      payload.id,
      payload.schemaVersion,
      payload.eventKind,
      payload.occurredAt,
      payload.capturedAt,
      payload.amount,
      payload.currency,
      payload.description,
      payload.categoryHint,
      payload.merchant ?? null,
      payload.note ?? null,
      payload.paymentHint ?? null,
      payload.source,
      payload.deviceId,
      payload.localSequence,
      payload.idempotencyKey,
      payloadHash,
      payloadJson,
      capturedAt,
      capturedAt,
    );
    const inserted = await transaction.getFirstAsync<OutboxRow>(
      'SELECT * FROM outbox_events WHERE id = ?',
      id,
    );
    if (!inserted) throw new Error('手機記錄沒有寫入 SQLite');
    result = { event: rowToEvent(inserted), created: true };
  });

  if (!result) throw new Error('手機記錄交易沒有產生結果');
  return result;
}

export async function getOutboxEvent(
  db: SQLiteDatabase,
  eventId: string,
): Promise<OutboxEvent | null> {
  const row = await db.getFirstAsync<OutboxRow>('SELECT * FROM outbox_events WHERE id = ?', eventId);
  return row ? rowToEvent(row) : null;
}

export async function listOutboxEvents(
  db: SQLiteDatabase,
  limit = 100,
): Promise<OutboxEvent[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const rows = await db.getAllAsync<OutboxRow>(
    'SELECT * FROM outbox_events ORDER BY created_at DESC LIMIT ?',
    safeLimit,
  );
  return rows.map(rowToEvent);
}

export async function listCaptureCategories(
  db: SQLiteDatabase,
  eventKind: FinancialEventKind,
): Promise<CategorySuggestion[]> {
  const rows = await db.getAllAsync<{
    category_hint: string;
    usage_count: number;
    last_used_at: string | null;
  }>(
    `SELECT category_hint, COUNT(*) AS usage_count, MAX(created_at) AS last_used_at
     FROM outbox_events
     WHERE event_kind = ? AND category_hint IS NOT NULL AND TRIM(category_hint) <> ''
     GROUP BY category_hint
     ORDER BY usage_count DESC, last_used_at DESC
     LIMIT 100`,
    eventKind,
  );
  return rankCategorySuggestions(
    eventKind,
    rows.map((row) => ({
      value: row.category_hint,
      usageCount: row.usage_count,
      lastUsedAt: row.last_used_at,
    })),
  );
}

export async function listSyncCandidates(
  db: SQLiteDatabase,
  limit = 50,
  includeFailed = true,
): Promise<OutboxEvent[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const statuses = includeFailed
    ? "('pending', 'syncing', 'failed')"
    : "('pending', 'syncing')";
  const rows = await db.getAllAsync<OutboxRow>(
    `SELECT * FROM outbox_events
     WHERE status IN ${statuses}
     ORDER BY local_sequence ASC
     LIMIT ?`,
    safeLimit,
  );
  return rows.map(rowToEvent);
}

export async function beginSyncAttempt(db: SQLiteDatabase, eventId: string): Promise<void> {
  const now = new Date().toISOString();
  const result = await db.runAsync(
    `UPDATE outbox_events
     SET status = 'syncing', attempts = attempts + 1, last_error = NULL, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'syncing', 'failed')`,
    now,
    eventId,
  );
  if (result.changes !== 1) {
    throw new Error('待同步記錄狀態已變更，請重新整理');
  }
}

export async function markSyncSucceeded(
  db: SQLiteDatabase,
  eventId: string,
  syncedAt = new Date().toISOString(),
): Promise<void> {
  const result = await db.runAsync(
    `UPDATE outbox_events
     SET status = 'synced', last_error = NULL, synced_at = ?, updated_at = ?
     WHERE id = ? AND status = 'syncing'`,
    syncedAt,
    syncedAt,
    eventId,
  );
  if (result.changes !== 1) throw new Error('無法完成待同步記錄狀態');
}

export async function markSyncFailed(
  db: SQLiteDatabase,
  eventId: string,
  status: Extract<OutboxStatus, 'failed' | 'needs_review'>,
  message: string,
): Promise<void> {
  const now = new Date().toISOString();
  const safeMessage = message.trim().slice(0, 500) || '同步失敗';
  const result = await db.runAsync(
    `UPDATE outbox_events
     SET status = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'syncing'`,
    status,
    safeMessage,
    now,
    eventId,
  );
  if (result.changes !== 1) throw new Error('無法保存同步失敗狀態');
}

export async function getOutboxSummary(db: SQLiteDatabase): Promise<OutboxSummary> {
  const rows = await db.getAllAsync<{ status: OutboxStatus; count: number }>(
    'SELECT status, COUNT(*) AS count FROM outbox_events GROUP BY status',
  );
  const counts = new Map(rows.map((row) => [row.status, row.count]));
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    pending: (counts.get('pending') ?? 0) + (counts.get('syncing') ?? 0),
    synced: counts.get('synced') ?? 0,
    needsReview: counts.get('needs_review') ?? 0,
    failed: counts.get('failed') ?? 0,
  };
}

export async function getMobileDatabaseInfo(db: SQLiteDatabase): Promise<MobileDatabaseInfo> {
  const [deviceId, summary, versionRow] = await Promise.all([
    getOrCreateDeviceId(db),
    getOutboxSummary(db),
    db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'),
  ]);
  return {
    ...summary,
    databaseVersion: versionRow?.user_version ?? MOBILE_DATABASE_VERSION,
    deviceId,
  };
}
