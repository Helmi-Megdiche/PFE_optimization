import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import getScreenCaptureModule, {
  screenCaptureEmitter,
  SCREEN_CAPTURE_EVENTS,
  type ScreenCapturedEvent,
  type ScreenCaptureRejectedEvent,
  type ScreenCaptureTickEvent,
  type MonitoringRevokedEvent,
} from '../native/ScreenCapture';
import { keywordFilter } from '../utils/keywordFilter';
import { classifyImage } from '../services/imageClassifier';
import { extractTextMixed } from '../services/mixedScriptOcr';
import {resetActiveArabicRecognition} from '../services/mobileArabicOcr';
import { ApiAuthError } from '../services/apiClient';
import { postScreenEvent } from '../services/screenEventsApi';
import { clearStaleNotificationMissionLaunch } from '../missions/missionNotificationLaunch';
import { presentMissionFromCapture } from '../missions/presentMissionFromCapture';
import { withTimeout } from '../utils/withTimeout';
import {
  applyExplicitOcrBoost,
  applyPostProcessingOverride,
  combineRiskScores,
  computeOcrRiskScore,
  enforceCategoryConsistency,
  resolveFinalCategoryWithScore,
} from '../utils/riskCombination';
import { shouldCapFilteredSearchResults } from '../utils/riskySearchContext';
import {
  computeAdaptiveIntervalMs,
  computeEffectiveAdaptiveInterval,
  decideScrollSettle,
  decideTickAction,
  initialScrollSettleState,
  NATIVE_TICK_INTERVAL_MS,
  OCR_LOCK_LIVENESS_MS,
  pushRiskScore,
  recordScrollEvent,
  RISK_INTERVAL_LOW_MS,
  SCROLL_SETTLE_COOLDOWN_MS,
  SCROLL_SETTLE_MS,
  type ProcessingPhase,
  type ScrollSettleState,
} from '../utils/adaptiveCapture';
import {
  APP_OWN_PACKAGE,
  resolveEffectiveForegroundForSwitch,
  shouldCaptureAfterLauncherReturn,
} from '../utils/appSwitchCapture';
import { getAppCategory, isLauncherPackage, type AppCategory } from '../utils/appCapturePolicy';
import {
  inferAppPackageFromOcr,
  shouldOverridePackageWithOcrInference,
} from '../utils/inferAppPackageFromOcr';
import { shouldNeutralizeLauncherWidgetCapture } from '../utils/launcherCaptureContext';
import {
  markMonitoringStarted,
  resetMissionPresentationGuard,
  shouldPresentMissionFromCapture,
} from '../utils/missionPresentationGuard';
import { scError, scLog, scWarn } from '../utils/screenCaptureLogger';
import { detectCaptureQuality } from '../utils/captureQuality';
import { isDevOverlayOcrText } from '../utils/devOverlayOcr';
import { shouldSkipScreenEventReporting } from '../utils/benignRiskContext';
import { toMlKitImageUri } from '../utils/imageUri';
import { setLastCapturePath } from '../utils/lastCapturePath';
import {
  hasUsageAccess,
  isForegroundLookupStuck,
  openUsageAccessSettings,
  resetForegroundLookup,
  resolveForegroundApp,
  resolveForegroundAppWithRetry,
} from '../native/ForegroundApp';
import {
  checkMissionCaptureSessionBackstop,
  isMissionCapturePaused,
  payOwedMissionCaptureResume,
  registerMissionCaptureHandlers,
  resetMissionCaptureSession,
  unregisterMissionCaptureHandlers,
} from '../utils/missionCaptureSession';
import {
  CAPTURE_DEBOUNCE_MS,
  createCaptureCoordinator,
  CaptureReason,
  type CaptureCoordinator,
  type NativeRejectionReason,
} from '../capture/captureCoordinator';
import { createWindowEventFilter, isImePackage } from '../capture/windowEventFilter';
import { createA11yHealthTracker, type A11yHealth } from '../capture/a11yHealth';
import { useAccessibilityEvents } from './useAccessibilityEvents';
import { isAccessibilityServiceEnabled } from '../native/SafeGuardAccessibility';
import type {
  AccessibilityKeyboardChangedEvent,
  AccessibilityScrollEvent,
  AccessibilityWindowChangedEvent,
} from '../native/SafeGuardAccessibility';
import type {
  CaptureCycleResult,
  ScreenEventPayload,
  ScreenshotCaptureConfig,
} from '../types/screenMonitor';

const APP_POLL_MS = 1_000;
const FOLLOW_UP_DELAY_MS = 5_000;
const DEFAULT_MAX_TEXT = 500;
/**
 * When accessibility is connected, app-switch captures are driven by its window
 * events and the 1s poll's own app-switch triggers are suppressed. If those events
 * go silent for this long (service crashed/unbound while the app stayed foreground,
 * before the next AppState→active refresh flips `connected`), the poll resumes
 * firing so monitoring never goes blind.
 */
const A11Y_STALE_MS = 60_000;

/** Never cache or report System UI / launchers — they stick after consent or home. */
const SYSTEM_UI_PACKAGE = 'com.android.systemui';

/** Max age for cached foreground package when live lookup fails at capture time. */
const FOREGROUND_CACHE_MAX_AGE_MS = 30_000;
/** After a mission ends, reuse pre-pause Chrome/browser package if UsageStats is briefly null. */
const MISSION_FOREGROUND_GRACE_MS = 120_000;
/**
 * After a mission overlay ends, `resumeCapture` fires an immediate frame. If the risky page is
 * still visible this would instantly stack a second mission. Suppress *presenting* a mission from
 * capture for this window (risk events are still posted) so overlays don't fire back-to-back.
 */
const POST_MISSION_PRESENT_GRACE_MS = 10_000;
/** OCR + TFLite must finish within this window (Arabic Tesseract timeout is 25s). */
const VISION_PIPELINE_TIMEOUT_MS = 25_000;
const FOREGROUND_LOOKUP_TIMEOUT_MS = 2_500;
const API_POST_TIMEOUT_MS = 12_000;
/** Force-release OCR lock if a frame handler never settles (prevents permanent capture stall). */
const FRAME_PROCESSING_WATCHDOG_MS = 25_000;
/**
 * If a new frame arrives while OCR is still marked busy past this age, take over:
 * bump generation (stale in-flight work aborts) and process the newer frame.
 */
const OCR_LOCK_TAKEOVER_MS = 8_000;

function isUsableForegroundPackage(pkg: string | null | undefined): pkg is string {
  if (!pkg || pkg === 'unknown' || pkg === SYSTEM_UI_PACKAGE) {
    return false;
  }
  if (pkg.includes('launcher')) {
    return false;
  }
  return true;
}

interface UseScreenshotCaptureOptions extends ScreenshotCaptureConfig {
  onCycleComplete?: (result: CaptureCycleResult) => void;
}

function truncateText(text: string, maxLen: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return trimmed.slice(0, maxLen);
}

async function logNativeDebugState(label: string): Promise<void> {
  try {
    const state = await getScreenCaptureModule().getDebugState();
    scLog(`Native state @ ${label}`, state);
  } catch (err) {
    scWarn(`getDebugState failed @ ${label}`, err);
  }
}

