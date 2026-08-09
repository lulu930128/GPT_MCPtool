import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  AppButton,
  BrandHeader,
  InfoCallout,
  KindSegment,
  PaperCard,
  PaperScreen,
  TextField,
} from '@/src/components/ui';
import { createOutboxEvent } from '@/src/storage/outbox';
import {
  CaptureValidationError,
  type FinancialEventKind,
  normalizeCaptureInput,
} from '@/src/domain/financial-event';
import { palette, spacing, typeStyles } from '@/src/theme/tokens';

interface PendingCapture {
  requestId: string;
  occurredAt: string;
}

export default function CaptureScreen() {
  const db = useSQLiteContext();
  const [kind, setKind] = useState<FinancialEventKind>('expense');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [merchant, setMerchant] = useState('');
  const [note, setNote] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const pendingCaptureRef = useRef<PendingCapture | null>(null);

  function changeCaptureValue(setValue: (value: string) => void, value: string) {
    pendingCaptureRef.current = null;
    setValue(value);
  }

  function resetErrors() {
    setAmountError(null);
    setDescriptionError(null);
    setFormError(null);
  }

  async function save() {
    resetErrors();
    const pendingCapture = pendingCaptureRef.current ?? {
      requestId: Crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    };
    pendingCaptureRef.current = pendingCapture;
    const input = {
      eventKind: kind,
      occurredAt: pendingCapture.occurredAt,
      amount,
      description,
      merchant,
      note,
    };
    try {
      normalizeCaptureInput(input);
    } catch (error) {
      pendingCaptureRef.current = null;
      const message = error instanceof Error ? error.message : '請檢查輸入內容';
      if (message.includes('金額')) setAmountError(message);
      else if (message.includes('描述')) setDescriptionError(message);
      else setFormError(message);
      return;
    }

    Keyboard.dismiss();
    setSaving(true);
    try {
      const { event } = await createOutboxEvent(db, input, {
        requestId: pendingCapture.requestId,
      });
      pendingCaptureRef.current = null;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setAmount('');
      setDescription('');
      setMerchant('');
      setNote('');
      router.push({ pathname: '/event/[id]', params: { id: event.id } });
    } catch (error) {
      const message =
        error instanceof CaptureValidationError || error instanceof Error
          ? error.message
          : '手機沒有保存這筆記錄';
      setFormError(message);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <PaperScreen>
      <BrandHeader
        title="輕鬆記一筆"
        subtitle="先把當下記下來，帳務整理可以慢慢來。"
      />

      <KindSegment
        value={kind}
        onChange={(value) => {
          pendingCaptureRef.current = null;
          setKind(value);
        }}
      />

      <PaperCard style={styles.formCard}>
        <TextField
          label="金額"
          prefix="NT$"
          value={amount}
          onChangeText={(value) => changeCaptureValue(setAmount, value)}
          placeholder="0"
          keyboardType="decimal-pad"
          inputMode="decimal"
          error={amountError}
        />
        <TextField
          label="描述"
          value={description}
          onChangeText={(value) => changeCaptureValue(setDescription, value)}
          placeholder="例如：拉麵、咖啡、交通費"
          returnKeyType="done"
          error={descriptionError}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showMore }}
          onPress={() => setShowMore((current) => !current)}
          style={styles.moreButton}>
          <Text style={styles.moreLabel}>{showMore ? '收起更多資料' : '加入店家或備註'}</Text>
          <Text style={styles.moreSymbol}>{showMore ? '−' : '+'}</Text>
        </Pressable>

        {showMore ? (
          <View style={styles.moreFields}>
            <TextField
              label="店家（選填）"
              value={merchant}
              onChangeText={(value) => changeCaptureValue(setMerchant, value)}
              placeholder="例如：巷口麵店"
            />
            <TextField
              label="備註（選填）"
              value={note}
              onChangeText={(value) => changeCaptureValue(setNote, value)}
              placeholder="想補充的細節"
              multiline
            />
          </View>
        ) : null}

        {formError ? (
          <View accessibilityRole="alert" style={styles.errorBox}>
            <Text style={styles.errorTitle}>沒有保存</Text>
            <Text style={styles.errorBody}>{formError}</Text>
          </View>
        ) : null}

        <AppButton
          label="先記著"
          icon="bookmark-outline"
          onPress={() => void save()}
          loading={saving}
        />
        <Text style={styles.boundaryCopy}>
          這一版只會安全保存到手機待同步匣，不會直接改變正式資產與收支。
        </Text>
      </PaperCard>

      <InfoCallout
        title="離線也能記"
        body="即使電腦未開機或網路中斷，SQLite 仍會保留記錄；配對與加密同步將在下一階段開放。"
        icon="shield-lock-outline"
      />
    </PaperScreen>
  );
}

const styles = StyleSheet.create({
  formCard: { gap: spacing.md },
  moreButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: palette.border,
  },
  moreLabel: { ...typeStyles.caption, color: palette.cocoa, fontWeight: '700' },
  moreSymbol: { color: palette.caramelDark, fontSize: 24, fontWeight: '500' },
  moreFields: { gap: spacing.md },
  errorBox: {
    borderRadius: 14,
    backgroundColor: '#F5D7D1',
    padding: spacing.md,
    gap: spacing.xxs,
  },
  errorTitle: { color: palette.danger, fontSize: 15, fontWeight: '800' },
  errorBody: { color: palette.cocoaMuted, fontSize: 14, lineHeight: 20 },
  boundaryCopy: { ...typeStyles.caption, textAlign: 'center' },
});
