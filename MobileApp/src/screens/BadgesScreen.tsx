import React, { useCallback, useLayoutEffect, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { BadgeRanksModal } from '../components/BadgeRanksModal';
import { useChildId } from '../auth/useChildId';
import { listBadges, type BadgeDto } from '../services/badgesApi';
import { getChildPoints, getMissions } from '../services/missionsApi';
import {
  EmptyState,
  Loader,
  Screen,
  SectionLabel,
  StatTile,
} from '../components/ui';
import { colors, radius, shadow, spacing, type as typeScale } from '../theme';

export function BadgesScreen(): React.JSX.Element {
  const navigation = useNavigation();
  const { childId } = useChildId();
  const [badges, setBadges] = useState<BadgeDto[]>([]);
  const [totalPoints, setTotalPoints] = useState(0);
  const [completedMissions, setCompletedMissions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const load = useCallback(async () => {
    if (!childId) {
      return;
    }
    try {
      const [badgeRes, pointsRes, missionsRes] = await Promise.all([
        listBadges(childId),
        getChildPoints(childId),
        getMissions(childId),
      ]);
      setBadges(badgeRes.badges);
      setTotalPoints(pointsRes.totalPoints ?? 0);
      setCompletedMissions((missionsRes.completed ?? []).length);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [childId]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={() => setGuideOpen(true)} style={styles.headerBtn} hitSlop={8}>
          <Text style={styles.headerBtnText}>Ranks</Text>
        </Pressable>
      ),
    });
  }, [navigation]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (loading) {
    return <Loader />;
  }

  const earned = badges.filter((b) => b.earned).length;

  return (
    <>
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
        <View style={styles.stats}>
          <StatTile label="Earned" value={`${earned}/${badges.length}`} tone="sage" />
          <StatTile label="Points" value={totalPoints} tone="teal" />
          <StatTile label="Missions" value={completedMissions} tone="neutral" />
        </View>

        <SectionLabel>Badge collection</SectionLabel>

        {badges.length ? (
          <View style={styles.grid}>
            {badges.map((b) => (
              <View
                key={b.id}
                style={[styles.badge, b.earned ? styles.badgeEarned : styles.badgeLocked]}>
                <View style={[styles.iconRing, b.earned && styles.iconRingEarned]}>
                  <Text style={[styles.icon, !b.earned && styles.iconLocked]}>
                    {b.earned ? b.icon ?? '🏅' : '🔒'}
                  </Text>
                </View>
                <Text style={styles.name} numberOfLines={1}>
                  {b.name}
                </Text>
                <Text style={styles.desc} numberOfLines={2}>
                  {b.description}
                </Text>
                <Text style={[styles.status, b.earned ? styles.statusEarned : styles.statusLocked]}>
                  {b.earned ? 'Earned' : 'Locked'}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <EmptyState icon="🏅" title="No badges yet" message="Complete missions to earn your first badge." />
        )}
      </Screen>

      <BadgeRanksModal
        visible={guideOpen}
        onClose={() => setGuideOpen(false)}
        badges={badges}
        stats={{ totalPoints, completedMissions, age: null }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.lg },
  stats: { flexDirection: 'row', gap: spacing.md },
  headerBtn: {
    marginRight: spacing.lg,
    backgroundColor: colors.tealSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  headerBtnText: { fontSize: 13, color: colors.tealDeep, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  badge: {
    width: '47.5%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
    alignItems: 'center',
    ...shadow.card,
  },
  badgeEarned: { borderColor: colors.tealBorder },
  badgeLocked: { opacity: 0.7 },
  iconRing: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  iconRingEarned: { backgroundColor: colors.tealSoft },
  icon: { fontSize: 28 },
  iconLocked: { fontSize: 22, opacity: 0.5 },
  name: { ...typeScale.bodyStrong, textAlign: 'center' },
  desc: { ...typeScale.meta, textAlign: 'center', marginTop: 4, minHeight: 34 },
  status: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: spacing.sm,
  },
  statusEarned: { color: colors.sage },
  statusLocked: { color: colors.textFaint },
});
