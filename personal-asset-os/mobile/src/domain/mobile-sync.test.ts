import assert from 'node:assert/strict';
import test from 'node:test';

import type { OutboxEvent } from './financial-event';
import {
  buildMobileIngestRequest,
  classifyHttpFailure,
  validateMobileEventAck,
} from './mobile-sync';

const event: OutboxEvent = {
  schemaVersion: 1,
  id: '57c08ea3-40da-4fb7-a4e0-791811fc28e4',
  eventKind: 'expense',
  occurredAt: '2026-08-09T04:30:00.000Z',
  capturedAt: '2026-08-09T04:31:00.000Z',
  amount: '180',
  currency: 'TWD',
  description: '拉麵',
  merchant: null,
  note: null,
  paymentHint: null,
  source: 'mobile_sync',
  deviceId: 'device-1',
  localSequence: 1,
  idempotencyKey: 'mobile:device-1:1:event-1',
  payloadHash: 'a'.repeat(64),
  payloadJson:
    '{"schema_version":1,"id":"57c08ea3-40da-4fb7-a4e0-791811fc28e4","event_kind":"expense"}',
  status: 'pending',
  attempts: 0,
  lastError: null,
  syncedAt: null,
  createdAt: '2026-08-09T04:31:00.000Z',
  updatedAt: '2026-08-09T04:31:00.000Z',
};

test('adds the transport hash without mutating the canonical payload', () => {
  const request = buildMobileIngestRequest(event);
  assert.equal(request.id, event.id);
  assert.equal(request.payload_hash, event.payloadHash);
  assert.equal(JSON.parse(event.payloadJson).payload_hash, undefined);
});

test('accepts only an ingest-only acknowledgement for the same event and hash', () => {
  assert.doesNotThrow(() =>
    validateMobileEventAck(event, {
      event: { id: event.id, created: true, status: 'pending_match' },
      accepted_payload_hash: event.payloadHash,
      ingest_only: true,
    }),
  );
  assert.throws(() =>
    validateMobileEventAck(event, {
      event: { id: 'different' },
      accepted_payload_hash: event.payloadHash,
      ingest_only: true,
    }),
  );
});

test('routes contract errors to review and transient errors to retry', () => {
  assert.equal(classifyHttpFailure(409), 'needs_review');
  assert.equal(classifyHttpFailure(422), 'needs_review');
  assert.equal(classifyHttpFailure(500), 'failed');
  assert.equal(classifyHttpFailure(401), 'failed');
});
