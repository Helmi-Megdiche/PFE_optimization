import React, { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useChildId } from '../auth/useChildId';
import { getMissions, type MissionDto } from '../services/missionsApi';
import { navigateToMissionScreen } from '../navigation/navigationRef';
import {
  AppText,
  Card,
  EmptyState,
  Loader,
  Pill,
  Screen,
  SectionLabel,
} from '../components/ui';
import { colors, spacing } from '../theme';

function missionType(m: MissionDto): string {
  return String(m.metadata?.type ?? 'real_world');
}

type SectionTone = 'teal' | 'amber' | 'sage' | 'coral' | 'neutral';

function MissionSection({
  title,
  tone,
  missions,
  onOpen,
  interactive,
}: {
  title: string;
  tone: SectionTone;
  missions: MissionDto[];
  onOpen: (m: MissionDto) => void;
  interactive: boolean;
}): React.JSX.Element | null {
  if (!missions.length) {
    return null;
  }
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <SectionLabel>{title}</SectionLabel>
        <Pill label={String(missions.length)} tone={tone} />
      </View>
      {missions.map((m) => (
        <Card
          key={m.id}
          onPress={interactive ? () => onOpen(m) : undefined}
          style={styles.card}>
          <View style={styles.cardHead}>
            <AppText variant="cardTitle" numberOfLines={1} style={{ flex: 1 }}>
              {m.title}
            </AppText>
            <View style={styles.points}>
              <Text style={styles.pointsNum}>{m.points}</Text>
              <Text style={styles.pointsLabel}>pts</Text>
            </View>
          </View>
          <AppText variant="body" numberOfLines={2} style={{ marginTop: 4 }}>
            {m.description}
          </AppText>
          <View style={styles.cardMeta}>
            <Pill label={missionType(m).replace('_', ' ')} tone="neutral" />
            {interactive ? (
              <Text style={styles.cta}>Start →</Text>
            ) : null}
          </View>
        </Card>
      ))}
    </View>
  );
}

export function MissionListScreen(): React.JSX.Element {
  const { childId, loading: childLoading } = useChildId();
  const [data, setData] = useState<Awaited<ReturnType<typeof getMissions>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!childId) {
      return;
    }
    try {
      const res = await getMissions(childId);
      setData(res);
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

  useEffect(() => {
    if (!childId) {
      return;
    }
    const id = setInterval(() => {
      void load();
    }, 60_000);
    return () => clearInterval(id);
  }, [childId, load]);

  const onRefresh = () => {
    setRefreshing(true);
    void load();
  };

  const openMission = (m: MissionDto) => {
    if (m.status !== 'pending') {
      return;
    }
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    navigateToMissionScreen({
      missionId: m.id,
      title: m.title,
      description: m.description,
      points: m.points,
      missionType: missionType(m),
      metadata: meta,
    });
  };

  if (childLoading || loading) {
    return <Loader />;
  }

  if (!childId) {
    return (
      <Screen scroll={false} contentStyle={styles.centerPad}>
        <EmptyState icon="🔑" title="No child profile" message="Log in first to see missions." />
      </Screen>
    );
  }

  const nothing =
    !data?.pending.length && !data?.pendingApproval.length && !data?.completed.length;

  return (
    <Screen
      contentStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.teal} />
      }>
      <MissionSection
        title="Active"
        tone="teal"
        missions={data?.pending ?? []}
        onOpen={openMission}
        interactive
      />
      <MissionSection
        title="Awaiting parent approval"
        tone="amber"
        missions={data?.pendingApproval ?? []}
        onOpen={() => undefined}
        interactive={false}
      />
      <MissionSection
        title="Completed"
        tone="sage"
        missions={data?.completed ?? []}
        onOpen={() => undefined}
        interactive={false}
      />
      <MissionSection
        title="Failed / escaped"
        tone="coral"
        missions={data?.failed ?? []}
        onOpen={() => undefined}
        interactive={false}
      />
      <MissionSection
        title="Expired"
        tone="neutral"
        missions={data?.expired ?? []}
        onOpen={() => undefined}
        interactive={false}
      />
      {nothing ? (
        <EmptyState
          icon="🎯"
          title="No missions yet"
          message="Missions appear here when SafeGuard spots a chance to build a healthier habit."
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.xl },
  centerPad: { flex: 1, justifyContent: 'center' },
  section: { gap: spacing.md },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  card: { gap: 2 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  points: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  pointsNum: { fontSize: 20, fontWeight: '800', color: colors.teal, letterSpacing: -0.5 },
  pointsLabel: { fontSize: 11, fontWeight: '700', color: colors.textFaint },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  cta: { fontSize: 13, fontWeight: '700', color: colors.teal },
});
