/** Risk-based periodic capture intervals (Sprint 3.7 adaptive). */

import {getEffectiveIntervalMs} from './appCapturePolicy';

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

/* ------------------------------------------------------------------ *
 *  Per-phase capture deadlines (D1)                                   *
 * ------------------------------------------------------------------ *
 * `withTimeout(p, ms, fallback)` races `p` against a JS `setTimeout`. RN
 * freezes that timer while backgrounded, so if `p` never settles the race
 * never settles, the `await` in `processCapturedFrame` parks, its `finally`
 * never runs and `isProcessingRef` stays latched — monitoring goes blind
 * until {@link OCR_LOCK_LIVENESS_MS}. Three device-observed incidents in two
 * days; two of the three call sites confirmed wedging.
 *
 * This is NOT a cancellation problem: `processingGenerationRef` already
 * neutralizes a late-settling stale run (it fails every `isActive()`
 * checkpoint, and its `finally` refuses to clear a newer run's lock). The
 * problem reduces to "make a timeout that fires while backgrounded, tighter
 * than 60s" — which the native tick can do, being the one clock that survives
 * backgrounding.
 *
 * The `withTimeout` call sites stay exactly as they are: they are the precise
 * fast path when foregrounded (2.5 / 25 / 12s) and merely inert when not.
 * Every deadline below sits ABOVE its `withTimeout` budget, so foregrounded
 * the `withTimeout` always wins the race and these never fire — no `AppState`
 * gate is needed and the reducer stays pure and unconditional.
 */

/** Which guarded region of `processCapturedFrame` a frame is currently in. */
export type ProcessingPhase =
  | 'idle'
  | 'foreground_lookup'
  | 'vision'
  | 'api_post';

/**
 * Backgrounded-safe deadline per phase. Each is a whole multiple of
 * {@link NATIVE_TICK_INTERVAL_MS} (the tick is the only evaluator) and sits
 * strictly between its `withTimeout` budget and {@link OCR_LOCK_LIVENESS_MS}.
 *
 * - `foreground_lookup` (budget 2.5s → 10s): the *outer* `withTimeout` caps the
 *   whole `resolveForegroundAppWithRetry(3, 200)` chain at 2.5s foregrounded —
 *   the inner per-attempt guards never get three runs — and backgrounded a
 *   healthy UsageStats Binder reply is sub-100ms. 4x headroom over the only
 *   legitimate duration.
 * - `vision` (budget 25s): **deliberately `null` — no phase deadline yet.**
 *   `VISION_PIPELINE_TIMEOUT_MS` (25s) is the app's own policy for how long
 *   vision may run; foregrounded, `withTimeout` enforces it and anything past
 *   25s dies. A backgrounded run that takes 40s+ is therefore not legitimate
 *   work being clipped — it already exceeds the one policy that exists. But
 *   picking a number (40s, 45s, ...) here would invent a second, looser
 *   backgrounded policy on no evidence: no measured backgrounded vision
 *   duration exists in this codebase or its history. The only figure that ever
 *   looked like evidence was a hypothetical in a test comment written to
 *   justify the 60s threshold, not a measurement — see the boundary test below.
 *   Guessing low risks clipping a legitimately slow Arabic/Derja OCR pass,
 *   which is exactly the content the keyword filter targets — a detection gap
 *   is worse than 60s of blindness. So `vision` runs on the
 *   {@link OCR_LOCK_LIVENESS_MS} backstop until real backgrounded durations
 *   (Arabic path included) are collected via the `frame.phase` log and a
 *   deadline can be set at ~1.5x the observed p95.
 * - `api_post` (budget 12s → 20s): 1.67x.
 */
export const PHASE_DEADLINE_MS: Record<
  Exclude<ProcessingPhase, 'idle'>,
  number | null
> = {
  foreground_lookup: 10_000,
  vision: null,
  api_post: 20_000,
};

