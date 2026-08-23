import { DefaultTheme, ThemeProvider, type Theme } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { Suspense } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import 'react-native-reanimated';

import { AutoSyncAgent } from '@/src/components/AutoSyncAgent';
import { migrateDatabase, MOBILE_DATABASE_NAME } from '@/src/storage/database';
import { palette, spacing, typeStyles } from '@/src/theme/tokens';

const navigationTheme: Theme = {
  ...DefaultTheme,
  dark: false,
  colors: {
    ...DefaultTheme.colors,
    primary: palette.caramel,
    background: palette.canvas,
    card: palette.surface,
    text: palette.cocoa,
    border: palette.border,
    notification: palette.caramel,
  },
};

function DatabaseLoading() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="large" color={palette.caramel} />
      <Text style={typeStyles.body}>正在準備離線記錄空間…</Text>
    </View>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider value={navigationTheme}>
      <Suspense fallback={<DatabaseLoading />}>
        <SQLiteProvider
          databaseName={MOBILE_DATABASE_NAME}
          onInit={migrateDatabase}
          useSuspense>
          <AutoSyncAgent />
          <Stack screenOptions={{ contentStyle: { backgroundColor: palette.canvas } }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="event/[id]" options={{ headerShown: false }} />
          </Stack>
        </SQLiteProvider>
      </Suspense>
      <StatusBar style="dark" backgroundColor={palette.canvas} />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: palette.canvas,
  },
});
