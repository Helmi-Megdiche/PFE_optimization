/**
 * Centralized capture-decision object.
 *
 * Every capture trigger in `useScreenshotCapture.ts` must call `requestCapture()`
 * before invoking the native `captureNow`. The coordinator owns:
 *   - request debounce (per-reason minimum gap),
 *   - mission-pause gating for *requests* (inbound-frame gating stays in the hook),
 *   - "OCR busy" deferral with priority-based coalescing of the pending reason.
 *
 * Pure and injectable — no React, no react-native, no native modules — so it is
 * unit-testable with a fake clock.
 */

/** Preserved verbatim from the pre-refactor hook. */
export const CAPTURE_DEBOUNCE_MS = 5_000;
/** Preserved verbatim from the pre-refactor hook (follow-up capture only). */
export const FOLLOW_UP_MIN_GAP_MS = 2_000;

export enum CaptureReason {
  APP_SWITCH = 'app_switch',
  APP_SWITCH_LAUNCHER_RETURN = 'app_switch_launcher_return',
  APP_SWITCH_FOLLOW_UP = 'app_switch_follow_up',
  APP_SWITCH_DEFERRED = 'app_switch_deferred',
  APPSTATE_BACKGROUND = 'appstate_background',
  MISSION_RESUME = 'mission_resume',
  PERIODIC_ADAPTIVE = 'periodic_adaptive',
  PERIODIC_FALLBACK = 'periodic_fallback',
  RISK_FOLLOW_UP = 'risk_follow_up',
  CONTENT_CHANGE = 'content_change',
  SCROLL_SETTLED = 'scroll_settled',
  BROWSER_NAVIGATION = 'browser_navigation',
}

/**
 * "Tier-0" capture reasons: a genuine context change (an app switch or an in-browser
 * navigation), not just a periodic re-scan. These must bypass the native
 * perceptual-hash frame-skip gate — the hook calls `forceNextCapture()` before
 * `captureNow()` for them so the next native frame always processes, even if the pixels
 * happen to be near-identical to the previous one. This is the only place the list is
 * written; it is deliberately an explicit literal, not derived from
 * `CAPTURE_REASON_PRIORITY`, so force-capture stays decoupled from coalescing priority.
 */
export function isForceCaptureReason(reason: CaptureReason): boolean {
  return (
    reason === CaptureReason.APP_SWITCH ||
    reason === CaptureReason.APP_SWITCH_LAUNCHER_RETURN ||
    reason === CaptureReason.APP_SWITCH_DEFERRED ||
    reason === CaptureReason.BROWSER_NAVIGATION
  );
}

export enum CaptureSkipReason {
  NOT_MONITORING = 'not_monitoring',
  MISSION_PAUSED = 'mission_paused',
  KEYBOARD_SUPPRESSED = 'keyboard_suppressed',
  DEBOUNCED = 'debounced',
  BUSY_DEFERRED = 'busy_deferred',
  SUPERSEDED = 'superseded',
}

/**
 * Reasons the coordinator drops while the soft keyboard is up: routine re-scans
 * only. Every app-switch reason, `BROWSER_NAVIGATION`, `RISK_FOLLOW_UP` and
 * `APP_SWITCH_FOLLOW_UP` still pass — safety monitoring must not stop while the
 * child is typing, only periodic screenshotting. This is the ONLY place the list
 * is written.
 */
export function isKeyboardSuppressibleReason(reason: CaptureReason): boolean {
  return (
    reason === CaptureReason.PERIODIC_ADAPTIVE ||
    reason === CaptureReason.PERIODIC_FALLBACK ||
    reason === CaptureReason.CONTENT_CHANGE ||
    reason === CaptureReason.SCROLL_SETTLED
  );
}

export type CaptureDecision =
  | {allowed: true; reason: CaptureReason}
  | {
      allowed: false;
      skipReason: CaptureSkipReason;
      pendingReason?: CaptureReason;
    };

