/** Risk-based periodic capture intervals (Sprint 3.7 adaptive). */

import { getEffectiveIntervalMs } from './appCapturePolicy';

// Ordering invariant: HIGH <= MEDIUM <= LOW (higher risk must scan at least as often).
export const RISK_INTERVAL_HIGH_MS = 10_000;
export const RISK_INTERVAL_MEDIUM_MS = 15_000;
export const RISK_INTERVAL_LOW_MS = 20_000;

export const RISK_HISTORY_SIZE = 3;

/**
 * The single cadence the native periodic loop emits `onNativePeriodicTick` at.
 * JS subsamples it down to the effective adaptive interval (10/15/20/120s, or 0
 * = category-disabled) via {@link shouldEmitPeriodicCapture}.
 *
 * Must be a common divisor of *every* effective interval (10/15/20/120k) so
 * subsampling can realize each one exactly. A3c-2 set this to
 * `RISK_INTERVAL_HIGH_MS` (10k) and `15000 % 10000 !== 0`, so a 15s browser_social
 * target quantized up to the 20s tick — device-confirmed 33% slower browser
 * scanning. 5s divides 10/15/20/120 exactly and removes the whole quantization
 * class. Native floor is a strict `intervalMs < 5_000` (ScreenCaptureModule.java),
 * so 5000 passes with no native change.
 */
export const NATIVE_TICK_INTERVAL_MS = 5_000;

/**
 * Subsample gate for native periodic ticks. Returns true when a tick should be
 * turned into a capture request: `targetMs > 0` (0 means the foreground app's
 * category disables periodic capture) AND at least `targetMs` has elapsed since
 * the last tick that passed. Paces *attempts*, not capture outcomes.
 */
export function shouldEmitPeriodicCapture(
  nowMs: number,
  lastPassAtMs: number,
  targetMs: number,
): boolean {
  return targetMs > 0 && nowMs - lastPassAtMs >= targetMs;
}

/**
 * Liveness threshold for the JS processing lock (`isProcessingRef`), checked
 * from the native periodic tick (the one clock that keeps ticking while
 * backgrounded — the in-frame setTimeout/setInterval watchdogs are RN-frozen
 * there). Named for OCR, but it catches **any** never-settling `await` inside
 * `processCapturedFrame` that latches the lock — device-observed wedges include
 * the foreground-lookup UsageStats IPC (before OCR runs) as well as the vision
 * pass. Sits well above the ~40s worst-case legitimate `processCapturedFrame`
 * (2.5s foreground lookup + 25s vision + 12s API POST) and ~78x a healthy
 * ~400ms frame, so it only ever fires on a genuinely wedged frame.
 * 12 x {@link NATIVE_TICK_INTERVAL_MS}.
 */
export const OCR_LOCK_LIVENESS_MS = 60_000;

/**
 * Backgrounded-safe liveness backstop for the JS OCR lock. True ⇒ the lock has
 * been held past `thresholdMs` and must be force-released. Takes no subsample
 * input on purpose — the backgrounded-OCR-hang deadlock is not category
 * dependent, so this must be evaluated independently of (and before) the
 * subsample gate.
 */
export function shouldForceReleaseProcessingLock(
  isProcessing: boolean,
  processingStartAtMs: number,
  nowMs: number,
  thresholdMs: number,
): boolean {
  if (!isProcessing) {
    return false;
  }
  if (processingStartAtMs <= 0) {
    return false;
  }
  return nowMs - processingStartAtMs >= thresholdMs;
}

export type TickAction = 'forceReleaseLock' | 'emitCapture' | 'noop';

/**
 * The single pure place that encodes tick-handler ordering: the OCR-lock
 * liveness backstop is evaluated BEFORE the subsample gate, so a lock wedged
 * during a game (target 0) or a long education interval (120s) is still
 * cleared. Returns what the tick handler should do this tick.
 */
export function decideTickAction(params: {
  isProcessing: boolean;
  processingStartAtMs: number;
  nowMs: number;
  livenessThresholdMs: number;
  lastPeriodicPassAtMs: number;
  dynamicIntervalMs: number;
}): TickAction {
  if (
    shouldForceReleaseProcessingLock(
      params.isProcessing,
      params.processingStartAtMs,
      params.nowMs,
      params.livenessThresholdMs,
    )
  ) {
    return 'forceReleaseLock';
  }
  if (
    shouldEmitPeriodicCapture(
      params.nowMs,
      params.lastPeriodicPassAtMs,
      params.dynamicIntervalMs,
    )
  ) {
    return 'emitCapture';
  }
  return 'noop';
}

/* ------------------------------------------------------------------ *
 *  Scroll-settled capture (A3c-3)                                     *
 * ------------------------------------------------------------------ *
 * Tick-driven settle: `onAccessibilityScroll` records a timestamp +
 * arms; the native periodic tick (the one JS clock that survives
 * backgrounding — RN freezes setTimeout/setInterval there) evaluates
 * `decideScrollSettle` on every `noop` tick and emits `SCROLL_SETTLED`
 * once the scroll has been quiet for `SCROLL_SETTLE_MS`. No JS timer.
 */

