import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  type RefreshControlProps,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { FinancialEventKind, OutboxStatus } from '@/src/domain/financial-event';
import { palette, radii, shadows, spacing, typeStyles } from '@/src/theme/tokens';

type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export function PaperScreen({
  children,
  refreshControl,
  contentStyle,
}: {
  children: ReactNode;
  refreshControl?: RefreshControlProps;
  contentStyle?: ViewStyle;
}) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <View pointerEvents="none" style={styles.arcTop} />
      <View pointerEvents="none" style={styles.arcBottom} />
      <ScrollView
        contentContainerStyle={[styles.screenContent, contentStyle]}
        keyboardShouldPersistTaps="handled"
        refreshControl={refreshControl ? <RefreshControl {...refreshControl} /> : undefined}
        showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function BrandHeader({
  eyebrow = 'PERSONAL ASSET OS',
  title,
  subtitle,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
}) {
  return (
    <View style={styles.brandHeader}>
      <View style={styles.brandMark} accessibilityElementsHidden>
        <MaterialCommunityIcons name="coffee-outline" size={31} color={palette.cocoaMuted} />
        <MaterialCommunityIcons
          name="book-open-page-variant-outline"
          size={25}
          color={palette.caramelDark}
          style={styles.brandBook}
        />
      </View>
      <Text style={typeStyles.eyebrow}>{eyebrow}</Text>
      <Text style={typeStyles.title}>{title}</Text>
      <Text style={[typeStyles.body, styles.brandSubtitle]}>{subtitle}</Text>
    </View>
  );
}

export function PaperCard({
  children,
  style,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: ViewStyle;
  accessibilityLabel?: string;
}) {
  return (
    <View style={[styles.card, style]} accessibilityLabel={accessibilityLabel}>
      {children}
    </View>
  );
}

export function SectionTitle({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={typeStyles.section}>{children}</Text>
      {caption ? <Text style={typeStyles.caption}>{caption}</Text> : null}
    </View>
  );
}

export function AppButton({
  label,
  onPress,
  icon,
  variant = 'primary',
  disabled = false,
  loading = false,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  variant?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[`button_${variant}`],
        (disabled || loading) && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}>
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? palette.white : palette.cocoa} />
      ) : icon ? (
        <MaterialCommunityIcons
          name={icon}
          size={22}
          color={variant === 'primary' ? palette.white : palette.cocoa}
        />
      ) : null}
      <Text style={[styles.buttonLabel, variant === 'primary' && styles.buttonLabelPrimary]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function TextField({
  label,
  error,
  prefix,
  ...props
}: TextInputProps & { label: string; error?: string | null; prefix?: string }) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.inputShell, error ? styles.inputShellError : null]}>
        {prefix ? <Text style={styles.inputPrefix}>{prefix}</Text> : null}
        <TextInput
          {...props}
          accessibilityLabel={label}
          placeholderTextColor={palette.borderStrong}
          selectionColor={palette.caramel}
          style={[styles.input, props.multiline && styles.inputMultiline, props.style]}
        />
      </View>
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

