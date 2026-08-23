import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptureValidationError,
  buildCaptureIdempotencyKey,
  buildIdempotencyKey,
  buildMobileEventPayload,
  normalizeCaptureInput,
  normalizeMoneyInput,
  rankCategorySuggestions,
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
      occurredAt: '2026-08-09T04:30:00.000Z',
      amount: '180.00',
      categoryHint: ' 吃飯 ',
      description: ' 拉麵 ',
      merchant: '巷口麵店',
    },
    id: '57c08ea3-40da-4fb7-a4e0-791811fc28e4',
    capturedAt: '2026-08-09T04:31:00.000Z',
    deviceId: 'b50ab705-f4e4-4313-9b6e-e16f37ea94f8',
    localSequence: 1,
  });

  assert.equal(payload.amount, '180');
  assert.equal(payload.categoryHint, '吃飯');
  assert.equal(payload.description, '拉麵');
  assert.equal(payload.source, 'mobile_sync');
  assert.equal(
    payload.idempotencyKey,
    buildIdempotencyKey(
      'b50ab705-f4e4-4313-9b6e-e16f37ea94f8',
      1,
      '57c08ea3-40da-4fb7-a4e0-791811fc28e4',
    ),
  );
  assert.equal(
    serializeMobileEventPayload(payload),
    '{"schema_version":3,"id":"57c08ea3-40da-4fb7-a4e0-791811fc28e4","event_kind":"expense","occurred_at":"2026-08-09T04:30:00.000Z","captured_at":"2026-08-09T04:31:00.000Z","amount":"180","currency":"TWD","description":"拉麵","category_hint":"吃飯","merchant":"巷口麵店","note":null,"payment_hint":null,"source":"mobile_sync","device_id":"b50ab705-f4e4-4313-9b6e-e16f37ea94f8","local_sequence":1,"idempotency_key":"mobile:b50ab705-f4e4-4313-9b6e-e16f37ea94f8:1:57c08ea3-40da-4fb7-a4e0-791811fc28e4"}',
  );
});

test('requires a category while allowing an empty supplemental description', () => {
  const normalized = normalizeCaptureInput({
    eventKind: 'expense',
    occurredAt: '2026-08-09T08:00:00.000Z',
    amount: '95',
    categoryHint: '油費',
    description: '   ',
  });
  assert.equal(normalized.description, '');
  assert.throws(
    () => normalizeCaptureInput({ ...normalized, categoryHint: ' ' }),
    CaptureValidationError,
  );
});

test('ranks categories by usage count, then recency, and keeps defaults selectable', () => {
  const suggestions = rankCategorySuggestions('expense', [
    { value: '寵物', usageCount: 2, lastUsedAt: '2026-08-20T08:00:00.000Z' },
    { value: '吃飯', usageCount: 3, lastUsedAt: '2026-08-18T08:00:00.000Z' },
    { value: '油費', usageCount: 2, lastUsedAt: '2026-08-21T08:00:00.000Z' },
    { value: ' 寵物 ', usageCount: 1, lastUsedAt: '2026-08-22T08:00:00.000Z' },
  ]);

  assert.deepEqual(
    suggestions.map(({ value, usageCount }) => ({ value, usageCount })),
    [
      { value: '寵物', usageCount: 3 },
      { value: '吃飯', usageCount: 3 },
      { value: '油費', usageCount: 2 },
      { value: '日用品', usageCount: 0 },
      { value: '交通', usageCount: 0 },
      { value: '娛樂', usageCount: 0 },
      { value: '醫療', usageCount: 0 },
    ],
  );
  assert.deepEqual(
    rankCategorySuggestions('income', [], 2).map(({ value }) => value),
    ['薪資', '獎金'],
  );
});

test('builds a stable capture idempotency key for retries', () => {
  assert.equal(
    buildCaptureIdempotencyKey('device-123', 'request-456'),
    'mobile-capture:device-123:request-456',
  );
});