export interface CaptureCoordinatorDeps {
  now: () => number;
  isMonitoring: () => boolean;
  isMissionPaused: () => boolean;
  isProcessing: () => boolean;
  log: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * Lower value = higher priority. When a request arrives while OCR is busy, it
 * only overwrites the pending reason if its priority is *strictly* higher.
 */
const CAPTURE_REASON_PRIORITY: Record<CaptureReason, number> = {
  [CaptureReason.APP_SWITCH]: 0,
  [CaptureReason.APP_SWITCH_LAUNCHER_RETURN]: 0,
  [CaptureReason.BROWSER_NAVIGATION]: 0,
  // Not in the spec's priority list — a re-issued app switch, so tier 0.
  [CaptureReason.APP_SWITCH_DEFERRED]: 0,
  [CaptureReason.RISK_FOLLOW_UP]: 1,
  [CaptureReason.CONTENT_CHANGE]: 2,
  [CaptureReason.SCROLL_SETTLED]: 2,
  [CaptureReason.APP_SWITCH_FOLLOW_UP]: 3,
  [CaptureReason.APPSTATE_BACKGROUND]: 3,
  [CaptureReason.MISSION_RESUME]: 3,
  [CaptureReason.PERIODIC_ADAPTIVE]: 4,
  [CaptureReason.PERIODIC_FALLBACK]: 5,
};

function minGapFor(reason: CaptureReason): number {
  return reason === CaptureReason.APP_SWITCH_FOLLOW_UP
    ? FOLLOW_UP_MIN_GAP_MS
    : CAPTURE_DEBOUNCE_MS;
}

export function createCaptureCoordinator(deps: CaptureCoordinatorDeps) {
  let lastAcceptedAtMs = Number.NEGATIVE_INFINITY;
  let pendingReason: CaptureReason | null = null;
  let keyboardVisible = false;

  function requestCapture(reason: CaptureReason): CaptureDecision {
    deps.log('capture.requested', {reason});

    if (!deps.isMonitoring()) {
      const skipReason = CaptureSkipReason.NOT_MONITORING;
      deps.log('capture.skipped', {reason, skipReason});
      return {allowed: false, skipReason};
    }

    if (deps.isMissionPaused()) {
      const skipReason = CaptureSkipReason.MISSION_PAUSED;
      deps.log('capture.skipped', {reason, skipReason});
      return {allowed: false, skipReason};
    }

    if (keyboardVisible && isKeyboardSuppressibleReason(reason)) {
      const skipReason = CaptureSkipReason.KEYBOARD_SUPPRESSED;
      deps.log('capture.skipped', {reason, skipReason});
      return {allowed: false, skipReason};
    }

    if (deps.isProcessing()) {
      const current = pendingReason;
      const higherPriority =
        current === null ||
        CAPTURE_REASON_PRIORITY[reason] < CAPTURE_REASON_PRIORITY[current];
      if (higherPriority) {
        pendingReason = reason;
        const skipReason = CaptureSkipReason.BUSY_DEFERRED;
        deps.log('capture.skipped', {
          reason,
          skipReason,
          pendingReason: reason,
        });
        return {allowed: false, skipReason, pendingReason: reason};
      }
      const skipReason = CaptureSkipReason.SUPERSEDED;
      deps.log('capture.skipped', {reason, skipReason, pendingReason: current});
      return {allowed: false, skipReason, pendingReason: current};
    }

    const elapsed = deps.now() - lastAcceptedAtMs;
    if (elapsed < minGapFor(reason)) {
      const skipReason = CaptureSkipReason.DEBOUNCED;
      deps.log('capture.skipped', {reason, skipReason, elapsedMs: elapsed});
      return {allowed: false, skipReason};
    }

    deps.log('capture.allowed', {reason});
    return {allowed: true, reason};
  }

  /** Called when a captured frame is accepted for processing — advances the debounce clock. */
  function onFrameAccepted(atMs: number): void {
    lastAcceptedAtMs = atMs;
  }

  /**
   * Set by the hook from `onAccessibilityKeyboardChanged`. While true, the four
   * `isKeyboardSuppressibleReason` reasons are dropped by `requestCapture`.
   */
  function setKeyboardVisible(visible: boolean): void {
    keyboardVisible = visible;
  }

  /** Returns and clears any coalesced pending request. */
  function takePendingReason(): CaptureReason | null {
    const reason = pendingReason;
    pendingReason = null;
    return reason;
  }

  /** Clears all state — called on stop-monitoring and monitoring (re)start. */
  function reset(): void {
    lastAcceptedAtMs = Number.NEGATIVE_INFINITY;
    pendingReason = null;
    keyboardVisible = false;
  }

  return {
    requestCapture,
    onFrameAccepted,
    setKeyboardVisible,
    takePendingReason,
    reset,
  };
}

export type CaptureCoordinator = ReturnType<typeof createCaptureCoordinator>;
