import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppButton, PaperCard, PaperScreen, StatusTag } from '@/src/components/ui';
import { getOutboxEvent } from '@/src/storage/outbox';
import { formatTwd, type OutboxEvent } from '@/src/domain/financial-event';
import { palette, spacing, typeStyles } from '@/src/theme/tokens';

export default function EventDetailScreen() {
  const db = useSQLiteContext();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [event, setEvent] = useState<OutboxEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError('缺少手機記錄 ID');
      setLoading(false);
      return;
    }
    void getOutboxEvent(db, id)
      .then((value) => {
        setEvent(value);
        setError(value ? null : '找不到這筆手機記錄');
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '無法讀取手機記錄');
      })
      .finally(() => setLoading(false));
  }, [db, id]);

  if (loading) {
    return (
      <PaperScreen contentStyle={styles.centerContent}>
        <ActivityIndicator size="large" color={palette.caramel} />
        <Text style={typeStyles.body}>正在確認 SQLite 記錄…</Text>
      </PaperScreen>
    );
  }

  if (!event || error) {
    return (
      <PaperScreen>
        <TopBar />
        <PaperCard style={styles.errorCard}>
          <MaterialCommunityIcons name="notebook-remove-outline" size={38} color={palette.danger} />
          <Text style={typeStyles.section}>無法顯示記錄</Text>
          <Text style={typeStyles.body}>{error ?? '找不到資料'}</Text>
          <AppButton label="回待同步" onPress={() => router.replace('/outbox')} />
        </PaperCard>
      </PaperScreen>
    );
  }

  const happenedAt = new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(event.occurredAt));

  return (
    <PaperScreen>
      <TopBar />
      <View style={styles.successHero}>
        <View style={styles.successMark}>
          <MaterialCommunityIcons name="check" size={48} color={palette.sage} />
        </View>
        <Text style={styles.successTitle}>已安全保存</Text>
        <Text style={[typeStyles.body, styles.successCopy]}>
          這筆記錄已寫入手機 SQLite；等配對完成後，才會經加密通道交給桌面驗證。
        </Text>
      </View>

      <PaperCard style={styles.detailCard}>
        <DetailRow icon="swap-vertical" label="類型" value={event.eventKind === 'expense' ? '支出' : '收入'} />
        <DetailRow icon="cash" label="金額" value={formatTwd(event.amount)} />
        <DetailRow icon="pencil-outline" label="描述" value={event.description} />
        <DetailRow icon="clock-outline" label="時間" value={happenedAt} />
        <DetailRow icon="wallet-outline" label="帳戶" value="尚未選擇" />
        <View style={styles.statusRow}>
          <View style={styles.detailIcon}>
            <MaterialCommunityIcons name="cloud-outline" size={20} color={palette.cocoaMuted} />
          </View>
          <Text style={styles.detailLabel}>同步狀態</Text>
          <StatusTag status={event.status} />
        </View>
      </PaperCard>

      <View style={styles.actions}>
        <AppButton
          label="再記一筆"
          icon="pencil-outline"
          onPress={() => router.replace('/')}
        />
        <AppButton
          label="查看待同步"
          icon="cloud-upload-outline"
          variant="secondary"
          onPress={() => router.replace('/outbox')}
        />
      </View>
    </PaperScreen>
  );
}

function TopBar() {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={() => router.back()} style={styles.topBar}>
      <MaterialCommunityIcons name="arrow-left" size={25} color={palette.cocoa} />
      <Text style={styles.topBarTitle}>記錄內容</Text>
    </Pressable>
  );
}

function DetailRow({ icon, label, value }: { icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailIcon}>
        <MaterialCommunityIcons name={icon} size={20} color={palette.cocoaMuted} />
      </View>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text numberOfLines={2} style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centerContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  topBarTitle: { color: palette.cocoa, fontSize: 21, fontWeight: '800' },
  successHero: { alignItems: 'center', gap: spacing.sm },
  successMark: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: palette.sageSoft,
    borderWidth: 1,
    borderColor: palette.sage,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: { ...typeStyles.title, fontSize: 31 },
  successCopy: { maxWidth: 350, textAlign: 'center' },
  detailCard: { paddingVertical: spacing.sm },
  detailRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  detailIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: palette.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailLabel: { width: 72, color: palette.cocoaMuted, fontSize: 15, fontWeight: '600' },
  detailValue: { flex: 1, textAlign: 'right', color: palette.cocoa, fontSize: 15, fontWeight: '800' },
  statusRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actions: { gap: spacing.sm },
  errorCard: { alignItems: 'center', gap: spacing.sm, borderColor: palette.danger },
});
