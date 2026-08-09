import type { SQLiteDatabase } from 'expo-sqlite';

export const MOBILE_DATABASE_NAME = 'personal_asset_os_mobile.db';
export const MOBILE_DATABASE_VERSION = 1;

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = versionRow?.user_version ?? 0;

  if (currentVersion > MOBILE_DATABASE_VERSION) {
    throw new Error(
      `手機資料庫版本 ${currentVersion} 高於 App 支援版本 ${MOBILE_DATABASE_VERSION}`,
    );
  }
  if (currentVersion === 0) {
    try {
      await db.execAsync(`
        BEGIN IMMEDIATE;

        CREATE TABLE app_metadata (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE outbox_events (
          id TEXT PRIMARY KEY NOT NULL,
          schema_version INTEGER NOT NULL,
          event_kind TEXT NOT NULL CHECK (event_kind IN ('expense', 'income')),
          occurred_at TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          amount TEXT NOT NULL,
          currency TEXT NOT NULL CHECK (currency = 'TWD'),
          description TEXT NOT NULL,
          merchant TEXT,
          note TEXT,
          payment_hint TEXT,
          source TEXT NOT NULL CHECK (source = 'mobile_sync'),
          device_id TEXT NOT NULL,
          local_sequence INTEGER NOT NULL CHECK (local_sequence > 0),
          idempotency_key TEXT NOT NULL UNIQUE,
          payload_hash TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'syncing', 'synced', 'needs_review', 'failed')
          ),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          last_error TEXT,
          synced_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (device_id, local_sequence)
        );

        CREATE INDEX ix_outbox_events_status_created
        ON outbox_events (status, created_at DESC);

        PRAGMA user_version = 1;
        COMMIT;
      `);
    } catch (error) {
      await db.execAsync('ROLLBACK;').catch(() => undefined);
      throw error;
    }
  }
}
