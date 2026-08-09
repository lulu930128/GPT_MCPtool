import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptureValidationError,
  buildCaptureIdempotencyKey,
  buildIdempotencyKey,
  buildMobileEventPayload,
  normalizeMoneyInput,
  serializeMobileEventPayload,
} from './financial-event';

test('normalizes decimal money without using float as storage truth', () => {
  assert.equal(normalizeMoneyInput('001,280.50'), '1280.5');
  assert.equal(normalizeMoneyInput('95'), '95');
  assert.equal(normalizeMoneyInput('0.01'), '0.01');
});

test('rejects zero, negative, malformed and over-precise money', () => {
  for (const value of ['0', '0.00', '-10', '1.234', 'coffee']) {
    assert.throws(() => normalizeMoneyInput(value), CaptureValidationError);
  }
});

test('builds a stable, desktop-shaped mobile capture payload', () => {
  const payload = buildMobileEventPayload({
    input: {
      eventKind: 'expense',
      occurredAt: '2026-08-09T08:00:00.000Z',
      amount: '280.00',
      description: ' 拉麵 ',
    },
    id: 'event-1',
    capturedAt: '2026-08-09T08:01:00.000Z',
    deviceId: 'device-1',
    localSequence: 7,
  });

  assert.equal(payload.amount, '280');
  assert.equal(payload.description, '拉麵');
  assert.equal(payload.source, 'mobile_sync');
  assert.equal(payload.idempotencyKey, buildIdempotencyKey('device-1', 7, 'event-1'));
  assert.equal(
    serializeMobileEventPayload(payload),
    '{"schema_version":1,"id":"event-1","event_kind":"expense","occurred_at":"2026-08-09T08:00:00.000Z","captured_at":"2026-08-09T08:01:00.000Z","amount":"280","currency":"TWD","description":"拉麵","merchant":null,"note":null,"payment_hint":null,"source":"mobile_sync","device_id":"device-1","local_sequence":7,"idempotency_key":"mobile:device-1:7:event-1"}',
  );
});

test('builds a stable capture idempotency key for retries', () => {
  assert.equal(
    buildCaptureIdempotencyKey('device-123', 'request-456'),
    'mobile-capture:device-123:request-456',
  );
});