/**
 * True ⇒ the current phase has run past its deadline and the processing lock
 * must be force-released. Pure; evaluated from the native tick.
 *
 * Returns false for `'idle'`, a non-positive start stamp, a `null` deadline
 * (`vision`, see {@link PHASE_DEADLINE_MS}), and when nothing is being
 * processed — mirroring {@link shouldForceReleaseProcessingLock}'s guards —
 * so a missed phase-ref reset degrades to "the 60s absolute backstop handles
 * it", never to a spurious release.
 *
 * Anti-stale guard: also false when `phaseStartedAtMs < processingStartAtMs`.
 * A phase cannot predate the frame it belongs to, so a ref left over from a
 * previous frame (a missed reset) is rejected outright rather than relying on
 * reset discipline alone. This is the clause the absolute-first ordering in
 * {@link decideTickAction} does NOT cover: a 30s-old healthy frame carrying a
 * stale ref claiming `api_post` started 45s ago would otherwise be
 * force-released (30s < the 60s backstop, so that check stays silent).
 */
export function shouldForceReleasePhase(
  phase: ProcessingPhase,
  phaseStartedAtMs: number,
  nowMs: number,
  processingStartAtMs: number,
  isProcessing: boolean,
): boolean {
  if (!isProcessing) {
    return false;
  }
  if (phase === 'idle') {
    return false;
  }
  if (phaseStartedAtMs <= 0) {
    return false;
  }
  if (phaseStartedAtMs < processingStartAtMs) {
    return false;
  }
  const deadline = PHASE_DEADLINE_MS[phase];
  if (deadline === null) {
    return false;
  }
  return nowMs - phaseStartedAtMs >= deadline;
}

export type TickAction =
  | 'forceReleaseLock'
  | 'forceReleasePhase'
  | 'emitCapture'
  | 'noop';

/**
 * The single pure place that encodes tick-handler ordering. Branch order, and
 * why it is this order:
 *
 *   1. absolute lock liveness ({@link OCR_LOCK_LIVENESS_MS}, unchanged) —
 *      evaluated FIRST so it is the check that cannot be bypassed by a
 *      phase-ref bug. If the phase ref is `'idle'`, unset, or stale (says
 *      `api_post` started 2s ago on a frame that is actually 70s old), the phase
 *      predicate returns false and this still fires (the anti-stale guard in
 *      {@link shouldForceReleasePhase} covers the case position alone cannot:
 *      a stale ref *younger* than the frame). The A3c-2c backstop stays the
 *      last line of defence, enforced by position. Ordering it first costs
 *      nothing: the live phase deadlines (10/20s) are shorter in wall-clock
 *      terms, so they still win in practice. `vision` has no phase deadline
 *      (see {@link PHASE_DEADLINE_MS}) and always falls through to this check.
 *      When both would fire, the frame IS 60s+ old regardless of phase, so
 *      `'forceReleaseLock'` is the truthful attribution.
 *   2. per-phase deadline (D1) — the backgrounded substitute for `withTimeout`.
 *   3. subsample gate — a lock wedged during a game (target 0) or a long
 *      education interval (120s) must still be cleared, so both release checks
 *      precede it.
 *
 * `phase` / `phaseStartedAtMs` are optional and default to the never-firing
 * `'idle'`, so pre-D1 callers and tests keep their exact behaviour.
 */