export function KindSegment({
  value,
  onChange,
}: {
  value: FinancialEventKind;
  onChange: (value: FinancialEventKind) => void;
}) {
  return (
    <View style={styles.segment} accessibilityRole="tablist">
      {(['expense', 'income'] as const).map((kind) => {
        const selected = value === kind;
        const label = kind === 'expense' ? '支出' : '收入';
        return (
          <Pressable
            key={kind}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(kind)}
            style={[styles.segmentButton, selected && styles.segmentButtonSelected]}>
            <MaterialCommunityIcons
              name={kind === 'expense' ? 'arrow-down' : 'arrow-up'}
              size={21}
              color={selected ? palette.white : kind === 'income' ? palette.sage : palette.cocoa}
            />
            <Text style={[styles.segmentLabel, selected && styles.segmentLabelSelected]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function StatusTag({ status }: { status: OutboxStatus }) {
  const copy = statusCopy[status];
  return (
    <View style={[styles.statusTag, copy.tone]}>
      <MaterialCommunityIcons name={copy.icon} size={16} color={palette.cocoaMuted} />
      <Text style={styles.statusLabel}>{copy.label}</Text>
    </View>
  );
}

export function InfoCallout({
  title,
  body,
  icon = 'shield-check-outline',
}: {
  title: string;
  body: string;
  icon?: IconName;
}) {
  return (
    <View style={styles.callout}>
      <View style={styles.calloutIcon}>
        <MaterialCommunityIcons name={icon} size={22} color={palette.sage} />
      </View>
      <View style={styles.calloutCopy}>
        <Text style={styles.calloutTitle}>{title}</Text>
        <Text style={typeStyles.caption}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  screenContent: { paddingHorizontal: spacing.lg, paddingBottom: 110, gap: spacing.lg },
  arcTop: {
    position: 'absolute',
    width: 360,
    height: 180,
    borderWidth: 1,
    borderColor: palette.border,
    borderStyle: 'dashed',
    borderRadius: 180,
    top: 46,
    right: -140,
    opacity: 0.75,
  },
  arcBottom: {
    position: 'absolute',
    width: 260,
    height: 260,
    borderWidth: 1,
    borderColor: palette.border,
    borderStyle: 'dashed',
    borderRadius: 130,
    bottom: -190,
    left: -80,
    opacity: 0.5,
  },
  brandHeader: { alignItems: 'center', paddingTop: spacing.md, gap: spacing.xs },
  brandMark: { height: 54, width: 76, alignItems: 'center', justifyContent: 'flex-start' },
  brandBook: { position: 'absolute', top: 29, right: 11 },
  brandSubtitle: { maxWidth: 340, textAlign: 'center' },
  card: {
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    ...shadows.soft,
  },
  sectionHeading: { gap: spacing.xxs },
  button: {
    minHeight: 56,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
  },
  button_primary: { backgroundColor: palette.caramel, borderColor: palette.caramel },
  button_secondary: { backgroundColor: palette.surface, borderColor: palette.cocoaMuted },
  button_quiet: { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
  buttonPressed: { transform: [{ scale: 0.985 }], opacity: 0.88 },
  buttonDisabled: { opacity: 0.48 },
  buttonLabel: { color: palette.cocoa, fontSize: 16, fontWeight: '700' },
  buttonLabelPrimary: { color: palette.white },
  fieldGroup: { gap: spacing.xs },
  fieldLabel: { color: palette.cocoa, fontSize: 15, fontWeight: '700' },
  inputShell: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
  },
  inputShellError: { borderColor: palette.danger },
  inputPrefix: { color: palette.cocoa, fontSize: 19, fontWeight: '700', marginRight: spacing.xs },
  input: { flex: 1, minHeight: 54, color: palette.cocoa, fontSize: 18, paddingVertical: spacing.sm },
  inputMultiline: { minHeight: 86, textAlignVertical: 'top' },
  fieldError: { color: palette.danger, fontSize: 13, fontWeight: '600' },
  segment: {
    flexDirection: 'row',
    padding: spacing.xxs,
    backgroundColor: palette.surfaceMuted,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: radii.pill,
  },
  segmentButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  segmentButtonSelected: { backgroundColor: palette.caramel },
  segmentLabel: { color: palette.cocoa, fontSize: 16, fontWeight: '700' },
  segmentLabelSelected: { color: palette.white },
  statusTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radii.pill,
  },
  statusPending: { backgroundColor: palette.amberSoft },
  statusSuccess: { backgroundColor: palette.sageSoft },
  statusReview: { backgroundColor: '#F4DDC7' },
  statusFailed: { backgroundColor: '#F5D7D1' },
  statusLabel: { color: palette.cocoaMuted, fontSize: 13, fontWeight: '700' },
  callout: {
    backgroundColor: palette.sageSoft,
    borderRadius: radii.md,
    padding: spacing.md,
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  calloutIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calloutCopy: { flex: 1, gap: spacing.xxs },
  calloutTitle: { color: palette.cocoa, fontSize: 15, fontWeight: '800' },
});

const statusCopy: Record<OutboxStatus, { label: string; icon: IconName; tone: ViewStyle }> = {
  pending: { label: '待傳送', icon: 'clock-outline', tone: styles.statusPending },
  syncing: { label: '傳送中', icon: 'cloud-upload-outline', tone: styles.statusPending },
  synced: { label: '已同步', icon: 'check-circle-outline', tone: styles.statusSuccess },
  needs_review: { label: '需要確認', icon: 'alert-circle-outline', tone: styles.statusReview },
  failed: { label: '傳送失敗', icon: 'cloud-alert-outline', tone: styles.statusFailed },
};
