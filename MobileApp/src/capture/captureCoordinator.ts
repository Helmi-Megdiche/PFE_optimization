/**
 * Centralized capture-decision object.
 *
 * Every capture trigger in `useScreenshotCapture.ts` must call `requestCapture()`
 * before invoking the native `captureNow`. The coordinator owns:
 *   - request debounce (per-reason minimum gap),
 *   - mission-pause gating for *requests* (inbound-frame gating stays in the hook),
 *   - "OCR busy" deferral with priority-based coalescing of the pending reason,
 *   - the force-arm mirror: when a tier-0 reason is allowed the hook calls native
 *     `forceNextCapture()`; `onNativeRejected('interval_floor')` clears that mirror
 *     so an attempt native dropped on its 5s floor can't leave the bypass armed for
 *     an unrelated later frame. A native rejection NEVER advances the debounce clock.
 *   - the owed-force debt (A3d): a tier-0 reason DROPPED by the debounce (not just
 *     native-rejected) is not allowed to vanish — the intent is remembered and the
 *     next allowed request of ANY reason pays it off with one hash-gate bypass, so a
 *     genuine app switch that lands inside another switch's debounce window still
 *     gets one un-gated look at the new screen. See `requestCapture` and
 *     `onNativeRejected`.
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
    reason === CaptureReason.PERIODIC_FALLBACK ||
    reason === CaptureReason.CONTENT_CHANGE ||
    reason === CaptureReason.SCROLL_SETTLED
  );
}

export type CaptureDecision =
  | {allowed: true; reason: CaptureReason; force: boolean}
  | {
      allowed: false;
      skipReason: CaptureSkipReason;
      pendingReason?: CaptureReason;
    };

/**
 * Why the native side dropped a capture attempt, reported back one-way via the
 * `onScreenCaptureRejected` bridge event. Native emits these exact string literals
 * (no shared type package — kept in sync by convention).
 *   - `interval_floor`: `captureNow` was inside `MIN_CAPTURE_INTERVAL_MS`; no frame
 *     was produced, so any armed `forceNextCapture` flag is orphaned — native
 *     self-clears its own flag and the coordinator clears its mirror.
 *   - `busy`: a frame was already being processed on the native capture thread; that
 *     in-flight frame legitimately consumes the force flag, so the mirror is left as-is.
 */
export type NativeRejectionReason = 'interval_floor' | 'busy';

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
  // 4 intentionally unused (was PERIODIC_ADAPTIVE, retired in A3c-2) — only relative order matters.
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
  // Mirror of the native `forceNextCapture` flag: set when a tier-0 reason is
  // allowed (the hook then arms native), cleared when a frame consumes it
  // (`onFrameAccepted`) or when the attempt is rejected on the native interval
  // floor (`onNativeRejected('interval_floor')`).
  let forceArmedReason: CaptureReason | null = null;
  // A3d: a tier-0 reason was DEBOUNCED (never even reached native) or a bypass was
  // armed but native rejected it (no frame produced either way) — one hash-gate
  // bypass is still owed. No TTL: an unpaid debt means no capture has happened at
  // all for that context change, which is exactly when the bypass is still wanted.
  let forceCaptureOwed = false;

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
      if (isForceCaptureReason(reason)) {
        // A genuine context change is being dropped, not just a routine re-scan.
        // Don't let it vanish: the next allowed capture of ANY reason still pays
        // this off with a hash-gate bypass, even though this exact request didn't.
        forceCaptureOwed = true;
      }
      deps.log('capture.skipped', {
        reason,
        skipReason,
        elapsedMs: elapsed,
        forceOwed: forceCaptureOwed,
      });
      return {allowed: false, skipReason};
    }

    const force = isForceCaptureReason(reason) || forceCaptureOwed;
    if (force) {
      forceArmedReason = reason;
      forceCaptureOwed = false;
    }
    deps.log('capture.allowed', {reason, force});
    return {allowed: true, reason, force};
  }

  /** Called when a captured frame is accepted for processing — advances the debounce clock. */
  function onFrameAccepted(atMs: number): void {
    lastAcceptedAtMs = atMs;
    // The frame consumed any native hash-gate bypass; disarm the mirror.
    forceArmedReason = null;
  }

  /**
   * A native capture attempt was dropped before it produced a frame (see
   * `NativeRejectionReason`). This must NEVER advance `lastAcceptedAtMs` — no frame
   * was accepted — and must not touch `pendingReason`. For `interval_floor` it clears
   * the force-arm mirror so the orphaned bypass doesn't survive to a later unrelated
   * frame (native self-clears its own flag in the same case). Delivered via a bridge
   * event, so it is unaffected by RN freezing JS timers while backgrounded.
   *
   * A3d: if a bypass was armed (`forceArmedReason` set) when native rejects on its
   * own floor, no frame was produced — the context change that bypass existed for is
   * still unseen, whether it got here via a genuine tier-0 reason or a paid-down
   * debt. Re-owe it rather than dropping it a second time; the next allowed request
   * tries again.
   */
  function onNativeRejected(reason: NativeRejectionReason): void {
    deps.log('capture.nativeRejected', {reason, forceArmedReason});
    if (reason === 'interval_floor') {
      if (forceArmedReason !== null) {
        forceCaptureOwed = true;
      }
      forceArmedReason = null;
    }
  }

  /** True while the coordinator believes the native hash-gate bypass is armed. */
  function isForceArmed(): boolean {
    return forceArmedReason !== null;
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

  /**
   * Non-mutating peek at the coalesced pending request — mirrors isForceArmed().
   * Lets the deferred-frame handoff in useScreenshotCapture.ts know whether a
   * pending reason exists (to feed the pure decideDeferredFrameHandoff) without
   * consuming it ahead of the actual dispatch — only the dispatch branch that
   * is actually taken should call takePendingReason().
   */
  function peekPendingReason(): CaptureReason | null {
    return pendingReason;
  }

  /** Clears all state — called on stop-monitoring and monitoring (re)start. */
  function reset(): void {
    lastAcceptedAtMs = Number.NEGATIVE_INFINITY;
    pendingReason = null;
    keyboardVisible = false;
    forceArmedReason = null;
    forceCaptureOwed = false;
  }

  return {
    requestCapture,
    onFrameAccepted,
    onNativeRejected,
    isForceArmed,
    setKeyboardVisible,
    takePendingReason,
    peekPendingReason,
    reset,
  };
}

export type CaptureCoordinator = ReturnType<typeof createCaptureCoordinator>;
