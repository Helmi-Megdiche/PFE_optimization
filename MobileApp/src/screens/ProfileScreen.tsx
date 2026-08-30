import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { requestAuthSessionRefresh } from '../auth/authSession';
import { tokenStorage } from '../auth/tokenStorage';
import { useChildId } from '../auth/useChildId';
import { getChildPoints } from '../services/missionsApi';

export function ProfileScreen(): React.JSX.Element {
  const { childId, refresh: refreshChildId } = useChildId();
  const [points, setPoints] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  const load = useCallback(async () => {
    if (!childId) {
      setLoading(false);
      return;
    }
    try {
      const res = await getChildPoints(childId);
      setPoints(res.totalPoints);
    } catch {
      // Keep last known points on transient / auth errors.
    } finally {
      setLoading(false);
    }
  }, [childId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load]),
  );

  useEffect(() => {
    if (!childId) {
      return;
    }
    const id = setInterval(() => {
      void load();
    }, 60_000);
    return () => clearInterval(id);
  }, [childId, load]);

  const onLogout = async () => {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    try {
      await tokenStorage.clearToken();
      refreshChildId();
      requestAuthSessionRefresh();
      Alert.alert(
        'Session cleared',
        __DEV__
          ? 'Dev JWT cleared. A fresh token will be fetched automatically if the backend is running.'
          : 'You have been logged out.',
      );
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Child ID</Text>
      <Text style={styles.value}>{childId ?? '—'}</Text>
      <Text style={styles.label}>Total points</Text>
      {loading ? (
        <ActivityIndicator />
      ) : (
        <>
          <Text style={styles.points}>{points ?? 0}</Text>
          <Text style={styles.level}>
            Level {Math.floor((points ?? 0) / 500) + 1}
          </Text>
        </>
      )}
      <Text style={styles.hint}>
        Points refresh when you open this screen or the Missions tab (pull-to-refresh). Parent
        approval is not pushed in real time.
      </Text>
      <Pressable style={styles.btn} onPress={() => void load()}>
        <Text style={styles.btnText}>Refresh points</Text>
      </Pressable>
      <Pressable
        style={[styles.btn, styles.btnLogout]}
        disabled={loggingOut}
        onPress={() => void onLogout()}>
        <Text style={styles.btnText}>
          {loggingOut ? 'Logging out…' : __DEV__ ? 'Log out / refresh JWT' : 'Log out'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: '#fff' },
  label: { fontSize: 12, color: '#64748b', marginTop: 16 },
  value: { fontSize: 13, color: '#0f172a', fontFamily: 'monospace' },
  points: { fontSize: 32, fontWeight: '700', color: '#2563eb', marginTop: 4 },
  level: { fontSize: 18, fontWeight: '600', color: '#0f172a', marginTop: 8 },
  hint: { fontSize: 13, color: '#64748b', marginTop: 20, lineHeight: 20 },
  btn: {
    marginTop: 24,
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnLogout: { backgroundColor: '#b91c1c', marginTop: 12 },
  btnText: { color: '#fff', fontWeight: '600' },
});
