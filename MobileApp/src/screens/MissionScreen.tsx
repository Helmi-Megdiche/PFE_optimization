import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Alert,
  AppState,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../navigation/types';
import {decideCompletionFailure} from '../missions/completionFailure';
import {
  abandonMission,
  completeMission,
  type MissionCompletionPayload,
} from '../services/missionsApi';
import {resolveGameComponent} from './missions/gameRegistry';
import {focus} from '../theme';
import {
  beginMissionCaptureSession,
  forceEndMissionCaptureSession,
} from '../utils/missionCaptureSession';

type Props = NativeStackScreenProps<RootStackParamList, 'MissionScreen'>;

export function MissionScreen({navigation, route}: Props): React.JSX.Element {
  const {missionId, title, description, points, missionType, metadata} =
    route.params;
  const settledRef = useRef(false); // completed OR abandoned — no further actions
  const [submitting, setSubmitting] = useState(false);

  const GameComponent = resolveGameComponent(missionType, metadata);

  useEffect(() => {
    navigation.getParent()?.setOptions({tabBarStyle: {display: 'none'}});
    return () => {
      navigation.getParent()?.setOptions({tabBarStyle: undefined});
    };
  }, [navigation]);

  useEffect(() => {
    beginMissionCaptureSession(missionId, 'screen');
    return () => {
      forceEndMissionCaptureSession();
    };
  }, [missionId]);

  // Disable hardware back; child must finish or explicitly quit.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const handleAbandon = useCallback(async () => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    try {
      const res = await abandonMission(missionId);
      Alert.alert(
        'Mission escaped',
        `Penalty: -${res.penalty} points. Total: ${res.totalPoints}`,
      );
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : String(err));
    } finally {
      forceEndMissionCaptureSession();
      navigation.goBack();
    }
  }, [missionId, navigation]);

  // Escape penalty only when the app leaves the foreground (not brief "inactive" on Android).
  useEffect(() => {
    const appStateRef = {current: AppState.currentState};
    const mountedAt = Date.now();
    const sub = AppState.addEventListener('change', next => {
      const leftForeground =
        appStateRef.current === 'active' && next === 'background';
      const graceMs = 3_000;
      if (
        leftForeground &&
        Date.now() - mountedAt > graceMs &&
        !settledRef.current
      ) {
        void handleAbandon();
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, [handleAbandon]);

  const confirmQuit = () => {
    Alert.alert(
      'Leave mission?',
      'If you leave now, you will lose 10 points.',
      [
        {text: 'Keep playing', style: 'cancel'},
        {
          text: 'Leave (-10)',
          style: 'destructive',
          onPress: () => void handleAbandon(),
        },
      ],
    );
  };

  const submitCompletion = useCallback(
    async (payload: MissionCompletionPayload) => {
      if (settledRef.current || submitting) {
        return;
      }
      setSubmitting(true);
      try {
        const res = await completeMission(missionId, payload);
        settledRef.current = true;
        const awarded = res.points ?? res.pointsAwarded ?? 0;
        const message =
          res.status === 'pending_approval'
            ? res.message ?? 'Waiting for parent approval'
            : `+${awarded} points! Total: ${res.totalPoints}`;
        Alert.alert(
          'Mission',
          message,
          [
            {
              text: 'OK',
              onPress: () => {
                forceEndMissionCaptureSession();
                navigation.goBack();
              },
            },
          ],
          {cancelable: false},
        );
      } catch (err) {
        setSubmitting(false);
        const decision = decideCompletionFailure(err);
        if (decision.action === 'alreadyFinished') {
          settledRef.current = true;
          Alert.alert(
            decision.title,
            decision.message,
            [
              {
                text: 'OK',
                onPress: () => {
                  forceEndMissionCaptureSession();
                  navigation.goBack();
                },
              },
            ],
            {cancelable: false},
          );
          return;
        }
        Alert.alert(
          decision.title,
          decision.message,
          [
            {
              text: 'Retry',
              onPress: () => void submitCompletionRef.current(payload),
            },
            {
              text: 'Close',
              style: 'cancel',
              onPress: () => {
                settledRef.current = true;
                forceEndMissionCaptureSession();
                navigation.goBack();
              },
            },
          ],
          {cancelable: false},
        );
      }
    },
    [missionId, navigation, submitting],
  );

  const submitCompletionRef = useRef(submitCompletion);
  useEffect(() => {
    submitCompletionRef.current = submitCompletion;
  }, [submitCompletion]);

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={false}
        bounces={false}>
        <View style={styles.header}>
          <View style={styles.badge}>
            <View style={styles.badgeDot} />
            <Text style={styles.badgeText}>ACTIVE MISSION</Text>
          </View>
          <Pressable onPress={confirmQuit} hitSlop={12} style={styles.quitBtn}>
            <Text style={styles.quit}>Quit</Text>
          </Pressable>
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.desc}>{description}</Text>
        <View style={styles.chips}>
          <View style={styles.pointsChip}>
            <Text style={styles.pointsChipText}>+{points} pts</Text>
          </View>
          <View style={styles.typeChip}>
            <Text style={styles.typeChipText}>
              {missionType.replace('_', ' ')}
            </Text>
          </View>
        </View>

        <View style={styles.gameArea}>
          {GameComponent ? (
            <GameComponent
              metadata={metadata}
              points={points}
              age={null}
              onComplete={payload => void submitCompletion(payload)}
              onQuit={confirmQuit}
            />
          ) : (
            <Pressable
              style={styles.primaryBtn}
              disabled={submitting}
              onPress={() => void submitCompletion({confirmed: true})}>
              <Text style={styles.primaryBtnText}>Mark as done</Text>
            </Pressable>
          )}
        </View>

        <Text style={styles.warning}>
          Leaving the app or quitting applies a -10 point escape penalty.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: focus.bg},
  content: {padding: 20, paddingTop: 44, paddingBottom: 40},
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: focus.surface,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  badgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: focus.amber,
  },
  badgeText: {
    color: focus.amber,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  quitBtn: {
    borderWidth: 1,
    borderColor: focus.border,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
  },
  quit: {color: focus.coral, fontWeight: '700', fontSize: 13},
  title: {
    color: focus.text,
    fontSize: 26,
    fontWeight: '800',
    marginTop: 18,
    letterSpacing: -0.5,
  },
  desc: {color: focus.textMuted, fontSize: 15, marginTop: 8, lineHeight: 22},
  chips: {flexDirection: 'row', gap: 8, marginTop: 16},
  pointsChip: {
    backgroundColor: focus.accentStrong,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pointsChipText: {color: '#FFFFFF', fontWeight: '800', fontSize: 13},
  typeChip: {
    backgroundColor: focus.surface,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  typeChipText: {color: focus.textMuted, fontWeight: '700', fontSize: 13},
  gameArea: {marginTop: 28, alignItems: 'center'},
  warning: {
    color: focus.textMuted,
    fontSize: 12.5,
    marginTop: 28,
    lineHeight: 20,
    textAlign: 'center',
  },
  primaryBtn: {
    marginTop: 8,
    backgroundColor: focus.accentStrong,
    paddingVertical: 16,
    paddingHorizontal: 40,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryBtnText: {color: '#FFFFFF', fontSize: 16, fontWeight: '700'},
});
