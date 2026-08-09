import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  AppButton,
  BrandHeader,
  InfoCallout,
  PaperCard,
  PaperScreen,
  SectionTitle,
  TextField,
} from '@/src/components/ui';
import {
  type ConnectionState,
  getConnectionState,
  pairWithDesktop,
} from '@/src/services/mobile-connection';
import { getMobileDatabaseInfo, type MobileDatabaseInfo } from '@/src/storage/outbox';
import { palette, spacing, typeStyles } from '@/src/theme/tokens';

export default function ProfileScreen() {
  const db = useSQLiteContext();
  const [info, setInfo] = useState<MobileDatabaseInfo | null>(null);
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [displayName, setDisplayName] = useState('我的 Android 手機');
  const [pairing, setPairing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [databaseInfo, connectionState] = await Promise.all([
        getMobileDatabaseInfo(db),
        getConnectionState(db),
      ]);
      setInfo(databaseInfo);
      setConnection(connectionState);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '無法讀取手機資訊');
    }
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function pair() {
    if (!pairingCode.trim() || !displayName.trim()) {
      setLoadError('請輸入桌面端配對碼與裝置名稱');
      return;
    }
    setPairing(true);
    setLoadError(null);
    setNotice(null);
    try {
      const state = await pairWithDesktop(db, pairingCode, displayName);
      setConnection(state);
      setPairingCode('');
      setNotice('配對完成。裝置憑證已存入 Android 安全儲存空間。');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '配對失敗');
    } finally {
      setPairing(false);
    }
  }

  return (
    <PaperScreen>
      <BrandHeader
        eyebrow="LOCAL FIRST"
        title="我的手機"
        subtitle="用 USB loopback 與桌面端配對；憑證只留在這支手機。"
      />

      <InfoCallout
        title="手機不是正式帳本"
        body="正式帳務真相仍由桌面端 transactions + postings 管理；手機同步只會建立待審核 Financial Event。"
      />

      <SectionTitle>桌面連線</SectionTitle>
      <PaperCard style={styles.connectionCard}>
        <View style={styles.connectionHeading}>
          <View style={[styles.connectionIcon, connection?.paired && styles.connectionIconReady]}>
            <MaterialCommunityIcons
              name={connection?.paired ? 'link-variant' : 'link-variant-off'}
              size={25}
              color={connection?.paired ? palette.sage : palette.caramelDark}
            />
          </View>
          <View style={styles.connectionCopy}>
            <Text style={styles.connectionTitle}>
              {connection?.paired ? '已保存桌面端憑證' : '尚未配對'}
            </Text>
            <Text style={typeStyles.caption}>
              {connection?.paired
                ? '同步前仍會逐筆驗證桌面端確認，不會直接入帳。'
                : '先在桌面產生一次性配對碼，再回到這裡輸入。'}
            </Text>
          </View>
        </View>

        {connection?.paired ? (
          <View style={styles.endpointBox}>
            <Text style={styles.endpointLabel}>USB loopback endpoint</Text>
            <Text selectable style={styles.endpointValue}>
              {connection.endpoint}
            </Text>
          </View>
        ) : (
          <View style={styles.pairingForm}>
            <TextField
              label="裝置名稱"
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="sentences"
              maxLength={120}
              placeholder="例如：我的 Android 手機"
            />
            <TextField
              label="一次性配對碼"
              value={pairingCode}
              onChangeText={setPairingCode}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={20}
              placeholder="XXXX-XXXX-XXXX"
            />
            <AppButton
              label="與桌面端配對"
              icon="cellphone-key"
              onPress={() => void pair()}
              loading={pairing}
              disabled={!pairingCode.trim() || !displayName.trim()}
            />
          </View>
        )}

        <Text style={styles.bridgeHint}>
          連線前需在電腦啟動服務，並執行 adb reverse tcp:8876 tcp:8876。這條通道只經 USB 與
          127.0.0.1，不開放 LAN 或公網。
        </Text>
      </PaperCard>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {loadError ? <Text style={styles.error}>{loadError}</Text> : null}

      <SectionTitle>本機狀態</SectionTitle>
      <PaperCard style={styles.infoCard}>
        <InfoRow
          icon="cellphone-key"
          label="裝置識別"
          value={info ? `…${info.deviceId.slice(-8)}` : '讀取中'}
        />
        <InfoRow
          icon="database-outline"
          label="資料庫版本"
          value={String(info?.databaseVersion ?? '—')}
        />
        <InfoRow icon="tray-arrow-up" label="待傳送" value={String(info?.pending ?? 0)} />
        <InfoRow icon="check-circle-outline" label="已同步" value={String(info?.synced ?? 0)} />
      </PaperCard>

      <SectionTitle>隱私邊界</SectionTitle>
      <PaperCard style={styles.privacyCard}>
        <PrivacyItem icon="usb" text="本版只使用 USB/ADB loopback，不建立公網 Relay。" />
        <PrivacyItem icon="bank-off-outline" text="手機不會直接新增、修改或刪除正式帳本。" />
        <PrivacyItem icon="robot-off-outline" text="App 不會背景呼叫 AI，也不會傳送資料給模型。" />
      </PaperCard>

      <Text style={styles.version}>Personal Asset OS Mobile v0.1 · USB connection preview</Text>
    </PaperScreen>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  value: string;
}) {
  return (
    <View style={styles.infoRow}>
      <MaterialCommunityIcons name={icon} size={23} color={palette.caramelDark} />
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function PrivacyItem({
  icon,
  text,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  text: string;
}) {
  return (
    <View style={styles.privacyRow}>
      <View style={styles.privacyIcon}>
        <MaterialCommunityIcons name={icon} size={21} color={palette.sage} />
      </View>
      <Text style={[typeStyles.body, styles.privacyText]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  connectionCard: { gap: spacing.md },
  connectionHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  connectionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: palette.amberSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectionIconReady: { backgroundColor: palette.sageSoft },
  connectionCopy: { flex: 1, gap: 3 },
  connectionTitle: { color: palette.cocoa, fontSize: 17, fontWeight: '800' },
  pairingForm: { gap: spacing.md },
  endpointBox: {
    backgroundColor: palette.surfaceMuted,
    borderRadius: 12,
    padding: spacing.sm,
    gap: spacing.xxs,
  },
  endpointLabel: { color: palette.cocoaMuted, fontSize: 12, fontWeight: '700' },
  endpointValue: { color: palette.cocoa, fontSize: 13, fontWeight: '700' },
  bridgeHint: { ...typeStyles.caption, borderTopWidth: 1, borderTopColor: palette.border, paddingTop: spacing.sm },
  notice: { color: palette.sage, fontSize: 14, fontWeight: '800' },
  infoCard: { paddingVertical: spacing.sm },
  infoRow: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  infoLabel: { flex: 1, color: palette.cocoaMuted, fontSize: 15, fontWeight: '600' },
  infoValue: { color: palette.cocoa, fontSize: 15, fontWeight: '800' },
  privacyCard: { gap: spacing.md },
  privacyRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  privacyIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: palette.sageSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyText: { flex: 1 },
  error: { color: palette.danger, fontSize: 14, fontWeight: '700' },
  version: { ...typeStyles.caption, textAlign: 'center' },
});