/** A scroll burst must be quiet this long before it counts as "settled". */
export const SCROLL_SETTLE_MS = 2_000;
/**
 * Floor for the gap between two scroll-driven captures. The tick handler passes
 * `max(this, effectivePeriodicIntervalMs)` so lower-value categories (education
 * at 120s) don't get a settle capture every 10s. Stands on its own — stricter
 * than the coordinator's 5s debounce, not reliant on it.
 */
export const SCROLL_SETTLE_COOLDOWN_MS = 10_000;

export interface ScrollSettleState {
  /** Wall-clock ms of the most recent scroll event; 0 = none seen. */
  lastScrollAtMs: number;
  /** A scroll burst is awaiting settle. */
  armed: boolean;
  /** Wall-clock ms of the last emitted SCROLL_SETTLED; 0 = never. */
  lastEmitAtMs: number;
}

export const initialScrollSettleState = (): ScrollSettleState => ({
  lastScrollAtMs: 0,
  armed: false,
  lastEmitAtMs: 0,
});

/** Fold one inbound scroll event into the state: stamp + arm. */
export const recordScrollEvent = (
  s: ScrollSettleState,
  nowMs: number,
): ScrollSettleState => ({ ...s, lastScrollAtMs: nowMs, armed: true });

/**
 * Tick-driven scroll-settle decision. Pure; evaluated from the native tick
 * handler on `noop` ticks. Branch order:
 *   not armed            → no emit
 *   periodic disabled     → DISARM (category turned periodic off; drop the arm)
 *   still scrolling        → no emit, STAY ARMED  (now - lastScroll < settleMs)
 *   periodic just fired    → DEFER (stay armed): a periodic frame within
 *                            `periodicGuardMs` already covers this screen, and
 *                            emitting now would hit the native 5s floor with the
 *                            arm consumed and no retry
 *   inside cooldown        → DEFER (stay armed): emit once cooldown expires
 *   else                  → EMIT, disarm, stamp `lastEmitAtMs`
 */
export function decideScrollSettle(params: {
  state: ScrollSettleState;
  nowMs: number;
  /** dynamicIntervalMsRef.current; 0 ⇒ category disables periodic capture. */
  periodicIntervalMs: number;
  /** lastPeriodicPassAtRef.current. */
  lastPeriodicPassAtMs: number;
  settleMs?: number;
  /** Caller passes `max(SCROLL_SETTLE_COOLDOWN_MS, periodicIntervalMs)`. */
  cooldownMs?: number;
  /** = CAPTURE_DEBOUNCE_MS. */
  periodicGuardMs?: number;
}): { emit: boolean; state: ScrollSettleState } {
  const { state: s, nowMs } = params;
  const settleMs = params.settleMs ?? SCROLL_SETTLE_MS;
  const cooldownMs = params.cooldownMs ?? SCROLL_SETTLE_COOLDOWN_MS;
  const periodicGuardMs = params.periodicGuardMs ?? 5_000;

  if (!s.armed) {
    return { emit: false, state: s };
  }
  if (params.periodicIntervalMs <= 0) {
    return { emit: false, state: { ...s, armed: false } };
  }
  if (nowMs - s.lastScrollAtMs < settleMs) {
    return { emit: false, state: s };
  }
  if (nowMs - params.lastPeriodicPassAtMs <= periodicGuardMs) {
    return { emit: false, state: s };
  }
  if (s.lastEmitAtMs > 0 && nowMs - s.lastEmitAtMs < cooldownMs) {
    return { emit: false, state: s };
  }
  return {
    emit: true,
    state: { armed: false, lastScrollAtMs: s.lastScrollAtMs, lastEmitAtMs: nowMs },
  };
}

/**
 * Rolling average of last scores → periodic interval.
 * >70 → 10s, >30 → 15s, else 20s.
 */
export function computeAdaptiveIntervalMs(riskScores: number[]): number {
  if (riskScores.length === 0) {
    return RISK_INTERVAL_LOW_MS;
  }
  const avg = riskScores.reduce((sum, s) => sum + s, 0) / riskScores.length;
  if (avg > 70) {
    return RISK_INTERVAL_HIGH_MS;
  }
  if (avg > 30) {
    return RISK_INTERVAL_MEDIUM_MS;
  }
  return RISK_INTERVAL_LOW_MS;
}

export function pushRiskScore(history: number[], score: number, maxSize = RISK_HISTORY_SIZE): number[] {
  const next = [...history, score];
  if (next.length > maxSize) {
    return next.slice(-maxSize);
  }
  return next;
}

/**
 * Risk-adaptive interval with optional app-category cap/floor.
 * Unknown/missing package → risk-only interval.
 */
export function computeEffectiveAdaptiveInterval(
  riskScores: number[],
  appPackage?: string | null,
): number {
  const baseInterval = computeAdaptiveIntervalMs(riskScores);
  if (!appPackage || appPackage === 'unknown') {
    return baseInterval;
  }
  return getEffectiveIntervalMs(baseInterval, appPackage);
}
