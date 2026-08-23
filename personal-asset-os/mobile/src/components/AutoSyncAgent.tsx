import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';

import { autoSyncOutbox } from '@/src/services/mobile-connection';

const FOREGROUND_SYNC_INTERVAL_MS = 10_000;

export function AutoSyncAgent() {
  const db = useSQLiteContext();
  const attemptSync = useCallback(() => {
    if (AppState.currentState !== 'active') return;
    void autoSyncOutbox(db).catch(() => undefined);
  }, [db]);

  useEffect(() => {
    attemptSync();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') attemptSync();
    });
    const interval = setInterval(attemptSync, FOREGROUND_SYNC_INTERVAL_MS);
    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, [attemptSync]);

  return null;
}
