import { Linking, NativeModules, Platform } from 'react-native';
import { scLog, scWarn } from '../utils/screenCaptureLogger';
import { withTimeout } from '../utils/withTimeout';

/** Native UsageStats lookup must not block the RN bridge indefinitely. */
const FOREGROUND_NATIVE_TIMEOUT_MS = 2_500;

export interface ForegroundAppInfo {
  packageName: string;
  appLabel: string;
  lastTimeUsed?: number;
  source?: 'usage_stats' | 'activity_manager' | 'none';
}

interface ForegroundAppNativeModule {
  hasUsageAccess(): Promise<boolean>;
  hasUsageStatsPermission(): Promise<boolean>;
  openUsageAccessSettings(): Promise<boolean>;
  getCurrentForegroundApp(): Promise<ForegroundAppInfo | null>;
}

const LINKING_ERROR =
  'ForegroundApp native module is not linked. Rebuild the Android app after Sprint 3.5.';

function getModule(): ForegroundAppNativeModule | null {
  if (Platform.OS !== 'android') {
    return null;
  }
  return NativeModules.ForegroundApp as ForegroundAppNativeModule | undefined ?? null;
}

export async function hasUsageAccess(): Promise<boolean> {
  const mod = getModule();
  if (!mod) return false;
  try {
    return await mod.hasUsageAccess();
  } catch {
    return false;
  }
}

export async function hasUsageStatsPermission(): Promise<boolean> {
  return hasUsageAccess();
}

export async function openUsageAccessSettings(): Promise<void> {
  const mod = getModule();
  if (mod) {
    try {
      await mod.openUsageAccessSettings();
      return;
    } catch {
      // fall through
    }
  }
  await Linking.openSettings();
}

const UNKNOWN_FOREGROUND: ForegroundAppInfo = {
  packageName: 'unknown',
  appLabel: 'unknown',
  source: 'none',
};

/** One native UsageStats lookup at a time — concurrent calls were blocking the RN bridge. */
let foregroundLookupInFlight: Promise<ForegroundAppInfo> | null = null;
let foregroundLookupStartedAt = 0;

/**
 * True when a lookup has been in flight past the native timeout. React Native suspends JS timers
 * while the app is backgrounded, so the `withTimeout` guard below cannot fire there — a wedged
 * UsageStats IPC would otherwise stay "in flight" forever and poison every future caller. Callers
 * use this to skip awaiting a wedged lookup and fall back to a cached package instead.
 */
export function isForegroundLookupStuck(): boolean {
  return (
    foregroundLookupInFlight !== null &&
    Date.now() - foregroundLookupStartedAt >= FOREGROUND_NATIVE_TIMEOUT_MS
  );
}

/** Drop any in-flight lookup so the next call starts fresh (e.g. on stop / takeover). */
export function resetForegroundLookup(): void {
  foregroundLookupInFlight = null;
  foregroundLookupStartedAt = 0;
}

async function resolveForegroundAppOnce(): Promise<ForegroundAppInfo> {
  const mod = getModule();
  if (!mod) {
    scWarn('ForegroundApp module not linked');
    return UNKNOWN_FOREGROUND;
  }

  try {
    const fg = await mod.getCurrentForegroundApp();
    if (fg?.packageName) {
      scLog('resolveForegroundApp', {
        package: fg.packageName,
        label: fg.appLabel,
        source: fg.source ?? 'usage_stats',
      });
      return {
        packageName: fg.packageName,
        appLabel: fg.appLabel ?? fg.packageName,
        lastTimeUsed: fg.lastTimeUsed,
        source: (fg.source as ForegroundAppInfo['source']) ?? 'usage_stats',
      };
    }
  } catch (err) {
    scWarn('resolveForegroundApp failed', err);
  }

  return UNKNOWN_FOREGROUND;
}

/**
 * Resolves foreground app — never throws; returns unknown if module missing.
 * Concurrent callers share one *fresh* in-flight lookup; a wedged (stale) one is abandoned so a
 * hung UsageStats IPC can't block every future frame when JS timers are frozen in the background.
 */
export async function resolveForegroundApp(): Promise<ForegroundAppInfo> {
  if (foregroundLookupInFlight && !isForegroundLookupStuck()) {
    return foregroundLookupInFlight;
  }

  const startedAt = Date.now();
  foregroundLookupStartedAt = startedAt;
  const pending = withTimeout(
    resolveForegroundAppOnce(),
    FOREGROUND_NATIVE_TIMEOUT_MS,
    UNKNOWN_FOREGROUND,
  ).finally(() => {
    // Only clear if a newer lookup hasn't superseded this one.
    if (foregroundLookupStartedAt === startedAt) {
      foregroundLookupInFlight = null;
      foregroundLookupStartedAt = 0;
    }
  });
  foregroundLookupInFlight = pending;
  return pending;
}

/**
 * Retry briefly — UsageStats can return null during MediaProjection capture.
 *
 * `backgrounded` must be passed explicitly by the caller: React Native freezes JS
 * `setTimeout` while the app is backgrounded, so the inter-attempt sleep below would
 * never fire there — a first attempt that comes back `unknown` (a normal, healthy
 * outcome, not a failure) would otherwise wedge this call forever. Backgrounded, this
 * makes exactly one attempt and never sleeps; foregrounded behavior is unchanged.
 */
export async function resolveForegroundAppWithRetry(
  attempts = 3,
  delayMs = 200,
  backgrounded: boolean,
): Promise<ForegroundAppInfo> {
  let last: ForegroundAppInfo = {
    packageName: 'unknown',
    appLabel: 'unknown',
    source: 'none',
  };

  const effectiveAttempts = backgrounded ? 1 : attempts;
  for (let i = 0; i < effectiveAttempts; i++) {
    last = await resolveForegroundApp();
    if (last.packageName !== 'unknown') {
      return last;
    }
    if (!backgrounded && i < effectiveAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return last;
}

/** @deprecated Prefer resolveForegroundApp() — does not throw when permission missing. */
export async function getCurrentForegroundApp(): Promise<ForegroundAppInfo | null> {
  const mod = getModule();
  if (!mod) {
    throw new Error(LINKING_ERROR);
  }
  return mod.getCurrentForegroundApp();
}
