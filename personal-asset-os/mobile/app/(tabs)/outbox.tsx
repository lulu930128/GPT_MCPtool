import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  AppButton,
  BrandHeader,
  InfoCallout,
  PaperCard,
  PaperScreen,
  SectionTitle,
  StatusTag,
} from '@/src/components/ui';
import { formatTwd, type OutboxEvent } from '@/src/domain/financial-event';
import {
  type ConnectionState,
  getConnectionState,
  syncOutbox,
} from '@/src/services/mobile-connection';
import { listOutboxEvents } from '@/src/storage/outbox';
import { palette, spacing, typeStyles } from '@/src/theme/tokens';

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function eventLabel(event: OutboxEvent): string {
  return event.categoryHint || event.description || '未分類';
}

function connectionCopy(connection: ConnectionState | null): {
  title: string;
  body: string;
  icon: 'usb' | 'alert-circle-outline' | 'cellphone-key';
} {
  if (!connection) {
    return { title: '正在檢查 USB 通道', body: '正在確認桌面服務與活動資金。', icon: 'usb' };
  }
  if (!connection.paired) {
    return {
      title: '先完成桌面配對',
      body: connection.message,
      icon: 'cellphone-key',
    };
  }
  if (connection.transport === 'ready') {
    return {
      title: 'USB 同步通道已就緒',
      body: '待同步記錄會自動送出並計入唯一活動資金；按鈕保留作為手動重送。',
      icon: 'usb',
    };
  }
  if (connection.transport === 'unreachable') {
    return {
      title: '等待 USB 連線',
      body: '配對憑證仍有效；App 在前景時接上 USB 會自動重試，不會遺失手機記錄。',
      icon: 'usb',
    };
  }
  return {
    title: '桌面設定尚未就緒',
    body: connection.message,
    icon: 'alert-circle-outline',
  };
}

