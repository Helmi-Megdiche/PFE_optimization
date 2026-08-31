import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { requestAuthSessionRefresh } from '../auth/authSession';
import { tokenStorage } from '../auth/tokenStorage';
import { useChildId } from '../auth/useChildId';
import { getChildPoints } from '../services/missionsApi';
import {
  AppText,
  Button,
  Card,
  Meter,
  Screen,
  SectionLabel,
} from '../components/ui';
import { colors, spacing, type as typeScale } from '../theme';

const LEVEL_SIZE = 500;

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

  const pts = points ?? 0;
  const level = Math.floor(pts / LEVEL_SIZE) + 1;
  const intoLevel = pts % LEVEL_SIZE;

  return (
    <Screen contentStyle={styles.content}>
      {/* Level hero */}
      <Card style={styles.hero}>
        <View style={styles.levelRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{level}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[typeScale.eyebrow, { color: colors.tealBorder }]}>Level {level}</Text>
            {loading ? (
              <ActivityIndicator color="#FFFFFF" style={{ alignSelf: 'flex-start', marginTop: 6 }} />
            ) : (
              <View style={styles.ptsRow}>
                <Text style={styles.ptsNum}>{pts}</Text>
                <Text style={styles.ptsUnit}>points</Text>
              </View>
            )}
          </View>
        </View>
        <View style={styles.levelMeter}>
          <Meter value={intoLevel} max={LEVEL_SIZE} tone="sage" height={10} />
          <Text style={styles.levelHint}>
            {LEVEL_SIZE - intoLevel} points to level {level + 1}
          </Text>
        </View>
      </Card>

      <SectionLabel>Account</SectionLabel>
      <Card>
        <View style={styles.kv}>
          <AppText variant="bodyStrong">Child ID</AppText>
          <Text style={styles.mono} numberOfLines={1}>
            {childId ?? '—'}
          </Text>
        </View>
      </Card>

      <AppText variant="meta">
        Points refresh when you open this screen or the Missions tab. Parent approval isn't
        pushed in real time.
      </AppText>

      <View style={styles.actions}>
        <Button label="Refresh points" variant="secondary" onPress={() => void load()} />
        <Button
          label={__DEV__ ? 'Log out / refresh JWT' : 'Log out'}
          busyLabel="Logging out…"
          loading={loggingOut}
          variant="danger"
          onPress={() => void onLogout()}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.lg },
  hero: { backgroundColor: colors.ink, borderColor: colors.ink, gap: spacing.lg },
  levelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.teal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 28, fontWeight: '800', color: '#FFFFFF' },
  ptsRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  ptsNum: { fontSize: 34, fontWeight: '800', color: '#FFFFFF', letterSpacing: -1 },
  ptsUnit: { fontSize: 14, fontWeight: '700', color: colors.tealBorder },
  levelMeter: { gap: 6 },
  levelHint: { ...typeScale.meta, color: colors.tealBorder },
  kv: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mono: { fontFamily: 'monospace', fontSize: 13, color: colors.textMuted, flexShrink: 1, marginLeft: spacing.md },
  actions: { gap: spacing.md, marginTop: spacing.sm },
});
