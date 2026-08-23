import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  AppButton,
  BrandHeader,
  InfoCallout,
  KindSegment,
  PaperCard,
  PaperScreen,
  TextField,
} from '@/src/components/ui';
import { createOutboxEvent, listCaptureCategories } from '@/src/storage/outbox';
import { autoSyncOutbox } from '@/src/services/mobile-connection';
import {
  CaptureValidationError,
  type CategorySuggestion,
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
  const [category, setCategory] = useState('');
  const [categoryOptions, setCategoryOptions] = useState<CategorySuggestion[]>([]);
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const pendingCaptureRef = useRef<PendingCapture | null>(null);

  const visibleCategoryOptions = useMemo(() => {
    const query = category.trim().toLocaleLowerCase('zh-TW');
    if (!query) return categoryOptions;
    const exactMatch = categoryOptions.some(
      (option) => option.value.toLocaleLowerCase('zh-TW') === query,
    );
    if (exactMatch) return categoryOptions;
    return categoryOptions.filter((option) =>
      option.value.toLocaleLowerCase('zh-TW').includes(query),
    );
  }, [category, categoryOptions]);

  const loadCategories = useCallback(async () => {
    setCategoryOptions(await listCaptureCategories(db, kind));
  }, [db, kind]);

  useFocusEffect(
    useCallback(() => {
      void loadCategories();
    }, [loadCategories]),
  );

  function changeCaptureValue(setValue: (value: string) => void, value: string) {
    pendingCaptureRef.current = null;
    setValue(value);
  }

  function resetErrors() {
    setAmountError(null);
    setCategoryError(null);
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
      categoryHint: category,
      description,
    };
    try {
      normalizeCaptureInput(input);
    } catch (error) {
      pendingCaptureRef.current = null;
      const message = error instanceof Error ? error.message : '請檢查輸入內容';
      if (message.includes('金額')) setAmountError(message);
      else if (message.includes('分類')) setCategoryError(message);
      else if (message.includes('描述')) setDescriptionError(message);
      else setFormError(message);
      return;
    }

    Keyboard.dismiss();
    setCategoryMenuOpen(false);
    setSaving(true);
    try {
      const { event } = await createOutboxEvent(db, input, {
        requestId: pendingCapture.requestId,
      });
      pendingCaptureRef.current = null;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setAmount('');
      setDescription('');
      void autoSyncOutbox(db).catch(() => undefined);
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
        subtitle="先安全存到手機；USB 可用時會立即送到桌面並計入活動資金。"
      />

      <KindSegment
        value={kind}
        onChange={(value) => {
          pendingCaptureRef.current = null;
          setKind(value);
          setCategory('');
          setCategoryMenuOpen(false);
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
          onFocus={() => setCategoryMenuOpen(false)}
          error={amountError}
        />
        <TextField
          label="分類"
          value={category}
          onChangeText={(value) => changeCaptureValue(setCategory, value)}
          onFocus={() => setCategoryMenuOpen(true)}
          placeholder="例如：吃飯、油費，也可以自訂"
          error={categoryError}
          rightAccessory={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={categoryMenuOpen ? '收合分類選單' : '展開分類選單'}
              accessibilityState={{ expanded: categoryMenuOpen }}
              hitSlop={10}
              onPress={() => {
                Keyboard.dismiss();
                setCategoryMenuOpen((open) => !open);
              }}
              style={styles.categoryMenuButton}>
              <MaterialCommunityIcons
                name={categoryMenuOpen ? 'chevron-up' : 'chevron-down'}
                size={26}
                color={palette.cocoaMuted}
              />
            </Pressable>
          }
        />
        {categoryMenuOpen ? (
          <View style={styles.categoryDropdown} accessibilityRole="list">
            <Text style={styles.categoryDropdownTitle}>常用分類 · 依使用次數排序</Text>
            <ScrollView
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              style={styles.categoryDropdownScroll}>
              {visibleCategoryOptions.map((option, index) => {
                const selected = category === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`分類：${option.value}${option.usageCount ? `，使用 ${option.usageCount} 次` : ''}`}
                    onPress={() => {
                      changeCaptureValue(setCategory, option.value);
                      setCategoryMenuOpen(false);
                      Keyboard.dismiss();
                    }}
                    style={({ pressed }) => [
                      styles.categoryOption,
                      index > 0 && styles.categoryOptionDivider,
                      selected && styles.categoryOptionSelected,
                      pressed && styles.categoryOptionPressed,
                    ]}>
                    <View style={styles.categoryOptionCopy}>
                      <Text style={styles.categoryOptionLabel}>{option.value}</Text>
                      <Text style={styles.categoryOptionMeta}>
                        {option.usageCount > 0 ? `使用 ${option.usageCount} 次` : '預設分類'}
                      </Text>
                    </View>
                    {selected ? (
                      <MaterialCommunityIcons name="check" size={22} color={palette.caramelDark} />
                    ) : null}
                  </Pressable>
                );
              })}
              {visibleCategoryOptions.length === 0 ? (
                <View style={styles.categoryEmptyState}>
                  <Text style={styles.categoryOptionLabel}>建立「{category.trim()}」</Text>
                  <Text style={styles.categoryOptionMeta}>保存這筆記錄後會加入分類選單。</Text>
                </View>
              ) : null}
            </ScrollView>
          </View>
        ) : null}
        <Text style={styles.categoryHelp}>
          可從下拉選單挑選；直接輸入的新分類保存後，也會按使用次數加入排序。
        </Text>
        <TextField
          label="描述（選填）"
          value={description}
          onChangeText={(value) => changeCaptureValue(setDescription, value)}
          placeholder="例如：跟同事聚餐、加 95 無鉛"
          returnKeyType="done"
          onFocus={() => setCategoryMenuOpen(false)}
          error={descriptionError}
        />

        {formError ? (
          <View accessibilityRole="alert" style={styles.errorBox}>
            <Text style={styles.errorTitle}>沒有保存</Text>
            <Text style={styles.errorBody}>{formError}</Text>
          </View>
        ) : null}

        <AppButton
          label="保存到手機"
          icon="bookmark-outline"
          onPress={() => void save()}
          loading={saving}
        />
        <Text style={styles.boundaryCopy}>
          尚未同步時不會改變資產；桌面確認正式入帳後，手機才會標記同步成功。
        </Text>
      </PaperCard>

      <InfoCallout
        title="離線也能記"
        body="電腦未開機或連線中斷時，SQLite 會保留記錄；之後可透過 USB 安全重送。"
        icon="shield-lock-outline"
      />
    </PaperScreen>
  );
}

const styles = StyleSheet.create({
  formCard: { gap: spacing.md },
  categoryMenuButton: {
    width: 38,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryDropdown: {
    marginTop: -spacing.xs,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surfaceMuted,
    borderRadius: 14,
    overflow: 'hidden',
  },
  categoryDropdownTitle: {
    ...typeStyles.caption,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontWeight: '700',
  },
  categoryDropdownScroll: { maxHeight: 248 },
  categoryOption: {
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  categoryOptionDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  categoryOptionSelected: { backgroundColor: palette.canvasStrong },
  categoryOptionPressed: { opacity: 0.72 },
  categoryOptionCopy: { flex: 1, gap: spacing.xxs },
  categoryOptionLabel: { color: palette.cocoa, fontSize: 16, fontWeight: '700' },
  categoryOptionMeta: { ...typeStyles.caption },
  categoryEmptyState: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.xxs },
  categoryHelp: { ...typeStyles.caption, marginTop: -spacing.xs },
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
