import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Platform,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useScreenshotCapture } from '../hooks/useScreenshotCapture';
import { openAccessibilitySettings } from '../native/SafeGuardAccessibility';
import getScreenCaptureModule from '../native/ScreenCapture';
import { scLog, scWarn } from '../utils/screenCaptureLogger';
import { getMonitoringIntent, setMonitoringIntent } from '../utils/monitoringIntent';
import { setMonitoringActive } from '../state/monitoringState';
import type { CaptureCycleResult } from '../types/screenMonitor';
import {
  AppText,
  Button,
  Card,
  Divider,
  Pill,
  PulseDot,
  SectionLabel,
} from './ui';
import { colors, spacing, type as typeScale, toneForCategory } from '../theme';

export interface ScreenMonitorProps {
  intervalMs?: number;
  consentGranted: boolean;
}

function showUsageAccessDialog(onOpenSettings: () => void): void {
  Alert.alert(
    'Usage access required',
    'To detect which app is on screen (Chrome, Instagram, etc.), enable Usage access for SafeGuard in system settings.\n\nWithout it, app names may show as "unknown".',
    [
      { text: 'Later', style: 'cancel' },
      { text: 'Open settings', onPress: onOpenSettings },
    ],
  );
}

export function ScreenMonitor({
  intervalMs = 20_000,
  consentGranted,
}: ScreenMonitorProps) {
  const [enabled, setEnabled] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [lastResult, setLastResult] = useState<CaptureCycleResult | null>(null);

  // Accessibility health is owned by useScreenshotCapture (`a11yHealth`) — it has
  // the poll evidence needed to tell "bound and live" from "bound but silent".
  // One source of truth, not a second isEnabled() check here that could disagree.

  const onCycleComplete = useCallback((result: CaptureCycleResult) => {
    setLastResult(result);
  }, []);

  const {
    isMonitoring,
    isPaused,
    permissionGranted,
    usageAccessGranted,
    lastForegroundApp,
    dynamicIntervalMs,
    appCategory,
    avgRiskScore,
    lastError,
    lastCaptureAt,
    a11yHealth,
    refreshUsageAccess,
    openUsageAccessSettings,
    startMonitoring,
    stopMonitoring,
  } = useScreenshotCapture({ intervalMs, onCycleComplete });

  useEffect(() => {
    setMonitoringActive(isMonitoring);
    return () => {
      setMonitoringActive(false);
    };
  }, [isMonitoring]);

  // Keep the switch honest: if the hook drops monitoring on its own (e.g. the system
  // revoked screen-capture permission mid-session), snap the toggle off. No-op on the
  // voluntary on/off paths, where `enabled` and `isMonitoring` already agree.
  useEffect(() => {
    if (!isMonitoring) {
      setEnabled(false);
    }
  }, [isMonitoring]);

  useEffect(() => {
    if (Platform.OS === 'android') {
      void refreshUsageAccess();
    }
  }, [refreshUsageAccess]);

  /** Resume monitoring after MediaProjection consent reloads the React Activity. */
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    let cancelled = false;

    (async () => {
      const wantsMonitoring = await getMonitoringIntent();
      if (!wantsMonitoring || cancelled) {
        return;
      }

      const nativeGranted = await getScreenCaptureModule().isPermissionGranted();
      if (!nativeGranted || cancelled) {
        return;
      }

      scLog('Auto-resuming monitoring after permission grant / app reload');
      const started = await startMonitoring();
      if (!cancelled) {
        setEnabled(started);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [startMonitoring]);

  const handleToggle = useCallback(
    async (value: boolean) => {
      if (isBusy) {
        scWarn('Toggle ignored — busy');
        return;
      }
      scLog('Toggle', { value, permissionGranted, usageAccessGranted });
      setIsBusy(true);
      try {
        await setMonitoringIntent(value);
        if (value) {
          const usageOk = await refreshUsageAccess();
          if (!usageOk) {
            showUsageAccessDialog(() => {
              void openUsageAccessSettings();
            });
          }
          const started = await startMonitoring();
          scLog('Toggle ON result', { started });
          setEnabled(started);
          if (started && !usageOk) {
            void refreshUsageAccess();
          }
        } else {
          await stopMonitoring();
          await setMonitoringIntent(false);
          scLog('Toggle OFF done');
          setEnabled(false);
        }
      } finally {
        setIsBusy(false);
      }
    },
    [
      isBusy,
      permissionGranted,
      usageAccessGranted,
      refreshUsageAccess,
      openUsageAccessSettings,
      startMonitoring,
      stopMonitoring,
    ],
  );

  if (Platform.OS !== 'android') {
    return (
      <Card>
        <AppText variant="heading">Screen monitoring</AppText>
        <AppText variant="body" style={{ marginTop: 4 }}>
          Available on Android only.
        </AppText>
      </Card>
    );
  }

  if (!consentGranted) {
    return (
      <Card>
        <AppText variant="heading">Screen monitoring</AppText>
        <AppText variant="body" style={{ marginTop: 6, color: colors.amber }}>
          Parental consent (GDPR) is required before enabling monitoring.
        </AppText>
      </Card>
    );
  }

  const statusText = !isMonitoring
    ? 'Paused'
    : isPaused
    ? 'Paused'
    : 'Protecting';
  const effective =
    dynamicIntervalMs > 0
      ? `Scanning every ${Math.round(dynamicIntervalMs / 1000)}s`
      : 'App-switch only';

  return (
    <View style={{ gap: spacing.lg }}>
      {/* Protection status — hero */}
      <Card style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.statusChip}>
            <PulseDot active={isMonitoring && !isPaused} />
            <Text style={styles.statusText}>{statusText}</Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={handleToggle}
            disabled={isBusy}
            trackColor={{ false: colors.sandDeep, true: colors.teal }}
            thumbColor={'#FFFFFF'}
            accessibilityLabel="Enable or disable monitoring"
          />
        </View>

        <Text style={styles.heroTitle}>
          {isMonitoring && !isPaused
            ? 'SafeGuard is watching over this device'
            : 'Monitoring is off'}
        </Text>

        {isMonitoring && !isBusy ? (
          <View style={styles.liveRow}>
            <Pill label={effective} tone="teal" />
            {appCategory ? <Pill label={appCategory} tone="neutral" /> : null}
            {avgRiskScore != null ? (
              <Pill
                label={`avg risk ${avgRiskScore}`}
                tone={avgRiskScore >= 60 ? 'coral' : avgRiskScore >= 30 ? 'amber' : 'sage'}
              />
            ) : null}
          </View>
        ) : null}

        {isBusy ? (
          <AppText variant="meta" style={{ marginTop: spacing.md, color: colors.teal }}>
            Starting…
          </AppText>
        ) : null}
      </Card>

      {/* Environment */}
      <Card>
        <View style={styles.kvRow}>
          <View style={styles.kvLeft}>
            <AppText variant="bodyStrong">Usage access</AppText>
            <AppText variant="meta">Needed to name the foreground app</AppText>
          </View>
          <View style={styles.kvRight}>
            {usageAccessGranted ? (
              <Pill label="Granted" tone="sage" />
            ) : (
              <Button
                label="Enable"
                variant="secondary"
                style={styles.smallBtn}
                onPress={() => showUsageAccessDialog(() => void openUsageAccessSettings())}
              />
            )}
          </View>
        </View>

        <Divider style={{ marginVertical: spacing.md }} />

        <View style={styles.kvRow}>
          <View style={styles.kvLeft}>
            <AppText variant="bodyStrong">Accessibility service</AppText>
            <AppText variant="meta">
              {a11yHealth === 'degraded'
                ? 'Turn SafeGuard off and back on in Accessibility settings'
                : a11yHealth === 'unverified'
                ? "Switch apps once to confirm it's live"
                : 'Faster app + website detection'}
            </AppText>
          </View>
          <View style={styles.kvRight}>
            {a11yHealth === 'live' ? (
              <Pill label="Active" tone="sage" />
            ) : a11yHealth === 'unverified' ? (
              <Pill label="Enabled" tone="neutral" />
            ) : a11yHealth === 'degraded' ? (
              <View style={styles.a11yDegradedRow}>
                <Pill label="Not responding" tone="amber" />
                <Button
                  label="Open settings"
                  variant="secondary"
                  style={styles.smallBtn}
                  onPress={() => void openAccessibilitySettings()}
                />
              </View>
            ) : (
              <Button
                label="Enable"
                variant="secondary"
                style={styles.smallBtn}
                onPress={() => void openAccessibilitySettings()}
              />
            )}
          </View>
        </View>

        {lastCaptureAt ? (
          <>
            <Divider style={{ marginVertical: spacing.md }} />
            <View style={styles.kvRow}>
              <AppText variant="bodyStrong">Last sync</AppText>
              <AppText variant="meta">
                {new Date(lastCaptureAt).toLocaleTimeString()}
              </AppText>
            </View>
          </>
        ) : null}
      </Card>

      {/* Last analysed event */}
      {lastResult?.event ? (
        <View style={{ gap: spacing.md }}>
          <SectionLabel>Last analysed</SectionLabel>
          <Card>
            <View style={styles.eventHead}>
              <AppText variant="cardTitle" numberOfLines={1} style={{ flex: 1 }}>
                {lastResult.event.appLabel ?? lastResult.event.appPackage}
              </AppText>
              {(() => {
                const tone = toneForCategory(lastResult.event.category);
                return (
                  <Pill
                    label={
                      lastResult.event.riskFlag
                        ? lastResult.event.category ?? 'flagged'
                        : 'safe'
                    }
                    bg={lastResult.event.riskFlag ? tone.bg : colors.sageSoft}
                    fg={lastResult.event.riskFlag ? tone.fg : '#1E6B50'}
                  />
                );
              })()}
            </View>
            <AppText variant="meta" style={{ marginTop: 2 }}>
              {lastResult.event.appPackage}
            </AppText>
            <View style={styles.previewBox}>
              <Text style={styles.previewText} numberOfLines={3}>
                {lastResult.event.extractedTextPreview || '(no text detected)'}
              </Text>
            </View>
          </Card>
        </View>
      ) : null}

      {lastResult?.skippedReason ? (
        <AppText variant="meta">Cycle skipped: {lastResult.skippedReason}</AppText>
      ) : null}

      {lastError ? (
        <Card style={styles.errorCard}>
          <AppText variant="bodyStrong" style={{ color: '#9B2D18' }}>
            {lastError}
          </AppText>
        </Card>
      ) : null}
    </View>
  );
}

export default ScreenMonitor;

const styles = StyleSheet.create({
  hero: { gap: 2 },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
  },
  statusText: { ...typeScale.bodyStrong, color: colors.ink },
  heroTitle: { ...typeScale.title, fontSize: 22, marginTop: spacing.sm },
  liveRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg },
  smallBtn: { height: 40, paddingHorizontal: spacing.lg },
  kvRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  kvLeft: { flex: 1, gap: 2 },
  kvRight: { flexShrink: 0 },
  a11yDegradedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  eventHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  previewBox: {
    marginTop: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 12,
    padding: spacing.md,
  },
  previewText: { fontFamily: 'monospace', fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  errorCard: { backgroundColor: colors.coralSoft, borderColor: '#F3C7BB' },
});
