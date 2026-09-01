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
 * = category-disabled) via {@link shouldEmitPeriodicCapture}. Set to the fastest
 * useful effective interval so subsampling can realize every slower one.
 */
export const NATIVE_TICK_INTERVAL_MS = RISK_INTERVAL_HIGH_MS;

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
 * 6 x {@link NATIVE_TICK_INTERVAL_MS}.
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
