import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  MOBILE_API_BASE_URL,
  buildMobileIngestRequest,
  classifyHttpFailure,
  validateMobileEventAck,
} from '@/src/domain/mobile-sync';
import {
  beginSyncAttempt,
  getOrCreateDeviceId,
  listSyncCandidates,
  markSyncFailed,
  markSyncSucceeded,
} from '@/src/storage/outbox';

const DEVICE_TOKEN_KEY = 'personal_asset_os.mobile.device_token.v1';
const REQUEST_TIMEOUT_MS = 12_000;

interface ApiErrorEnvelope {
  error?: { code?: unknown; message?: unknown };
}

interface PairResponse {
  device?: { id?: unknown; display_name?: unknown; status?: unknown };
  token?: unknown;
  token_type?: unknown;
}

export interface ConnectionState {
  paired: boolean;
  deviceId: string;
  endpoint: string;
}

export interface SyncResult {
  attempted: number;
  synced: number;
  needsReview: number;
  failed: number;
  pairingInvalid: boolean;
}

export class MobileApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'MobileApiError';
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('桌面端連線逾時，請確認 USB bridge 與服務狀態');
    }
    throw new Error('無法連到桌面端，請確認 USB 線、ADB bridge 與服務狀態');
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function apiError(response: Response, value: unknown): MobileApiError {
  const envelope = value as ApiErrorEnvelope | null;
  const message =
    typeof envelope?.error?.message === 'string'
      ? envelope.error.message
      : `桌面端拒絕請求（HTTP ${response.status}）`;
  const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : null;
  return new MobileApiError(message, response.status, code);
}

async function readToken(): Promise<string | null> {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error('此裝置無法使用安全憑證儲存空間');
  }
  return SecureStore.getItemAsync(DEVICE_TOKEN_KEY);
}

export async function getConnectionState(db: SQLiteDatabase): Promise<ConnectionState> {
  const [deviceId, token] = await Promise.all([getOrCreateDeviceId(db), readToken()]);
  return { paired: Boolean(token), deviceId, endpoint: MOBILE_API_BASE_URL };
}

export async function pairWithDesktop(
  db: SQLiteDatabase,
  pairingCode: string,
  displayName: string,
): Promise<ConnectionState> {
  const deviceId = await getOrCreateDeviceId(db);
  const response = await fetchWithTimeout(`${MOBILE_API_BASE_URL}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairing_code: pairingCode.trim().toUpperCase(),
      device_id: deviceId,
      display_name: displayName.trim(),
    }),
  });
  const value = await readJson(response);
  if (!response.ok) throw apiError(response, value);
  const result = value as PairResponse | null;
  if (
    result?.device?.id !== deviceId ||
    result.device.status !== 'active' ||
    typeof result.token !== 'string' ||
    result.token.length < 32 ||
    result.token_type !== 'Bearer'
  ) {
    throw new Error('桌面端配對回應不完整，憑證未保存');
  }
  await SecureStore.setItemAsync(DEVICE_TOKEN_KEY, result.token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return { paired: true, deviceId, endpoint: MOBILE_API_BASE_URL };
}

export async function syncOutbox(db: SQLiteDatabase): Promise<SyncResult> {
  const token = await readToken();
  if (!token) throw new Error('尚未與桌面端配對');
  const events = await listSyncCandidates(db);
  const result: SyncResult = {
    attempted: 0,
    synced: 0,
    needsReview: 0,
    failed: 0,
    pairingInvalid: false,
  };

  for (const event of events) {
    await beginSyncAttempt(db, event.id);
    result.attempted += 1;
    try {
      const response = await fetchWithTimeout(`${MOBILE_API_BASE_URL}/events`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildMobileIngestRequest(event)),
      });
      const value = await readJson(response);
      if (!response.ok) throw apiError(response, value);
      validateMobileEventAck(event, value);
      await markSyncSucceeded(db, event.id);
      result.synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : '同步失敗';
      const status = error instanceof MobileApiError ? error.status : 0;
      const failureStatus = classifyHttpFailure(status);
      await markSyncFailed(db, event.id, failureStatus, message);
      if (failureStatus === 'needs_review') result.needsReview += 1;
      else result.failed += 1;
      if (status === 401) {
        result.pairingInvalid = true;
        await SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY);
        break;
      }
    }
  }
  return result;
}
