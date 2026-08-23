import type { OutboxEvent } from './financial-event';

export const MOBILE_API_BASE_URL = 'http://127.0.0.1:18876/api/mobile';

export type SyncFailureStatus = 'failed' | 'needs_review';

export interface MobileEventAck {
  event?: {
    id?: unknown;
    created?: unknown;
    status?: unknown;
    approval_source?: unknown;
    transaction_ids?: unknown;
  };
  transaction?: {
    id?: unknown;
    created?: unknown;
  };
  accepted_payload_hash?: unknown;
  write_mode?: unknown;
  auto_finalized?: unknown;
  ingest_only?: unknown;
}

export interface MobileSessionSummary {
  activityFundReady: boolean;
  candidateCount: number;
}

export function buildMobileIngestRequest(event: OutboxEvent): Record<string, unknown> {
  const payload: unknown = JSON.parse(event.payloadJson);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('手機 outbox payload 格式已損壞');
  }
  return { ...(payload as Record<string, unknown>), payload_hash: event.payloadHash };
}

export function validateMobileEventAck(event: OutboxEvent, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('桌面端回應格式不正確');
  }
  const ack = value as MobileEventAck;
  if (ack.event?.id !== event.id || ack.accepted_payload_hash !== event.payloadHash) {
    throw new Error('桌面端同步確認與手機記錄不一致');
  }
  if (event.schemaVersion === 1) {
    if (
      ack.event.status !== 'pending_match' ||
      ack.write_mode !== 'legacy_staging' ||
      ack.auto_finalized !== false ||
      ack.ingest_only !== true
    ) {
      throw new Error('舊版手機記錄沒有安全進入桌面待處理區');
    }
    return;
  }
  if (
    ack.event.status !== 'matched' ||
    ack.event.approval_source !== 'paired_mobile' ||
    typeof ack.transaction?.id !== 'string' ||
    !Array.isArray(ack.event.transaction_ids) ||
    !ack.event.transaction_ids.includes(ack.transaction.id) ||
    ack.write_mode !== 'single_activity_fund' ||
    ack.auto_finalized !== true
  ) {
    throw new Error('桌面端正式入帳確認與手機記錄不一致');
  }
}

export function classifyHttpFailure(status: number): SyncFailureStatus {
  return status === 409 || status === 422 ? 'needs_review' : 'failed';
}

export function validateMobileSession(
  expectedDeviceId: string,
  value: unknown,
): MobileSessionSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('桌面端連線檢查格式不正確');
  }
  const session = value as {
    device?: { id?: unknown; status?: unknown };
    activity_fund?: {
      write_mode?: unknown;
      ready?: unknown;
      candidate_count?: unknown;
    };
  };
  if (session.device?.id !== expectedDeviceId || session.device.status !== 'active') {
    throw new Error('桌面端配對裝置與手機不一致');
  }
  const activityFund = session.activity_fund;
  if (
    activityFund?.write_mode !== 'single_activity_fund' ||
    typeof activityFund.ready !== 'boolean' ||
    typeof activityFund.candidate_count !== 'number'
  ) {
    throw new Error('桌面端活動資金狀態不完整');
  }
  return {
    activityFundReady: activityFund.ready,
    candidateCount: activityFund.candidate_count,
  };
}
