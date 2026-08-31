import React, { useCallback, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useChildId } from '../auth/useChildId';
import { getChildPoints } from '../services/missionsApi';
import { claimReward, listRewards, type RewardDto } from '../services/rewardsApi';
import {
  AppText,
  Button,
  Card,
  EmptyState,
  Loader,
  Meter,
  Pill,
  Screen,
  SectionLabel,
} from '../components/ui';
import { colors, spacing, type as typeScale } from '../theme';

export function RewardsStoreScreen(): React.JSX.Element {
  const { childId } = useChildId();
  const [rewards, setRewards] = useState<RewardDto[]>([]);
  const [points, setPoints] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { rewards: list } = await listRewards();
      setRewards(list);
      if (childId) {
        const p = await getChildPoints(childId);
        setPoints(p.totalPoints);
      }
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [childId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onClaim = async (reward: RewardDto) => {
    try {
      const res = await claimReward(reward.id);
      setPoints(res.totalPoints);
      Alert.alert('Claimed', `You claimed "${reward.title}"`);
      void load();
    } catch (err) {
      Alert.alert('Claim failed', err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return <Loader />;
  }

  return (
    <Screen
      contentStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load();
          }}
          tintColor={colors.teal}
        />
      }>
      {/* Balance */}
      <Card style={styles.balance}>
        <Text style={[typeScale.eyebrow, { color: colors.tealBorder }]}>Your balance</Text>
        <View style={styles.balanceRow}>
          <Text style={styles.balanceNum}>{points}</Text>
          <Text style={styles.balanceUnit}>points</Text>
        </View>
      </Card>

      <SectionLabel>Rewards store</SectionLabel>

      {rewards.map((r) => {
        const affordable = points >= r.pointsRequired;
        return (
          <Card key={r.id} style={styles.card}>
            <View style={styles.cardHead}>
              <AppText variant="cardTitle" style={{ flex: 1 }}>
                {r.title}
              </AppText>
              <Pill label={`${r.pointsRequired} pts`} tone={affordable ? 'sage' : 'neutral'} />
            </View>
            {r.description ? (
              <AppText variant="body" style={{ marginTop: 4 }}>
                {r.description}
              </AppText>
            ) : null}
            {!affordable ? (
              <View style={styles.progress}>
                <Meter value={points} max={r.pointsRequired} tone="teal" height={8} />
                <Text style={styles.progressText}>
                  {r.pointsRequired - points} points to go
                </Text>
              </View>
            ) : null}
            <Button
              label={affordable ? 'Claim reward' : 'Keep earning'}
              variant={affordable ? 'primary' : 'secondary'}
              disabled={!affordable}
              onPress={() => void onClaim(r)}
              style={{ marginTop: spacing.lg }}
            />
          </Card>
        );
      })}

      {!rewards.length ? (
        <EmptyState
          icon="🎁"
          title="No rewards yet"
          message="Your parent can add rewards you unlock with points."
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.lg },
  balance: { backgroundColor: colors.ink, borderColor: colors.ink },
  balanceRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginTop: 6 },
  balanceNum: { fontSize: 44, fontWeight: '800', color: '#FFFFFF', letterSpacing: -1.5 },
  balanceUnit: { fontSize: 15, fontWeight: '700', color: colors.tealBorder },
  card: { gap: 2 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  progress: { marginTop: spacing.md, gap: 6 },
  progressText: { ...typeScale.meta, color: colors.textMuted },
});