export function useScreenshotCapture(options: UseScreenshotCaptureOptions = {}) {
  const {
    intervalMs = RISK_INTERVAL_LOW_MS,
    maxTextLength = DEFAULT_MAX_TEXT,
    onCycleComplete,
  } = options;

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [usageAccessGranted, setUsageAccessGranted] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastCaptureAt, setLastCaptureAt] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [lastForegroundApp, setLastForegroundApp] = useState<string | null>(null);
  const [dynamicIntervalMs, setDynamicIntervalMs] = useState(RISK_INTERVAL_LOW_MS);
  const [appCategory, setAppCategory] = useState<AppCategory | null>(null);
  const [avgRiskScore, setAvgRiskScore] = useState<number | null>(null);
  /** Evidence-based accessibility-service health for the Monitor card (observability only). */
  const [a11yHealth, setA11yHealth] = useState<A11yHealth>('off');

  const isProcessingRef = useRef(false);
  const processingStartTimeRef = useRef(0);
  const processingGenerationRef = useRef(0);
  /**
   * D1: which guarded region of `processCapturedFrame` the current frame is in
   * (backgrounded-safe substitute for the frozen-timer `withTimeout` guards —
   * see `adaptiveCapture.ts`'s "Per-phase capture deadlines" block). Written
   * 1:1 with `processingStartTimeRef`: set wherever that ref is set to
   * `Date.now()`, reset to `{ phase: 'idle', startedAtMs: 0 }` wherever that
   * ref is reset to `0`. A missed reset degrades to the 60s absolute backstop
   * (see `shouldForceReleasePhase`'s anti-stale guard), never to a spurious
   * release.
   */
  const processingPhaseRef = useRef<{
    phase: ProcessingPhase;
    startedAtMs: number;
  }>({ phase: 'idle', startedAtMs: 0 });
  /** Latest frame deferred while OCR was busy — processed after current finishes. */
  const pendingFrameRef = useRef<ScreenCapturedEvent | null>(null);
  const processCapturedFrameRef = useRef<
    (event: ScreenCapturedEvent) => Promise<CaptureCycleResult>
  >(async () => ({ success: false }));
  const isStartingRef = useRef(false);
  const isMonitoringRef = useRef(false);
  const lastAppPackageRef = useRef<string | null>(null);
  const lastAppPackageUpdatedAtRef = useRef(0);
  const missionEndedAtRef = useRef(0);
  const foregroundAtPauseRef = useRef<string | null>(null);

  const riskHistoryRef = useRef<number[]>([]);
  /** Current effective adaptive interval (0 = category disables periodic capture). */
  const dynamicIntervalMsRef = useRef(RISK_INTERVAL_LOW_MS);
  /** Wall-clock of the last native tick that passed the subsample gate. */
  const lastPeriodicPassAtRef = useRef(Number.NEGATIVE_INFINITY);
  /** A3c-3 tick-driven scroll-settle state (armed by `onAccessibilityScroll`). */
  const scrollSettleStateRef = useRef<ScrollSettleState>(initialScrollSettleState());
  const followUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const visitedLauncherRef = useRef(false);

  /** Accessibility window-event driven app-switch path (falls back to the 1s poll). */
  const windowEventFilterRef = useRef(
    createWindowEventFilter({ now: () => Date.now() }),
  );
  const a11yConnectedRef = useRef(false);
  /** Wall-clock of the last window event *received* (pre-filter) — poll staleness watchdog. */
  const lastA11yWindowEventAtMs = useRef(0);
  /** Last keyboard visibility we pushed to the coordinator — lets us detect a stuck latch. */
  const a11yKeyboardVisibleRef = useRef(false);
  /**
   * Evidence-based health of the accessibility feed: a poll-observed app switch
   * the window feed did not deliver flips this to `degraded`. Observability only —
   * `A11Y_STALE_MS` / `a11yDriving` and every capture decision are unaffected.
   */
  const a11yHealthRef = useRef(
    createA11yHealthTracker({ now: () => Date.now() }),
  );
  const syncA11yHealth = useCallback(() => {
    setA11yHealth(a11yHealthRef.current.getHealth());
  }, []);

  const coordinatorRef = useRef<CaptureCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createCaptureCoordinator({
      now: () => Date.now(),
      isMonitoring: () => isMonitoringRef.current,
      isMissionPaused: isMissionCapturePaused,
      isProcessing: () => isProcessingRef.current,
      log: (event, data) => scLog(event, data),
    });
  }

  useEffect(() => {
    isMonitoringRef.current = isMonitoring;
  }, [isMonitoring]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }
    const logSub = screenCaptureEmitter.addListener(
      SCREEN_CAPTURE_EVENTS.log,
      (event: { message: string }) => {
        scLog(`[Native] ${event.message}`);
      },
    );
    scLog('Hook mounted — listening for native logs');
    void logNativeDebugState('mount');
    return () => {
      logSub.remove();
      scLog('Hook unmounted');
    };
  }, []);

  const clearCaptureTimers = useCallback(() => {
    if (followUpTimerRef.current) {
      clearTimeout(followUpTimerRef.current);
      followUpTimerRef.current = null;
    }
  }, []);

  const clearAdaptiveTimers = useCallback(() => {
    clearCaptureTimers();
    if (appPollTimerRef.current) {
      clearInterval(appPollTimerRef.current);
      appPollTimerRef.current = null;
    }
  }, [clearCaptureTimers]);

  const tryCaptureNow = useCallback(
    async (reason: CaptureReason): Promise<void> => {
      const decision = coordinatorRef.current!.requestCapture(reason);
      if (!decision.allowed) {
        return;
      }
      // decision.force covers both a genuine tier-0 reason and a paid-down A3d
      // owed-force debt (a tier-0 switch the debounce dropped earlier) — either
      // way the coordinator has decided this frame must bypass the hash gate.
      if (decision.force) {
        getScreenCaptureModule()
          .forceNextCapture()
          .catch(err => scWarn('forceNextCapture failed', {reason, err}));
      }
      try {
        const triggered = await getScreenCaptureModule().captureNow();
        if (triggered) {
          scLog('Capture triggered', { reason });
        }
      } catch (err) {
        scWarn('captureNow failed', { reason, err });
      }
    },
    [],
  );

  const applyEffectiveInterval = useCallback(
    (reason: string) => {
      const pkg = lastAppPackageRef.current;
      const riskOnlyInterval = computeAdaptiveIntervalMs(riskHistoryRef.current);
      const effectiveInterval = computeEffectiveAdaptiveInterval(
        riskHistoryRef.current,
        pkg,
      );
      const category =
        pkg && isUsableForegroundPackage(pkg) ? getAppCategory(pkg) : null;
      setAppCategory(category);

      if (effectiveInterval === dynamicIntervalMsRef.current) {
        return;
      }

      dynamicIntervalMsRef.current = effectiveInterval;
      setDynamicIntervalMs(effectiveInterval);

      const avg =
        riskHistoryRef.current.length > 0
          ? Math.round(
              riskHistoryRef.current.reduce((sum, s) => sum + s, 0) /
                riskHistoryRef.current.length,
            )
          : null;
      if (avg != null) {
        setAvgRiskScore(avg);
      }

      scLog('Adaptive interval changed', {
        reason,
        avgRisk: avg,
        history: [...riskHistoryRef.current],
        appPackage: pkg,
        appCategory: category,
        riskOnlyIntervalMs: riskOnlyInterval,
        effectiveIntervalMs: effectiveInterval,
      });
      // No timer to restart — the native periodic tick handler reads
      // dynamicIntervalMsRef fresh on every tick (0 = periodic disabled).
    },
    [],
  );

  const updateRiskAndInterval = useCallback(
    (newRiskScore: number) => {
      riskHistoryRef.current = pushRiskScore(riskHistoryRef.current, newRiskScore);
      const avg = Math.round(
        riskHistoryRef.current.reduce((sum, s) => sum + s, 0) /
          riskHistoryRef.current.length,
      );
      setAvgRiskScore(avg);
      applyEffectiveInterval('risk_score');
    },
    [applyEffectiveInterval],
  );

  const refreshIntervalForApp = useCallback(() => {
    applyEffectiveInterval('app_switch');
  }, [applyEffectiveInterval]);

  const scheduleFollowUpCapture = useCallback(
    (delayMs: number) => {
      if (followUpTimerRef.current) {
        clearTimeout(followUpTimerRef.current);
      }
      followUpTimerRef.current = setTimeout(() => {
        followUpTimerRef.current = null;
        void tryCaptureNow(CaptureReason.APP_SWITCH_FOLLOW_UP);
      }, delayMs);
      scLog('Follow-up capture scheduled', { delayMs });
    },
    [tryCaptureNow],
  );

  const triggerAppSwitchCapture = useCallback(
    async (reason: CaptureReason): Promise<void> => {
      await tryCaptureNow(reason);
      scheduleFollowUpCapture(FOLLOW_UP_DELAY_MS);
    },
    [tryCaptureNow, scheduleFollowUpCapture],
  );

  /**
   * Accessibility window event — the fast app-switch path. When connected this
   * replaces the 1s poll's package-change trigger (the poll keeps running for its
   * foreground-cache side effects). Every event bumps the liveness timestamp before
   * filtering, so even filtered events keep the poll suppressed.
   */
  const handleA11yWindowChanged = useCallback(
    (event: AccessibilityWindowChangedEvent) => {
      checkMissionCaptureSessionBackstop();
      payOwedMissionCaptureResume();
      lastA11yWindowEventAtMs.current = Date.now();
      a11yHealthRef.current.onWindowEvent();
      syncA11yHealth();
      if (!a11yConnectedRef.current) {
        return;
      }
      if (!isMonitoringRef.current || isMissionCapturePaused()) {
        return;
      }
      const filter = windowEventFilterRef.current;
      const previousPkg = filter.getLastAcceptedPackage();
      const decision = filter.accept(event.packageName);
      if (!decision.accept) {
        scLog('a11y.window.filtered', {
          packageName: event.packageName,
          reason: decision.reason,
        });
        return;
      }

      const pkg = event.packageName;
      const wasLauncher = previousPkg !== null && isLauncherPackage(previousPkg);
      const nowLauncher = isLauncherPackage(pkg);

      // Keep attribution current — mirrors the poll's writes at the tail of its tick.
      if (
        isUsableForegroundPackage(pkg) &&
        pkg !== APP_OWN_PACKAGE &&
        !nowLauncher
      ) {
        lastAppPackageRef.current = pkg;
        lastAppPackageUpdatedAtRef.current = Date.now();
        setLastForegroundApp(pkg);
      }

      // An arm must not carry across an app switch: with defer-not-drop a stale
      // arm can outlive the switch and emit a SCROLL_SETTLED mislabeled against
      // the new app's screen. The app-switch capture already grabs it.
      scrollSettleStateRef.current = initialScrollSettleState();

      const reason =
        wasLauncher && !nowLauncher
          ? CaptureReason.APP_SWITCH_LAUNCHER_RETURN
          : CaptureReason.APP_SWITCH;
      scLog('a11y.window.accepted', { from: previousPkg, to: pkg, reason });
      void triggerAppSwitchCapture(reason);
      refreshIntervalForApp();
    },
    [triggerAppSwitchCapture, refreshIntervalForApp, syncA11yHealth],
  );

  /**
   * Accessibility keyboard event — drives the coordinator's routine-capture
   * suppression while the soft keyboard is up. Firing a capture on keyboard-close is
   * deliberately NOT done here; no settle timer.
   */
  const handleA11yKeyboardChanged = useCallback(
    (event: AccessibilityKeyboardChangedEvent) => {
      coordinatorRef.current!.setKeyboardVisible(event.visible);
      a11yKeyboardVisibleRef.current = event.visible;
    },
    [],
  );

  /**
   * Accessibility scroll event (A3c-3) — arms the tick-driven scroll-settle. The
   * decision (emit / defer / disarm) is made in the native tick handler by the
   * pure `decideScrollSettle`; nothing here starts a timer (RN freezes JS timers
   * while backgrounded). Drops events from our own window, an IME package, or
   * while the keyboard is up (no fresh `getWindows()` — the cached flag), and
   * while not monitoring / mission-paused (mirrors the window handler).
   */
  const handleA11yScroll = useCallback((event: AccessibilityScrollEvent) => {
    if (!isMonitoringRef.current || isMissionCapturePaused()) {
      return;
    }
    const pkg = event.packageName || '';
    if (
      pkg === APP_OWN_PACKAGE ||
      isImePackage(pkg) ||
      a11yKeyboardVisibleRef.current
    ) {
      return;
    }
    scrollSettleStateRef.current = recordScrollEvent(
      scrollSettleStateRef.current,
      event.timestamp,
    );
  }, []);

  const { connected: a11yConnected } = useAccessibilityEvents({
    onWindowChanged: handleA11yWindowChanged,
    onKeyboardChanged: handleA11yKeyboardChanged,
    onScroll: handleA11yScroll,
  });

  useEffect(() => {
    const wasConnected = a11yConnectedRef.current;
    a11yConnectedRef.current = a11yConnected;
    a11yHealthRef.current.setEnabled(a11yConnected);
    syncA11yHealth();
    if (wasConnected && !a11yConnected) {
      // Service disconnected/unbound/crashed. If the keyboard was open, no
      // visible:false will ever arrive — clear the latch so routine captures
      // (PERIODIC_*, CONTENT_CHANGE, SCROLL_SETTLED) are not suppressed forever.
      coordinatorRef.current!.setKeyboardVisible(false);
      a11yKeyboardVisibleRef.current = false;
      scLog('a11y disconnected — keyboard suppression latch cleared');
    }
  }, [a11yConnected, syncA11yHealth]);

  /**
   * Force-release a wedged processing lock (any never-settling `await` in
   * `processCapturedFrame` — vision pass or the foreground-lookup IPC — can latch
   * it). Touches only hook-scoped refs, so it is safe to call from any closure —
   * the heartbeat (foregrounded) and the native periodic tick (the only recovery
   * path that keeps running while backgrounded).
   * Bumping the generation makes a stale in-flight run abort at its next
   * `isActive()` checkpoint and turns its `finally` lock-release into a no-op,
   * exactly as the `processingWatchdog` setTimeout already does today.
   */
  const forceReleaseProcessingLock = useCallback((cause: string) => {
    const elapsed =
      processingStartTimeRef.current > 0
        ? Date.now() - processingStartTimeRef.current
        : 0;
    const { phase } = processingPhaseRef.current;
    processingGenerationRef.current += 1;
    isProcessingRef.current = false;
    processingStartTimeRef.current = 0;
    processingPhaseRef.current = { phase: 'idle', startedAtMs: 0 };
    scWarn('Processing lock force-released after hung frame', {
      cause,
      elapsed,
      phase,
      appState: AppState.currentState,
    });
  }, []);

  /**
   * D1: advances `processingPhaseRef` and logs the phase being *left* with its
   * duration — logging on exit (not entry) is what lets `frame.phase` answer
   * "how long did `vision` actually take backgrounded", which is the evidence
   * Debt 1 needs before a `vision` deadline can be set. Also doubles as the JS
   * half of the app-switch-burst instrumentation (recon §2): `appState` on
   * each transition shows whether wedges cluster on backgrounded-at-phase-start.
   */
  const setPhase = useCallback((next: ProcessingPhase) => {
    const now = Date.now();
    const prev = processingPhaseRef.current;
    scLog('frame.phase', {
      from: prev.phase,
      to: next,
      appState: AppState.currentState,
      ...(prev.startedAtMs > 0 ? { prevPhaseMs: now - prev.startedAtMs } : {}),
    });
    processingPhaseRef.current = { phase: next, startedAtMs: now };
  }, []);

  const processCapturedFrame = useCallback(
    async (event: ScreenCapturedEvent): Promise<CaptureCycleResult> => {
      if (isMissionCapturePaused()) {
        scLog('Frame skipped — mission in progress');
        return { success: false, skippedReason: 'mission' };
      }

      if (isProcessingRef.current) {
        const elapsed = Date.now() - processingStartTimeRef.current;
        if (elapsed >= OCR_LOCK_TAKEOVER_MS) {
          processingGenerationRef.current += 1;
          isProcessingRef.current = false;
          processingStartTimeRef.current = 0;
          processingPhaseRef.current = { phase: 'idle', startedAtMs: 0 };
          pendingFrameRef.current = null;
          scWarn('OCR lock takeover — previous frame hung', { elapsedMs: elapsed });
        } else {
          // Keep only the newest deferred frame; avoids LogBox spam from console.warn.
          pendingFrameRef.current = event;
          scLog('Frame deferred — OCR in progress', { elapsedMs: elapsed });
          return { success: false, skippedReason: 'ocr' };
        }
      }

      const generation = ++processingGenerationRef.current;
      isProcessingRef.current = true;
      processingStartTimeRef.current = Date.now();
      setPhase('foreground_lookup');
      const { filePath, imageUri, appPackage } = event;
      const isActive = () => processingGenerationRef.current === generation;

      const processingWatchdog = setTimeout(() => {
        if (!isActive()) {
          return;
        }
        processingGenerationRef.current += 1;
        isProcessingRef.current = false;
        processingStartTimeRef.current = 0;
        processingPhaseRef.current = { phase: 'idle', startedAtMs: 0 };
        scWarn('Processing watchdog — stale frame aborted', {
          filePath,
          timeoutMs: FRAME_PROCESSING_WATCHDOG_MS,
        });
      }, FRAME_PROCESSING_WATCHDOG_MS);

      let processingHeartbeat: ReturnType<typeof setInterval> | undefined;
      processingHeartbeat = setInterval(() => {
        if (!isProcessingRef.current || processingStartTimeRef.current === 0) {
          if (processingHeartbeat !== undefined) {
            clearInterval(processingHeartbeat);
            processingHeartbeat = undefined;
          }
          return;
        }
        const elapsed = Date.now() - processingStartTimeRef.current;
        if (elapsed > FRAME_PROCESSING_WATCHDOG_MS) {
          forceReleaseProcessingLock('heartbeat');
          if (processingHeartbeat !== undefined) {
            clearInterval(processingHeartbeat);
            processingHeartbeat = undefined;
          }
        }
      }, 5_000);

      try {
        setLastCapturePath(filePath);
        const ocrInput = toMlKitImageUri(imageUri ?? filePath);
        scLog('Frame received', { filePath, imageUri: ocrInput, appPackage });

        const cacheAgeMs = Date.now() - lastAppPackageUpdatedAtRef.current;
        const cacheFresh = cacheAgeMs <= FOREGROUND_CACHE_MAX_AGE_MS;
        const ownAppInBackground = AppState.currentState !== 'active';
        const cacheablePackage =
          isUsableForegroundPackage(lastAppPackageRef.current) &&
          lastAppPackageRef.current !== APP_OWN_PACKAGE &&
          !isLauncherPackage(lastAppPackageRef.current)
            ? lastAppPackageRef.current
            : null;
        const cachedPollPackage =
          cacheablePackage !== null && cacheFresh && !ownAppInBackground
            ? cacheablePackage
            : null;

        const graceCachedPackage =
          cachedPollPackage === null &&
          cacheablePackage !== null &&
          cacheAgeMs <= MISSION_FOREGROUND_GRACE_MS &&
          !ownAppInBackground
            ? cacheablePackage
            : null;

        let fg: { packageName: string; appLabel: string; source?: string };
        if (cachedPollPackage !== null) {
          fg = { packageName: cachedPollPackage, appLabel: cachedPollPackage, source: 'usage_stats' };
        } else if (graceCachedPackage !== null) {
          fg = { packageName: graceCachedPackage, appLabel: graceCachedPackage, source: 'cached_poll' };
        } else if (Platform.OS === 'android') {
          if (isForegroundLookupStuck()) {
            // Background: RN freezes JS timers, so a wedged UsageStats IPC can't time out and would
            // otherwise hang every frame forever. Don't await it — kick a fresh self-healing lookup
            // and attribute this frame as unknown. Risk detection must never block on attribution.
            scWarn('Foreground lookup wedged — skipping await, attributing unknown');
            void resolveForegroundApp();
            fg = { packageName: 'unknown', appLabel: 'unknown', source: 'none' };
          } else {
            fg = await withTimeout(
              resolveForegroundAppWithRetry(3, 200),
              FOREGROUND_LOOKUP_TIMEOUT_MS,
              { packageName: 'unknown', appLabel: 'unknown', source: 'none' },
            );
          }
        } else {
          fg = { packageName: 'unknown', appLabel: 'unknown', source: 'none' };
        }

        if (cachedPollPackage !== null) {
          scLog('Foreground cache hit — skipped UsageStats lookup', {
            package: cachedPollPackage,
            cacheAgeMs,
          });
        } else if (graceCachedPackage !== null) {
          scLog('Foreground grace cache hit — skipped UsageStats lookup', {
            package: graceCachedPackage,
            cacheAgeMs,
          });
        }

        const fgPackage = isUsableForegroundPackage(fg.packageName) ? fg.packageName : null;
        const eventPackage = isUsableForegroundPackage(appPackage) ? appPackage : null;
        const missionGraceActive =
          missionEndedAtRef.current > 0 &&
          Date.now() - missionEndedAtRef.current < MISSION_FOREGROUND_GRACE_MS;
        const gracePackage =
          missionGraceActive && isUsableForegroundPackage(foregroundAtPauseRef.current)
            ? foregroundAtPauseRef.current
            : missionGraceActive && isUsableForegroundPackage(lastAppPackageRef.current)
              ? lastAppPackageRef.current
              : null;

        let cachedPackage: string | null = null;
        if (cacheablePackage !== null && cacheFresh && !ownAppInBackground) {
          cachedPackage = cacheablePackage;
        } else if (gracePackage && !fgPackage) {
          cachedPackage = gracePackage;
          scLog('Foreground cache reused — post-mission grace', {
            package: gracePackage,
            cacheAgeMs,
          });
        } else if (
          !fgPackage &&
          cacheablePackage !== null &&
          !cacheFresh &&
          cacheAgeMs <= MISSION_FOREGROUND_GRACE_MS &&
          !ownAppInBackground
        ) {
          cachedPackage = cacheablePackage;
          scLog('Foreground cache reused — extended attribution window', {
            package: cachedPackage,
            cacheAgeMs,
          });
        } else if (
          !fgPackage &&
          isUsableForegroundPackage(lastAppPackageRef.current) &&
          !cacheFresh
        ) {
          scWarn('Foreground cache stale — live lookup failed; not reusing old app', {
            cached: lastAppPackageRef.current,
            cacheAgeMs,
          });
        }

        if (!isActive()) {
          scWarn('Stale frame aborted — before vision', { filePath });
          return { success: false, skippedReason: 'stale' };
        }

        const resolvedPackage = fgPackage ?? eventPackage ?? cachedPackage ?? 'unknown';

        const resolvedLabel =
          fgPackage &&
          fg.appLabel &&
          fg.appLabel !== 'unknown' &&
          fgPackage === resolvedPackage
            ? fg.appLabel
            : resolvedPackage;

        if (fgPackage) {
          lastAppPackageRef.current = fgPackage;
          lastAppPackageUpdatedAtRef.current = Date.now();
        }

        scLog('Foreground app', {
          package: resolvedPackage,
          label: resolvedLabel,
          source: fgPackage
            ? fg.source
            : eventPackage === resolvedPackage
              ? 'capture_event'
              : cachedPackage === resolvedPackage
                ? 'cached_poll'
                : fg.source,
        });
        setLastForegroundApp(resolvedPackage);

        setPhase('vision');
        const visionResult = await withTimeout(
          Promise.all([
            extractTextMixed(ocrInput, { filePath, appPackage: resolvedPackage }),
            classifyImage(ocrInput, filePath),
          ]),
          VISION_PIPELINE_TIMEOUT_MS,
          null,
        );

        if (!isActive()) {
          scWarn('Stale frame aborted — after foreground', { filePath });
          return { success: false, skippedReason: 'stale' };
        }

        if (!visionResult) {
          scWarn('Vision pipeline timed out — frame skipped', {
            timeoutMs: VISION_PIPELINE_TIMEOUT_MS,
          });
          return { success: false, skippedReason: 'vision_timeout' };
        }

        const [ocrMixed, imageClassification] = visionResult;

        const fullText = ocrMixed.text ?? '';
        const cleanedForKeywords = ocrMixed.cleanedText ?? fullText;
        const preview = truncateText(cleanedForKeywords, maxTextLength);
        const normalizedText = ocrMixed.normalizedText
          ? truncateText(ocrMixed.normalizedText, maxTextLength)
          : undefined;
        scLog('OCR done', {
          chars: preview.length,
          preview: preview.slice(0, 80),
          source: ocrMixed.source,
          ...(__DEV__
            ? { arabic: ocrMixed.hasArabicScript, arabizi: ocrMixed.hasArabiziPattern }
            : {}),
        });

        const devOverlayOcr = __DEV__ && isDevOverlayOcrText(fullText);
        if (devOverlayOcr) {
          scLog('OCR suppressed — React Native / Metro dev overlay detected');
        }

        const keywordResult = devOverlayOcr
          ? { riskFlag: false, category: 'educational' as const, matchedKeywords: [] as string[] }
          : keywordFilter(preview, normalizedText);

        if (keywordResult.riskFlag && __DEV__) {
          // eslint-disable-next-line no-console
          console.log('[Risk] Matched keywords:', keywordResult.matchedKeywords);
        }

        const ocrRiskScore = devOverlayOcr
          ? 0
          : computeOcrRiskScore(
              keywordResult.riskFlag,
              keywordResult.category,
              keywordResult.matchedKeywords.length,
            );
        let imageRiskScore =
          imageClassification.imageClassificationDetails?.imageRiskScore ??
          imageClassification.imageRiskScore;

        const tfliteNsfwScore = imageClassification.imageRiskScore;
        let combinedRiskScore: number;
        let postProcessedCategory: string;

        if (
          shouldCapFilteredSearchResults(cleanedForKeywords, tfliteNsfwScore, {
            matchedKeywords: keywordResult.matchedKeywords,
          })
        ) {
          scLog('[Risk] Filtered UI + low TFLite — capping final combined risk');
          imageRiskScore = Math.min(imageRiskScore, 20);
          combinedRiskScore = Math.min(combineRiskScores(ocrRiskScore, imageRiskScore), 25);
          postProcessedCategory = 'neutral';
        } else {
          const boosted = applyExplicitOcrBoost(
            ocrRiskScore,
            imageRiskScore,
            keywordResult.category,
            imageClassification.adultScore,
          );
          imageRiskScore = boosted.imageRiskScore;
          combinedRiskScore = boosted.combinedRiskScore;

          const postProcessed = applyPostProcessingOverride({
            combinedRiskScore,
            finalCategory: resolveFinalCategoryWithScore(
              combinedRiskScore,
              keywordResult.riskFlag,
              imageClassification,
              keywordResult.category,
              imageClassification.imageClassificationDetails?.mappedCategory,
            ),
            ocrCategory: keywordResult.category,
            keywordRiskFlag: keywordResult.riskFlag,
            matchedKeywords: keywordResult.matchedKeywords,
          });
          combinedRiskScore = postProcessed.combinedRiskScore;
          postProcessedCategory = postProcessed.finalCategory;
        }

        let finalRiskFlag = combinedRiskScore > 50;
        let finalCategory = enforceCategoryConsistency(
          combinedRiskScore,
          finalRiskFlag,
          postProcessedCategory,
          imageClassification,
          keywordResult.category,
        );

        let attributionPackage = resolvedPackage;
        let attributionLabel = resolvedLabel;
        const inferred = inferAppPackageFromOcr(cleanedForKeywords);
        if (
          inferred &&
          shouldOverridePackageWithOcrInference(
            resolvedPackage,
            inferred,
            cleanedForKeywords,
          )
        ) {
          attributionPackage = inferred;
          attributionLabel = inferred;
          lastAppPackageRef.current = inferred;
          lastAppPackageUpdatedAtRef.current = Date.now();
          scLog('Package inferred from OCR (foreground misreport)', {
            usageStatsPackage: resolvedPackage,
            inferredPackage: inferred,
          });
        }

        if (shouldNeutralizeLauncherWidgetCapture(attributionPackage, cleanedForKeywords)) {
          scLog('Launcher recents/widget OCR — risk neutralized (open Chrome for enforcement)', {
            package: attributionPackage,
            preview: preview.slice(0, 80),
          });
          finalRiskFlag = false;
          finalCategory = 'neutral';
          combinedRiskScore = Math.min(combinedRiskScore, 25);
        }

        const details = imageClassification.imageClassificationDetails ?? {};
        const captureQuality = detectCaptureQuality(
          details.mlKitLabels,
          imageClassification.adultScore ?? 0,
          fullText.length,
        );
        if (captureQuality === 'blank_or_protected') {
          scWarn(
            'Capture may be blank or protected (Incognito/DRM?) — TFLite saw little content; try normal Chrome tab + app-switch capture',
            { labels: details.mlKitLabels?.slice(0, 4) },
          );
        }

        if (shouldSkipScreenEventReporting(fullText)) {
          scLog('Screen event skipped — mission / game UI OCR');
          return;
        }

        if (!isMonitoringRef.current) {
          scLog('Screen event skipped — monitoring stopped during OCR');
          return;
        }

        const payload: ScreenEventPayload = {
          timestamp: new Date().toISOString(),
          appPackage: attributionPackage,
          appLabel: attributionLabel,
          extractedTextPreview: preview,
          riskFlag: finalRiskFlag,
          riskScore: combinedRiskScore,
          imageRiskScore,
          combinedRiskScore,
          imageClassificationDetails: {
            ...details,
            captureQualityHint: captureQuality,
          },
          category: finalCategory,
        };

        scLog('Combined risk', {
          ocrRiskScore,
          imageRiskScore,
          combinedRiskScore,
          finalRiskFlag,
          category: finalCategory,
        });

        if (!isActive()) {
          scWarn('Stale frame aborted — before API post', { filePath });
          return { success: false, skippedReason: 'stale' };
        }

        setPhase('api_post');
        const screenEventResponse = await withTimeout(
          postScreenEvent(payload),
          API_POST_TIMEOUT_MS,
          null,
        );
        if (!screenEventResponse) {
          scWarn('POST /api/screen-events timed out', { timeoutMs: API_POST_TIMEOUT_MS });
          return { success: false, skippedReason: 'api_timeout' };
        }
        scLog('POST /api/screen-events OK');

        if (!isActive()) {
          scWarn('Stale frame aborted — mission presentation skipped', { filePath });
          return { success: true, skippedReason: 'stale' };
        }

        if (screenEventResponse.newMission?.id) {
          const nm = screenEventResponse.newMission;
          if (isLauncherPackage(attributionPackage)) {
            scLog('Mission presentation skipped — home/launcher foreground', {
              missionId: nm.id,
              package: attributionPackage,
            });
          } else if (
            missionEndedAtRef.current > 0 &&
            Date.now() - missionEndedAtRef.current < POST_MISSION_PRESENT_GRACE_MS
          ) {
            scLog('Mission presentation skipped — post-mission grace', {
              missionId: nm.id,
              sinceMissionEndMs: Date.now() - missionEndedAtRef.current,
            });
          } else if (
            shouldPresentMissionFromCapture(nm.id, { reSurfaced: nm.reSurfaced })
          ) {
            scLog('New mission from screen event — presenting mission UI', {
              missionId: nm.id,
              title: nm.title,
              reSurfaced: nm.reSurfaced ?? false,
            });
            void presentMissionFromCapture(
              {
                missionId: nm.id,
                title: nm.title,
                description: nm.description,
                points: nm.points,
                missionType: String(nm.type ?? nm.metadata?.type ?? 'real_world'),
                metadata: (nm.metadata ?? {}) as Record<string, unknown>,
              },
              { reSurfaced: nm.reSurfaced },
            );
          } else {
            scLog('Mission presentation skipped — debounce or startup grace', {
              missionId: nm.id,
              reSurfaced: nm.reSurfaced ?? false,
            });
          }
        } else if (screenEventResponse.missionGeneration) {
          scLog(
            finalRiskFlag ? 'Risky capture — no mission overlay' : 'No new mission',
            screenEventResponse.missionGeneration,
          );
        } else if (finalRiskFlag) {
          scLog('Risky capture — no mission in API response', { combinedRiskScore });
        }
        setLastCaptureAt(payload.timestamp);
        coordinatorRef.current!.onFrameAccepted(Date.now());
        setLastError(null);

        updateRiskAndInterval(combinedRiskScore);

        return { success: true, event: payload };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ApiAuthError) {
          // Avoid RN redbox for expected session expiry; apiClient already refreshes JWT.
          scWarn('processCapturedFrame skipped — auth', message);
          setLastError(message);
          return { success: false, skippedReason: 'auth', error: message };
        }
        scError('processCapturedFrame failed', err);
        if (message.toLowerCase().includes('storage')) {
          return { success: false, skippedReason: 'storage', error: message };
        }
        setLastError(message);
        return { success: false, error: message };
      } finally {
        clearTimeout(processingWatchdog);
        if (processingHeartbeat !== undefined) {
          clearInterval(processingHeartbeat);
        }
        // D3: all three resets are generation-guarded. A superseded frame's
        // `finally` running late (after a force-release / watchdog / OCR-lock
        // takeover bumped the generation and a newer frame is now active) must
        // not touch the active frame's lock, start timestamp, or phase. A stray
        // `processingStartTimeRef.current = 0` here silently disables the 60s
        // liveness backstop for that active frame (`shouldForceReleaseProcessingLock`
        // early-returns on `<= 0`), forces a spurious OCR-lock takeover, and
        // makes its heartbeat self-terminate.
        if (processingGenerationRef.current === generation) {
          isProcessingRef.current = false;
          processingStartTimeRef.current = 0;
          setPhase('idle');
        }
        const deferredFrame = pendingFrameRef.current;
        pendingFrameRef.current = null;
        if (
          deferredFrame &&
          !isProcessingRef.current &&
          isMonitoringRef.current &&
          !isMissionCapturePaused()
        ) {
          scLog('Processing deferred frame after OCR unlock');
          setTimeout(() => {
            void processCapturedFrameRef.current(deferredFrame);
          }, 0);
        } else if (
          coordinatorRef.current!.takePendingReason() != null &&
          isMonitoringRef.current
        ) {
          void triggerAppSwitchCapture(CaptureReason.APP_SWITCH_DEFERRED);
        }
        if (!__DEV__) {
          void getScreenCaptureModule().deleteFile(filePath).catch(() => undefined);
        }
      }
    },
    [
      maxTextLength,
      triggerAppSwitchCapture,
      updateRiskAndInterval,
      forceReleaseProcessingLock,
      setPhase,
    ],
  );

  processCapturedFrameRef.current = processCapturedFrame;

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') {
      setLastError('Screen monitoring is only supported on Android');
      return false;
    }
    scLog('requestPermission() start');
    await logNativeDebugState('before requestPermission');
    try {
      const native = getScreenCaptureModule();
      const alreadyGranted = await native.isPermissionGranted();
      if (alreadyGranted) {
        setPermissionGranted(true);
        return true;
      }

      const granted = await native.requestPermission();
      setPermissionGranted(granted);
      if (!granted) {
        setLastError(
          'Screen capture permission was not granted. Toggle monitoring off, then on again to retry.',
        );
      } else {
        setLastError(null);
      }
      return granted;
    } catch (err) {
      scError('requestPermission() threw', err);
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      return false;
    }
  }, []);

  const refreshUsageAccess = useCallback(async (): Promise<boolean> => {
    const ok = await hasUsageAccess();
    setUsageAccessGranted(ok);
    return ok;
  }, []);

  const refreshForegroundCache = useCallback(async (): Promise<void> => {
    const cacheAgeMs = Date.now() - lastAppPackageUpdatedAtRef.current;
    if (
      isUsableForegroundPackage(lastAppPackageRef.current) &&
      cacheAgeMs <= FOREGROUND_CACHE_MAX_AGE_MS
    ) {
      scLog('Foreground cache still fresh — skip refresh', {
        package: lastAppPackageRef.current,
        cacheAgeMs,
      });
      return;
    }

    const gracePackage = isUsableForegroundPackage(foregroundAtPauseRef.current)
      ? foregroundAtPauseRef.current
      : null;
    if (gracePackage) {
      lastAppPackageRef.current = gracePackage;
      lastAppPackageUpdatedAtRef.current = Date.now();
      setLastForegroundApp(gracePackage);
      scLog('Foreground cache restored from pre-mission app', { package: gracePackage });
      return;
    }

    const fg = await withTimeout(
      resolveForegroundApp(),
      FOREGROUND_LOOKUP_TIMEOUT_MS,
      { packageName: 'unknown', appLabel: 'unknown', source: 'none' as const },
    );
    if (isUsableForegroundPackage(fg.packageName) && !isLauncherPackage(fg.packageName)) {
      lastAppPackageRef.current = fg.packageName;
      lastAppPackageUpdatedAtRef.current = Date.now();
      setLastForegroundApp(fg.packageName);
      scLog('Foreground cache refreshed', {
        package: fg.packageName,
        label: fg.appLabel,
      });
      return;
    }

    scLog('Foreground cache refresh — no usable app (keeping last known if any)');
  }, []);

  const startSmartCaptureTimers = useCallback(() => {
    clearAdaptiveTimers();

    appPollTimerRef.current = setInterval(() => {
      // First thing, outside the async body: a tick gap wider than a frozen JS
      // thread means the a11y liveness clock is stale from the freeze, not from a
      // silent service. Re-seed it so the post-freeze tick is not a false miss.
      a11yHealthRef.current.onPollTick();
      void (async () => {
        const fg = await withTimeout(
          resolveForegroundApp(),
          FOREGROUND_LOOKUP_TIMEOUT_MS,
          { packageName: 'unknown', appLabel: 'unknown', source: 'none' as const },
        );
        const pkg = resolveEffectiveForegroundForSwitch(
          AppState.currentState,
          fg.packageName,
        );
        if (!pkg) {
          return;
        }

        const previousPkg = lastAppPackageRef.current;
        const socialCacheFresh =
          previousPkg !== null &&
          previousPkg !== APP_OWN_PACKAGE &&
          !isLauncherPackage(previousPkg) &&
          Date.now() - lastAppPackageUpdatedAtRef.current <= FOREGROUND_CACHE_MAX_AGE_MS;

        if (
          AppState.currentState !== 'active' &&
          fg.packageName === 'unknown' &&
          socialCacheFresh
        ) {
          visitedLauncherRef.current = true;
          return;
        }

        const appChanged = previousPkg !== null && pkg !== previousPkg;

        if (appChanged && pkg === APP_OWN_PACKAGE) {
          lastAppPackageRef.current = APP_OWN_PACKAGE;
          lastAppPackageUpdatedAtRef.current = Date.now();
          refreshIntervalForApp();
          return;
        }

        const launcherReturn = shouldCaptureAfterLauncherReturn(
          visitedLauncherRef.current,
          previousPkg,
          pkg,
        );

        // When accessibility is connected AND its window events are still flowing,
        // it owns the app-switch trigger; the poll only maintains the foreground
        // cache below. If those events go stale, the poll takes back over.
        const a11yDriving =
          a11yConnectedRef.current &&
          Date.now() - lastA11yWindowEventAtMs.current < A11Y_STALE_MS;

        // Observability only (does not gate any capture): if the poll saw a real
        // app switch the a11y window feed did not deliver within the grace
        // window, the service is bound-but-silent (or unbound) — surface it.
        if (
          (launcherReturn || appChanged) &&
          a11yHealthRef.current.onPollObservedSwitch()
        ) {
          scLog('a11y.health.degraded', { from: previousPkg, to: pkg });
          syncA11yHealth();
          // Distinguish "unbound" from "bound but silent" — one bridge call per proven miss.
          void isAccessibilityServiceEnabled().then((v) => {
            a11yHealthRef.current.setEnabled(v);
            syncA11yHealth();
          });
        }

        if (launcherReturn) {
          visitedLauncherRef.current = false;
          if (a11yDriving) {
            scLog('Poll app-switch trigger suppressed (a11y driving)', {
              package: pkg,
              kind: 'launcher_return',
            });
          } else {
            if (a11yConnectedRef.current) {
              scLog('Poll fallback — a11y events stale', { package: pkg });
            }
            scLog('Same app resumed after launcher — capturing', { package: pkg });
            await triggerAppSwitchCapture(CaptureReason.APP_SWITCH_LAUNCHER_RETURN);
          }
        } else if (appChanged) {
          if (a11yDriving) {
            scLog('Poll app-switch trigger suppressed (a11y driving)', {
              from: previousPkg,
              to: pkg,
            });
          } else {
            if (a11yConnectedRef.current) {
              scLog('Poll fallback — a11y events stale', {
                from: previousPkg,
                to: pkg,
              });
            }
            scLog('App switch detected', {
              from: previousPkg,
              to: pkg,
              label: fg.appLabel,
              appState: AppState.currentState,
            });
            await triggerAppSwitchCapture(CaptureReason.APP_SWITCH);
          }
        }

        if (!isLauncherPackage(pkg)) {
          lastAppPackageRef.current = pkg;
          lastAppPackageUpdatedAtRef.current = Date.now();
          setLastForegroundApp(pkg);
        }

        if (appChanged || launcherReturn || previousPkg === null) {
          refreshIntervalForApp();
        }
      })();
    }, APP_POLL_MS);

    refreshIntervalForApp();
    scLog('Smart capture timers started (adaptive)');
  }, [
    clearAdaptiveTimers,
    refreshIntervalForApp,
    triggerAppSwitchCapture,
    syncA11yHealth,
  ]);

  const startMonitoring = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') {
      return false;
    }
    if (isStartingRef.current) {
      return false;
    }

    isStartingRef.current = true;
    // The native loop is a fixed-cadence tick source; JS subsamples it to the
    // effective adaptive interval. The `intervalMs` option only seeds that target.
    scLog('startMonitoring() start', {
      nativeTickMs: NATIVE_TICK_INTERVAL_MS,
      seedIntervalMs: intervalMs,
      adaptive: true,
    });

    const usageOk = await refreshUsageAccess();
    if (!usageOk) {
      scWarn('Usage access not granted — foreground app may be approximate');
    }

    try {
      const native = getScreenCaptureModule();
      let granted = await native.isPermissionGranted();
      if (!granted) {
        granted = await requestPermission();
      }
      if (!granted) {
        setLastError(
          'Screen capture permission was not granted. Toggle monitoring off, then on again to retry.',
        );
        return false;
      }

      try {
        await native.startCapture(NATIVE_TICK_INTERVAL_MS);
      } catch (startErr) {
        // Retry ONLY on the stale/dead-token codes. E_STALE_PROJECTION is the
        // native catch; E_CAPTURE is how the same stale token surfaces on a build
        // without that catch. Anything else (e.g. E_INTERVAL — a bad constant, not
        // a recoverable state) rethrows immediately: no teardown, no consent dialog.
        const code = (startErr as { code?: string } | null)?.code;
        if (code !== 'E_STALE_PROJECTION' && code !== 'E_CAPTURE') {
          throw startErr;
        }
        scWarn('startCapture rejected (stale token) — retrying once with fresh consent', startErr);
        try {
          await native.stopCapture();
        } catch (stopErr) {
          scWarn('stopCapture during retry threw (ignored)', stopErr);
        }
        const regranted = await requestPermission();
        if (!regranted) {
          throw startErr instanceof Error ? startErr : new Error(String(startErr));
        }
        await native.startCapture(NATIVE_TICK_INTERVAL_MS);
      }

      riskHistoryRef.current = [];
      dynamicIntervalMsRef.current = RISK_INTERVAL_LOW_MS;
      lastPeriodicPassAtRef.current = Number.NEGATIVE_INFINITY;
      setDynamicIntervalMs(RISK_INTERVAL_LOW_MS);
      setAppCategory(null);
      setAvgRiskScore(null);
      resetMissionCaptureSession();
      resetActiveArabicRecognition();
      coordinatorRef.current!.reset();
      windowEventFilterRef.current.reset();
      a11yHealthRef.current.reset();
      syncA11yHealth();
      scrollSettleStateRef.current = initialScrollSettleState();
      // Seed liveness now so a quiet first minute is not treated as a stale a11y path.
      lastA11yWindowEventAtMs.current = Date.now();
      a11yKeyboardVisibleRef.current = false;
      lastAppPackageRef.current = APP_OWN_PACKAGE;
      lastAppPackageUpdatedAtRef.current = Date.now();
      visitedLauncherRef.current = false;
      setLastForegroundApp(APP_OWN_PACKAGE);

      setPermissionGranted(true);
      setIsMonitoring(true);
      setIsPaused(false);
      setLastError(null);
      markMonitoringStarted();
      clearStaleNotificationMissionLaunch();

      return true;
    } catch (err) {
      scError('startMonitoring() failed', err);
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      setIsMonitoring(false);
      return false;
    } finally {
      isStartingRef.current = false;
    }
  }, [
    intervalMs,
    refreshUsageAccess,
    requestPermission,
    refreshForegroundCache,
    syncA11yHealth,
  ]);

  const stopMonitoring = useCallback(async (): Promise<void> => {
    if (Platform.OS !== 'android') {
      return;
    }
    scLog('stopMonitoring()');
    resetMissionCaptureSession();
    resetActiveArabicRecognition();
    resetMissionPresentationGuard();
    clearAdaptiveTimers();
    resetForegroundLookup();
    coordinatorRef.current!.reset();
    windowEventFilterRef.current.reset();
    a11yHealthRef.current.reset();
    syncA11yHealth();
    scrollSettleStateRef.current = initialScrollSettleState();
    // Force-clear the keyboard latch: if the service died with the keyboard open no
    // visible:false will arrive to clear it.
    coordinatorRef.current!.setKeyboardVisible(false);
    a11yKeyboardVisibleRef.current = false;
    try {
      await getScreenCaptureModule().stopCapture();
    } catch (err) {
      scError('stopMonitoring failed', err);
      setLastError(err instanceof Error ? err.message : String(err));
    }
    setIsMonitoring(false);
    setIsPaused(false);
    setPermissionGranted(false);
    riskHistoryRef.current = [];
  }, [clearAdaptiveTimers, syncA11yHealth]);

  const pauseCapture = useCallback(async () => {
    if (Platform.OS !== 'android' || !isMonitoringRef.current) {
      return;
    }
    if (isUsableForegroundPackage(lastAppPackageRef.current)) {
      foregroundAtPauseRef.current = lastAppPackageRef.current;
    }
    clearCaptureTimers();
    try {
      await getScreenCaptureModule().pauseCapture();
    } catch (err) {
      scError('pauseCapture failed', err);
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [clearCaptureTimers]);

  const resumeCapture = useCallback(async () => {
    if (Platform.OS !== 'android' || !isMonitoringRef.current) {
      scLog('resumeCapture skipped — monitoring off');
      return;
    }
    try {
      missionEndedAtRef.current = Date.now();
      // Drop any arm taken before the mission pause — the native tick was
      // stopped while paused, so an untouched arm would settle-fire on the
      // first tick after resume, duplicating a capture right after the mission ends.
      scrollSettleStateRef.current = initialScrollSettleState();
      await getScreenCaptureModule().resumeCapture();
      scLog('resumeCapture OK');
      void refreshForegroundCache();
    } catch (err) {
      scError('resumeCapture failed', err);
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshForegroundCache]);

  useEffect(() => {
    registerMissionCaptureHandlers(pauseCapture, resumeCapture);
    payOwedMissionCaptureResume();
    return () => {
      unregisterMissionCaptureHandlers();
    };
  }, [pauseCapture, resumeCapture]);

  useEffect(() => {
    if (isMonitoring && isMissionCapturePaused()) {
      void pauseCapture();
    }
  }, [isMonitoring, pauseCapture]);

  /**
   * Native told us monitoring stopped involuntarily (system/cast-UI revoked the
   * MediaProjection while the loop was live). Native has already torn its session
   * down — here we just reflect reality and prompt a re-enable. The `isMonitoringRef`
   * guard is a second layer behind the native `isRunning.getAndSet(false)` gate: a
   * voluntary stop can never reach this, but if one raced through, we no-op.
   */
  const handleMonitoringRevoked = useCallback(() => {
    if (!isMonitoringRef.current) {
      return;
    }
    scWarn('MediaProjection revoked by system — monitoring stopped');
    clearAdaptiveTimers();
    resetMissionCaptureSession();
    resetActiveArabicRecognition();
    coordinatorRef.current!.reset();
    coordinatorRef.current!.setKeyboardVisible(false);
    windowEventFilterRef.current.reset();
    a11yHealthRef.current.reset();
    syncA11yHealth();
    scrollSettleStateRef.current = initialScrollSettleState();
    a11yKeyboardVisibleRef.current = false;
    riskHistoryRef.current = [];
    setIsMonitoring(false);
    setIsPaused(false);
    setPermissionGranted(false);
    setLastError(
      'Screen monitoring stopped: the system revoked screen-capture permission. ' +
        'Turn monitoring back on to resume.',
    );
  }, [clearAdaptiveTimers, syncA11yHealth]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    const captureSub = screenCaptureEmitter.addListener(
      SCREEN_CAPTURE_EVENTS.captured,
      (event: ScreenCapturedEvent) => {
        if (!isMonitoringRef.current) {
          return;
        }
        void processCapturedFrame(event)
          .then(onCycleComplete)
          .catch((err) => scError('Frame handler error', err));
      },
    );

    const errorSub = screenCaptureEmitter.addListener(
      SCREEN_CAPTURE_EVENTS.error,
      (event: { message: string }) => {
        const msg = event.message ?? '';
        const isBenign =
          /permission denied|cancelled|not ready/i.test(msg);
        if (isBenign) {
          scWarn('Native capture notice', msg);
        } else {
          scError('Native error event', msg);
        }
        setLastError(msg);
      },
    );

    // Native dropped an attempt before it produced a frame (its own 5s interval
    // floor, or a frame already in progress). One-way — the coordinator must not
    // advance its debounce clock, and an interval-floor reject disarms the
    // orphaned force-capture flag so it can't bypass the hash gate on a later frame.
    const rejectedSub = screenCaptureEmitter.addListener(
      SCREEN_CAPTURE_EVENTS.rejected,
      (event: ScreenCaptureRejectedEvent) => {
        coordinatorRef.current?.onNativeRejected(
          event.reason as NativeRejectionReason,
        );
        scLog('[Native] capture rejected', {
          reason: event.reason,
          elapsedMs: event.elapsedMs,
        });
      },
    );

    // Single periodic source: the native loop ticks at a fixed cadence; JS
    // subsamples it down to the effective adaptive interval (0 = disabled) and
    // routes survivors through the same coordinator pipeline as every other
    // capture reason (keyboard suppression, mission-pause, debounce, rejection).
    //
    // A3c-2c: this native tick is the one clock that survives backgrounding, so
    // it also carries the liveness backstop for the JS OCR lock. `decideTickAction`
    // checks the wedged-lock condition BEFORE the subsample gate — a lock stuck
    // during a game (target 0) or a long education interval (120s) must still be
    // cleared, and the in-frame setTimeout/setInterval watchdogs are RN-frozen
    // while backgrounded so they can't do it.
    const tickSub = screenCaptureEmitter.addListener(
      SCREEN_CAPTURE_EVENTS.tick,
      (_event: ScreenCaptureTickEvent) => {
        if (!isMonitoringRef.current) {
          return;
        }
        const now = Date.now();
        const action = decideTickAction({
          isProcessing: isProcessingRef.current,
          processingStartAtMs: processingStartTimeRef.current,
          nowMs: now,
          livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
          lastPeriodicPassAtMs: lastPeriodicPassAtRef.current,
          dynamicIntervalMs: dynamicIntervalMsRef.current,
          phase: processingPhaseRef.current.phase,
          phaseStartedAtMs: processingPhaseRef.current.startedAtMs,
        });
        if (action === 'forceReleaseLock') {
          forceReleaseProcessingLock('tick-liveness');
          // Next tick (~5s) re-issues a capture through the coordinator, now
          // that isProcessing() is false again.
          return;
        }
        // D1: backgrounded-safe substitute for the frozen-timer `withTimeout`
        // guards, on the two phases with an unambiguous deadline (`vision` has
        // none yet — falls through to the absolute 60s check above instead;
        // see `PHASE_DEADLINE_MS`). Cause string names the phase for smoke
        // attribution and defence-log triage.
        if (action === 'forceReleasePhase') {
          const { phase } = processingPhaseRef.current;
          forceReleaseProcessingLock(`tick-phase-timeout:${phase}`);
          return;
        }
        if (action === 'emitCapture') {
          // Optimistic: a tick that passes the subsample "spends" this period
          // even if the coordinator then debounces/suppresses it (something
          // captured nearby, or capture is intentionally paused).
          lastPeriodicPassAtRef.current = now;
          // A periodic frame covers a *settled* scroll arm; leave an unsettled
          // arm (mid-scroll) for its own tick — it re-arms on its next event.
          if (
            now - scrollSettleStateRef.current.lastScrollAtMs >=
            SCROLL_SETTLE_MS
          ) {
            scrollSettleStateRef.current = {
              ...scrollSettleStateRef.current,
              armed: false,
            };
          }
          void tryCaptureNow(CaptureReason.PERIODIC_FALLBACK);
          return;
        }
        // action === 'noop' — the tick is free; check the scroll-settle backstop.
        // Same choke point as everything else, so keyboard-suppression,
        // mission-pause, debounce and A3c-1 rejection handling all apply.
        const periodicMs = dynamicIntervalMsRef.current;
        const scroll = decideScrollSettle({
          state: scrollSettleStateRef.current,
          nowMs: now,
          periodicIntervalMs: periodicMs,
          lastPeriodicPassAtMs: lastPeriodicPassAtRef.current,
          cooldownMs: Math.max(SCROLL_SETTLE_COOLDOWN_MS, periodicMs),
          periodicGuardMs: CAPTURE_DEBOUNCE_MS,
        });
        scrollSettleStateRef.current = scroll.state;
        if (scroll.emit) {
          void tryCaptureNow(CaptureReason.SCROLL_SETTLED);
        }
      },
    );

    // Involuntary projection loss — native already tore down; flip our state + prompt.
    const revokedSub = screenCaptureEmitter.addListener(
      SCREEN_CAPTURE_EVENTS.monitoringRevoked,
      (_event: MonitoringRevokedEvent) => {
        handleMonitoringRevoked();
      },
    );

    return () => {
      captureSub.remove();
      errorSub.remove();
      rejectedSub.remove();
      tickSub.remove();
      revokedSub.remove();
    };
  }, [
    onCycleComplete,
    processCapturedFrame,
    tryCaptureNow,
    handleMonitoringRevoked,
    forceReleaseProcessingLock,
  ]);

  useEffect(() => {
    if (!isMonitoring || isPaused || Platform.OS !== 'android') {
      clearAdaptiveTimers();
      return undefined;
    }
    startSmartCaptureTimers();
    return () => {
      clearAdaptiveTimers();
    };
  }, [isMonitoring, isPaused, startSmartCaptureTimers, clearAdaptiveTimers]);

  /** Leaving SafeGuard for another app — capture immediately (UsageStats omits our own package). */
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (!isMonitoringRef.current || isMissionCapturePaused()) {
        return;
      }
      if (nextState === 'background' || nextState === 'inactive') {
        scLog('AppState left foreground — triggering capture', { nextState });
        void (async () => {
          const fg = await withTimeout(
            resolveForegroundAppWithRetry(3, 200),
            FOREGROUND_LOOKUP_TIMEOUT_MS,
            { packageName: 'unknown', appLabel: 'unknown', source: 'none' as const },
          );
          if (
            isUsableForegroundPackage(fg.packageName) &&
            fg.packageName !== APP_OWN_PACKAGE &&
            !isLauncherPackage(fg.packageName)
          ) {
            lastAppPackageRef.current = fg.packageName;
            lastAppPackageUpdatedAtRef.current = Date.now();
            setLastForegroundApp(fg.packageName);
            scLog('Foreground resolved before app-switch capture', {
              package: fg.packageName,
            });
          }
          await triggerAppSwitchCapture(CaptureReason.APPSTATE_BACKGROUND);
        })();
        return;
      }
      if (nextState === 'active') {
        lastAppPackageRef.current = APP_OWN_PACKAGE;
        lastAppPackageUpdatedAtRef.current = Date.now();
        scLog('AppState active — switch baseline reset to own app');
      }
    });

    return () => {
      subscription.remove();
    };
  }, [triggerAppSwitchCapture]);

  useEffect(() => {
    return () => {
      clearAdaptiveTimers();
      void stopMonitoring();
    };
  }, [stopMonitoring, clearAdaptiveTimers]);

  return {
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
    requestPermission,
    refreshUsageAccess,
    openUsageAccessSettings,
    startMonitoring,
    stopMonitoring,
    pauseCapture,
    resumeCapture,
  };
}