export default function OutboxScreen() {
  const db = useSQLiteContext();
  const [events, setEvents] = useState<OutboxEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const [outboxEvents, connectionState] = await Promise.all([
        listOutboxEvents(db),
        getConnectionState(db),
      ]);
      setEvents(outboxEvents);
      setConnection(connectionState);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '無法讀取手機待同步資料');
    }
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function sync() {
    setSyncing(true);
    setLoadError(null);
    setSyncNotice(null);
    try {
      const result = await syncOutbox(db);
      if (result.pairingInvalid) {
        setSyncNotice('桌面端憑證已失效，請重新配對。');
      } else if (result.attempted === 0) {
        setSyncNotice('目前沒有需要傳送的記錄。');
      } else {
        const details = [`已同步 ${result.synced} 筆`];
        if (result.needsReview) details.push(`${result.needsReview} 筆需要確認`);
        if (result.failed) details.push(`${result.failed} 筆傳送失敗`);
        setSyncNotice(details.join('，'));
      }
      await load();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '同步失敗');
    } finally {
      setSyncing(false);
    }
  }

  const retryableCount = events.filter((event) =>
    ['pending', 'syncing', 'failed'].includes(event.status),
  ).length;
  const connectionStatus = connectionCopy(connection);
  const canSync = connection?.transport === 'ready' && retryableCount > 0;

  return (
    <PaperScreen refreshControl={{ refreshing, onRefresh: () => void refresh() }}>
      <BrandHeader
        eyebrow="LOCAL OUTBOX"
        title="待同步"
        subtitle="透過 USB loopback 傳到桌面；收到正式交易確認後才算成功。"
      />

      <InfoCallout
        title={connectionStatus.title}
        body={connectionStatus.body}
        icon={connectionStatus.icon}
      />

      <SectionTitle caption={`共 ${events.length} 筆本機記錄`}>手機記錄</SectionTitle>

      {loadError ? (
        <PaperCard style={styles.errorCard}>
          <MaterialCommunityIcons name="database-alert-outline" size={28} color={palette.danger} />
          <Text style={styles.errorTitle}>操作失敗</Text>
          <Text style={typeStyles.body}>{loadError}</Text>
        </PaperCard>
      ) : events.length ? (
        <View style={styles.eventList}>
          {events.map((event) => (
            <Pressable
              key={event.id}
              accessibilityRole="button"
              accessibilityLabel={`查看 ${eventLabel(event)} ${formatTwd(event.amount)}`}
              onPress={() =>
                router.push({ pathname: '/event/[id]', params: { id: event.id } })
              }>
              <PaperCard style={styles.eventCard}>
                <View style={styles.eventIcon}>
                  <MaterialCommunityIcons
                    name={event.eventKind === 'expense' ? 'arrow-down' : 'arrow-up'}
                    size={22}
                    color={event.eventKind === 'expense' ? palette.caramelDark : palette.sage}
                  />
                </View>
                <View style={styles.eventCopy}>
                  <Text numberOfLines={1} style={styles.eventTitle}>
                    {eventLabel(event)}
                  </Text>
                  {event.categoryHint && event.description ? (
                    <Text numberOfLines={1} style={styles.eventDescription}>
                      {event.description}
                    </Text>
                  ) : null}
                  <Text style={typeStyles.caption}>{formatTime(event.occurredAt)}</Text>
                  <StatusTag status={event.status} />
                  {event.lastError ? (
                    <Text numberOfLines={2} style={styles.eventError}>
                      {event.lastError}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.eventAmount}>
                  {event.eventKind === 'expense' ? '−' : '+'} {formatTwd(event.amount)}
                </Text>
              </PaperCard>
            </Pressable>
          ))}
        </View>
      ) : (
        <PaperCard style={styles.emptyCard}>
          <View style={styles.emptyIcon}>
            <MaterialCommunityIcons name="notebook-outline" size={34} color={palette.sage} />
          </View>
          <Text style={typeStyles.section}>待同步匣還是空的</Text>
          <Text style={[typeStyles.body, styles.emptyCopy]}>先去記一筆，離線資料會出現在這裡。</Text>
          <AppButton label="去記一筆" icon="pencil-outline" onPress={() => router.push('/')} />
        </PaperCard>
      )}

      <PaperCard style={styles.syncCard}>
        <View style={styles.syncRow}>
          <MaterialCommunityIcons
            name={connection?.paired ? 'shield-sync-outline' : 'cellphone-key'}
            size={27}
            color={connection?.paired ? palette.sage : palette.cocoaMuted}
          />
          <View style={styles.syncCopy}>
            <Text style={styles.syncTitle}>
              {connection?.transport === 'ready'
                ? `${retryableCount} 筆可傳送`
                : connection?.paired
                  ? `${retryableCount} 筆等待連線`
                  : '尚未保存桌面端憑證'}
            </Text>
            <Text style={typeStyles.caption}>
              {connection?.paired
                ? connection.message
                : '先完成一次性配對，token 會保存在 Android SecureStore。'}
            </Text>
          </View>
        </View>
        <AppButton
          label={
            connection?.transport === 'ready'
              ? '立即同步到桌面'
              : connection?.paired
                ? '重新檢查 USB'
                : '前往配對'
          }
          icon={connection?.paired ? 'usb' : 'cellphone-key'}
          onPress={() =>
            connection?.transport === 'ready'
              ? void sync()
              : connection?.paired
                ? void refresh()
                : router.push('/profile')
          }
          loading={syncing}
          disabled={connection?.transport === 'ready' ? !canSync : false}
        />
        {syncNotice ? <Text style={styles.syncNotice}>{syncNotice}</Text> : null}
      </PaperCard>
    </PaperScreen>
  );
}

const styles = StyleSheet.create({
  eventList: { gap: spacing.sm },
  eventCard: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md },
  eventIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: palette.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventCopy: { flex: 1, gap: 3 },
  eventTitle: { color: palette.cocoa, fontSize: 17, fontWeight: '800' },
  eventDescription: { color: palette.cocoaMuted, fontSize: 13, lineHeight: 18 },
  eventAmount: { color: palette.cocoa, fontSize: 16, fontWeight: '800' },
  eventError: { color: palette.danger, fontSize: 12, fontWeight: '600', lineHeight: 17 },
  emptyCard: { alignItems: 'center', gap: spacing.sm },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: palette.sageSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCopy: { textAlign: 'center', marginBottom: spacing.xs },
  syncCard: { gap: spacing.md },
  syncRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  syncCopy: { flex: 1, gap: 3 },
  syncTitle: { color: palette.cocoa, fontSize: 16, fontWeight: '800' },
  syncNotice: { color: palette.sage, fontSize: 14, fontWeight: '800' },
  errorCard: { gap: spacing.xs, borderColor: palette.danger },
  errorTitle: { color: palette.danger, fontSize: 17, fontWeight: '800' },
});