export function decideTickAction(params: {
  isProcessing: boolean;
  processingStartAtMs: number;
  nowMs: number;
  livenessThresholdMs: number;
  lastPeriodicPassAtMs: number;
  dynamicIntervalMs: number;
  phase?: ProcessingPhase;
  phaseStartedAtMs?: number;
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
    shouldForceReleasePhase(
      params.phase ?? 'idle',
      params.phaseStartedAtMs ?? 0,
      params.nowMs,
      params.processingStartAtMs,
      params.isProcessing,
    )
  ) {
    return 'forceReleasePhase';
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
): ScrollSettleState => ({...s, lastScrollAtMs: nowMs, armed: true});

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
}): {emit: boolean; state: ScrollSettleState} {
  const {state: s, nowMs} = params;
  const settleMs = params.settleMs ?? SCROLL_SETTLE_MS;
  const cooldownMs = params.cooldownMs ?? SCROLL_SETTLE_COOLDOWN_MS;
  const periodicGuardMs = params.periodicGuardMs ?? 5_000;

  if (!s.armed) {
    return {emit: false, state: s};
  }
  if (params.periodicIntervalMs <= 0) {
    return {emit: false, state: {...s, armed: false}};
  }
  if (nowMs - s.lastScrollAtMs < settleMs) {
    return {emit: false, state: s};
  }
  if (nowMs - params.lastPeriodicPassAtMs <= periodicGuardMs) {
    return {emit: false, state: s};
  }
  if (s.lastEmitAtMs > 0 && nowMs - s.lastEmitAtMs < cooldownMs) {
    return {emit: false, state: s};
  }
  return {
    emit: true,
    state: {
      armed: false,
      lastScrollAtMs: s.lastScrollAtMs,
      lastEmitAtMs: nowMs,
    },
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

export function pushRiskScore(
  history: number[],
  score: number,
  maxSize = RISK_HISTORY_SIZE,
): number[] {
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

/* ------------------------------------------------------------------ *
 *  Deferred-frame handoff generation guard (ALL_IS_FIXED #12, C1)     *
 * ------------------------------------------------------------------ */

export type DeferredFrameAction =
  | 'processDeferredFrame'
  | 'triggerPendingReason'
  | 'none';

/**
 * Decides what a processCapturedFrame `finally` block should do with a
 * deferred frame / coalesced pending reason. Pure — the caller MUST compute
 * `isOwnGeneration` BEFORE calling this, as a real, sometimes-false value,
 * and MUST NOT nest this call inside an `if (isOwnGeneration)` block — doing
 * so makes the parameter trivially true and silently reintroduces the bug
 * this function exists to fix (see ALL_IS_FIXED #12, round 1 finding).
 *
 * Branch order (load-bearing):
 *   1. `!isOwnGeneration` → 'none'. The fix: a stale generation must not
 *      dispatch the live generation's deferred frame, nor trigger (nor even
 *      consume) the coordinator's coalesced pending reason.
 *   2. `hasDeferredFrame && !isProcessing && isMonitoring && !missionPaused`
 *      → 'processDeferredFrame'.
 *   3. `hasPendingReason && isMonitoring` → 'triggerPendingReason' (reached
 *      when branch 2 didn't fire — e.g. no deferred frame, or one exists but
 *      is blocked by mission-pause). Deliberately does NOT check
 *      `missionPaused` — neither did the old code's equivalent branch; this
 *      is a preserved pre-existing quirk, not something this fix addresses.
 *      (It costs nothing: `processCapturedFrame` itself early-returns on
 *      `isMissionCapturePaused()`, so a pending-reason-triggered capture made
 *      while mission-paused is requested and then skipped downstream.)
 *   4. else → 'none'.
 *
 * `isOwnGeneration` alone (not this function's return value) also decides
 * whether the caller may null `pendingFrameRef.current` — see the call site
 * in useScreenshotCapture.ts.
 *
 * Note on `isProcessing`: it is tautologically `false` whenever
 * `isOwnGeneration` is `true`, because the caller sets
 * `isProcessingRef.current = false` in the same synchronous block, before
 * reading it, for the own-generation case only — there is no reachable
 * own-generation input where `isProcessing` is `true`. The parameter exists
 * because this function also models the STALE-generation case, where it
 * reflects whatever the actual live successor frame is doing (`true` when a
 * live frame is mid-flight — exactly the defect case's precondition).
 */
export function decideDeferredFrameHandoff(params: {
  isOwnGeneration: boolean;
  hasDeferredFrame: boolean;
  isProcessing: boolean;
  isMonitoring: boolean;
  missionPaused: boolean;
  hasPendingReason: boolean;
}): DeferredFrameAction {
  if (!params.isOwnGeneration) {
    return 'none';
  }
  if (
    params.hasDeferredFrame &&
    !params.isProcessing &&
    params.isMonitoring &&
    !params.missionPaused
  ) {
    return 'processDeferredFrame';
  }
  if (params.hasPendingReason && params.isMonitoring) {
    return 'triggerPendingReason';
  }
  return 'none';
}
