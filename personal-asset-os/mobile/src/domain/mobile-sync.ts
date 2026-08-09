import type { OutboxEvent } from './financial-event';

export const MOBILE_API_BASE_URL = 'http://127.0.0.1:8876/api/mobile';

export type SyncFailureStatus = 'failed' | 'needs_review';

export interface MobileEventAck {
  event?: {
    id?: unknown;
    created?: unknown;
    status?: unknown;
  };
  accepted_payload_hash?: unknown;
  ingest_only?: unknown;
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
  if (
    ack.event?.id !== event.id ||
    ack.accepted_payload_hash !== event.payloadHash ||
    ack.ingest_only !== true
  ) {
    throw new Error('桌面端同步確認與手機記錄不一致');
  }
}

export function classifyHttpFailure(status: number): SyncFailureStatus {
  return status === 409 || status === 422 ? 'needs_review' : 'failed';
}
