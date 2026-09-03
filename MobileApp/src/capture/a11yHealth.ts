/**
 * Evidence-based health signal for the SafeGuard accessibility service.
 *
 * The OS silently unbinds `SafeGuardAccessibilityService` mid-session. When it
 * does, `isAccessibilityServiceEnabled()` (the native `isEnabled()` bridge call)
 * can still read `true` from a stale binding while zero window events actually
 * flow — so a "granted" check is not enough to trust the fast app-switch path.
 *
 * This tracker infers a drop from *evidence*: an app switch the 1s UsageStats
 * poll observed that the accessibility window feed did NOT deliver within a grace
 * window. It deliberately does NOT use a time-based decay ("no event for N
 * seconds ⇒ degraded") — silence is not evidence, a child staring at one app for
 * ten minutes produces exactly that silence with a perfectly healthy service.
 *
 * Pure and injectable — no React, no react-native, no native modules — so it is
 * unit-testable with a fake clock.
 */

export type A11yHealth = 'off' | 'unverified' | 'live' | 'degraded';

/**
 * A live service has `notificationTimeout = 100` (it fires ~100 ms after a window
 * change); the 1s poll needs up to `APP_POLL_MS` (1s) to notice the same switch.
 * 5s comfortably exceeds `FOREGROUND_LOOKUP_TIMEOUT_MS` (2.5s) + one poll interval
 * + margin, so a slow or wedged UsageStats lookup cannot manufacture a false miss.
 */
export const A11Y_MISS_GRACE_MS = 5_000;

/**
 * A poll-tick gap wider than this means the JS thread was frozen (RN/MIUI freezes
 * it while backgrounded and on screen-off — D3 measured a 185s freeze), not that
 * the accessibility feed went silent. `onPollTick()` is called at the very top of
 * the `setInterval` callback, before its async body, so the measured gap is pure
 * timer-scheduling latency and is insensitive to how long the foreground lookup
 * takes. On such a gap the liveness timestamp is re-seeded so the first
 * post-freeze poll tick cannot be mistaken for a missed a11y switch.
 */
export const POLL_FREEZE_GAP_MS = 5_000;

export interface A11yHealthDeps {
  now: () => number;
  missGraceMs?: number; // defaults to A11Y_MISS_GRACE_MS
}

export function createA11yHealthTracker(deps: A11yHealthDeps) {
  const missGraceMs = deps.missGraceMs ?? A11Y_MISS_GRACE_MS;

  let enabled = false;
  let lastWindowEventAtMs = deps.now();
  let lastPollTickAtMs = deps.now();
  let sawRealEvent = false;
  let missStanding = false;

  /**
   * Set whether the service is listed as enabled. On a false → true transition
   * only, clear a standing miss — the user has just re-enabled it in Settings, so
   * give the service a fresh chance to prove itself. A true → true call must NOT
   * clear a standing miss: that is the "bound but silent" case this exists for.
   */
  function setEnabled(next: boolean): void {
    if (!enabled && next) {
      missStanding = false;
    }
    enabled = next;
  }

  /**
   * A raw accessibility window event arrived (called pre-filter, for every event,
   * regardless of `enabled` — an event that lands before `connected` has
   * refreshed still counts as proof of life).
   */
  function onWindowEvent(): void {
    lastWindowEventAtMs = deps.now();
    sawRealEvent = true;
    missStanding = false;
  }

  /**
   * Called first thing on every 1s poll tick. If the gap since the previous tick
   * exceeds `POLL_FREEZE_GAP_MS` the JS thread was frozen, not the a11y feed —
   * re-seed the liveness timestamp so the next `onPollObservedSwitch()` is not a
   * false miss. Never touches `sawRealEvent` / `missStanding`: a service already
   * proven degraded stays degraded across a freeze.
   */
  function onPollTick(): void {
    if (deps.now() - lastPollTickAtMs > POLL_FREEZE_GAP_MS) {
      lastWindowEventAtMs = deps.now();
    }
    lastPollTickAtMs = deps.now();
  }

  /**
   * The poll saw an app switch. Returns true iff this call newly proved a miss —
   * i.e. the service is enabled but no window event landed within the grace
   * window (strict `>`). A proven miss is latched until an `onWindowEvent()` or a
   * false → true `setEnabled()` clears it.
   */
  function onPollObservedSwitch(): boolean {
    if (!enabled) {
      return false;
    }
    if (deps.now() - lastWindowEventAtMs > missGraceMs) {
      missStanding = true;
      return true;
    }
    return false;
  }

  /** Current health, most-severe-first: off → degraded → live → unverified. */
  function getHealth(): A11yHealth {
    if (!enabled) {
      return 'off';
    }
    if (missStanding) {
      return 'degraded';
    }
    if (sawRealEvent) {
      return 'live';
    }
    return 'unverified';
  }

  /**
   * Clear evidence state and re-seed both timestamps. Must be called on every
   * monitoring start/stop/revoke (next to the window filter's reset) so a stale
   * arm from a previous session cannot settle-fire against the next one. Does NOT
   * touch `enabled` — that tracks the service, not the monitoring session.
   */
  function reset(): void {
    lastWindowEventAtMs = deps.now();
    lastPollTickAtMs = deps.now();
    sawRealEvent = false;
    missStanding = false;
  }

  return {
    setEnabled,
    onWindowEvent,
    onPollTick,
    onPollObservedSwitch,
    getHealth,
    reset,
  };
}

export type A11yHealthTracker = ReturnType<typeof createA11yHealthTracker>;
