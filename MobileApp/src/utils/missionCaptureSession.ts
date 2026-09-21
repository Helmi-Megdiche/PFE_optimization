/**
 * Pauses periodic screen capture while a blocking mission (overlay or MissionScreen) is active.
 *
 * A single nullable lease, not a counter: `beginMissionCaptureSession(missionId, source)` opens it,
 * `forceEndMissionCaptureSession()` closes whatever is open unconditionally. This asymmetry is
 * intentional. Every real release call site means "this mission flow is over, whatever it was" —
 * an id-scoped release would risk not releasing on any id mismatch/drift, which fails toward a
 * wedge (capture stays paused forever). Unconditional release fails toward *more* monitoring
 * instead, which is the correct failure direction. `missionId` exists for idempotence (collapsing
 * an overlay->MissionScreen handoff into one lease) and diagnostics (backstop-expiry logs) —
 * NOT for scoped release.
 *
 * Backstop (ALL_IS_FIXED #58): a lease is force-released the next time
 * checkMissionCaptureSessionBackstop() runs (see useScreenshotCapture's handleA11yWindowChanged
 * and useMissionOverlayListener's AppState listener) IF it has gone stale — but "stale" is no
 * longer just "old". The original design measured staleness as time-since-`begin()`, which
 * force-released any mission open past MISSION_SESSION_MAX_MS regardless of whether the mission
 * UI was still genuinely mounted — a false reclaim, not a leak reclaim. The fix has two halves:
 *
 * 1. `lastTouchedAtMs`, distinct from `startedAtMs`. The soft threshold (MISSION_SESSION_MAX_MS)
 *    is measured from the last *proof of life*, not from session start. For MissionScreen
 *    (source 'screen'/'fallback'), proof of life is a JS `setInterval` heartbeat
 *    (startMissionCaptureSessionHeartbeat) — safe ONLY because MissionScreen's own AppState
 *    listener auto-abandons the mission after >3s out of foreground, so the interval can never go
 *    un-ticked longer than that without the mission ending itself first (RN freezes JS timers
 *    while backgrounded; MissionScreen guarantees it is never backgrounded for long). For the
 *    overlay (source 'overlay'), a JS timer is NOT safe — the overlay is drawn over another app,
 *    so the RN host is backgrounded for the overlay's entire display duration, and a JS
 *    `setInterval` would simply never tick. Proof of life there is instead an on-demand native
 *    query (`deps.isOverlayShowing`, wired to `OverlayMissionModule.isOverlayShowing()`) asked
 *    only when the soft threshold trips — "is the window still attached, right now" — which
 *    survives backgrounding because it's answered synchronously by native code, not by a JS timer.
 *    A `true` answer re-touches the lease (defers the next check by another full soft-threshold
 *    window); a `false` answer (or a rejected/unavailable query) falls through to force-end.
 *
 * 2. `MISSION_SESSION_HARD_MAX_MS`, an absolute ceiling measured from `startedAtMs` (NOT
 *    `lastTouchedAtMs` — the query-based defer touches, so a touch-based ceiling would just be the
 *    same unbounded loop under a different name), checked first and unconditionally, before the
 *    soft-threshold/query logic runs. Without this, an orphaned-but-still-attached overlay window
 *    (OverlayService runs START_STICKY) would answer "yes, still showing" forever and the backstop
 *    would never reclaim it — the exact failure a backstop must never have. Past the hard ceiling,
 *    the lease force-releases regardless of what the query says, logged as a warn distinct from
 *    the ordinary deferral log, because a window still claiming to be attached an hour into a
 *    mission is itself worth surfacing.
 *
 * This is a lease expiry on a known, timestamped fact (now bolstered by an on-demand liveness
 * check for the one source where a timestamp alone is untrustworthy), not an inference from
 * silence — it does not contradict a11yHealth's "no time-based decay" rule, which is about
 * inferring service health from the absence of a signal. The native periodic tick cannot drive
 * this: pauseCapture() stops the tick's Runnable from rescheduling itself, so onNativePeriodicTick
 * is silent for the entire lifetime of a paused session — exactly when a backstop would need to
 * fire. The backstop instead rides two signals proven to survive backgrounding: a11y
 * window-changed events (DeviceEventEmitter-driven, not foreground-gated) and AppState ->
 * 'active'. It does NOT fire while the a11y service is down and the app never foregrounds, and
 * not at all while the screen is off (JS thread frozen) — a bound, not a guarantee.
 *
 * Disclosed behavior change (ALL_IS_FIXED #58, C3): checkBackstop() used to run fully
 * synchronously to completion before its caller's next line executed. On the 'overlay' path it
 * now returns control at its first `await` (the native query), so the calling handler continues
 * running before the query resolves or any resulting forceEnd() lands — a capture that would
 * previously have been allowed immediately after a reclaim is now skipped for that one triggering
 * event and picked up by the next one instead. 'screen'/'fallback' paths never hit an `await`, so
 * they are genuinely unchanged and run to completion synchronously within the same tick.
 *
 * Same missionId + same source is a no-op. Same missionId + a different source (the
 * overlay -> MissionScreen handoff) re-stamps the lease's clock rather than preserving the
 * original start time — a source change is evidence of a live owner (a newly-mounted component
 * whose unmount will release the lease), so the ceiling should measure time-since-engagement, not
 * time-since-overlay-shown. This cannot be looped to extend a lease indefinitely:
 * presentMissionFromCapture (the only caller that passes a source) is reachable only from the
 * frame-processing path, itself gated by isMissionCapturePaused(), so it cannot re-fire while a
 * session is already open; the quiz-retry path calls showMissionOverlay directly without a fresh
 * begin() — safe under this fix because the overlay's liveness is proven by the query, not by a
 * begin()-driven timestamp, so however long a retry loop runs, the next backstop check just asks
 * the window again.
 */

import {scLog, scWarn} from './screenCaptureLogger';
import {isOverlayShowing as nativeIsOverlayShowing} from '../native/OverlayMission';

export const MISSION_SESSION_MAX_MS = 10 * 60 * 1000;

/**
 * Absolute ceiling, measured from startedAtMs, independent of any liveness proof. Without this,
 * an orphaned-but-still-attached overlay (OverlayService is START_STICKY) could defer forever by
 * always answering "still showing" to the on-demand query. 60 minutes is a deliberately generous,
 * explicitly-chosen policy number — not measured/derived — six times the soft threshold,
 * comfortably above any realistic quiz/retry session. Applied to every source uniformly: it costs
 * nothing for 'screen'/'fallback' sessions, which never approach it under normal operation.
 */
export const MISSION_SESSION_HARD_MAX_MS = 60 * 60 * 1000;

/** Heartbeat cadence for MissionScreen's proof-of-life touch. 10x margin under the soft threshold. */
export const MISSION_TOUCH_INTERVAL_MS = 60 * 1000;

export type MissionCaptureSource = 'overlay' | 'screen' | 'fallback';

type CaptureControl = () => void | Promise<void>;

interface MissionCaptureSession {
  missionId: string;
  source: MissionCaptureSource;
  startedAtMs: number;
  lastTouchedAtMs: number;
}

export interface MissionCaptureSessionTracker {
  begin: (missionId: string, source: MissionCaptureSource) => void;
  forceEnd: () => void;
  reset: () => void;
  isPaused: () => boolean;
  checkBackstop: () => Promise<void>;
  touch: (missionId: string) => void;
  startHeartbeat: (missionId: string) => void;
  payOwedResume: () => void;
  registerHandlers: (pause: CaptureControl, resume: CaptureControl) => void;
  unregisterHandlers: () => void;
}

export function createMissionCaptureSessionTracker(deps: {
  now: () => number;
  setIntervalFn?: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  isOverlayShowing?: () => Promise<boolean>;
}): MissionCaptureSessionTracker {
  const scheduleInterval: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval> = deps.setIntervalFn ?? setInterval;
  const cancelInterval: (handle: ReturnType<typeof setInterval>) => void =
    deps.clearIntervalFn ?? clearInterval;

  let session: MissionCaptureSession | null = null;
  let pauseCaptureFn: CaptureControl | null = null;
  let resumeCaptureFn: CaptureControl | null = null;
  let resumeOwed = false;
  let heartbeatHandle: ReturnType<typeof setInterval> | null = null;

  function stopHeartbeat(): void {
    if (heartbeatHandle !== null) {
      cancelInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
  }

  function touch(missionId: string): void {
    if (!session || session.missionId !== missionId) {
      return;
    }
    session.lastTouchedAtMs = deps.now();
  }

  function startHeartbeat(missionId: string): void {
    stopHeartbeat();
    touch(missionId);
    heartbeatHandle = scheduleInterval(
      () => touch(missionId),
      MISSION_TOUCH_INTERVAL_MS,
    );
  }

  function invokeResume(): void {
    if (resumeCaptureFn) {
      resumeOwed = false;
      void resumeCaptureFn();
    } else {
      resumeOwed = true;
    }
  }

  function begin(missionId: string, source: MissionCaptureSource): void {
    if (session && session.missionId === missionId) {
      if (session.source === source) {
        return;
      }
      scLog('Mission capture session source change — restamping', {
        missionId,
        from: session.source,
        to: source,
      });
      const now = deps.now();
      session = {missionId, source, startedAtMs: now, lastTouchedAtMs: now};
      return;
    }

    if (session) {
      scWarn('Mission capture session handoff — closing stale session', {
        from: session.missionId,
        to: missionId,
      });
      session = null;
    } else {
      void pauseCaptureFn?.();
    }

    const now = deps.now();
    session = {missionId, source, startedAtMs: now, lastTouchedAtMs: now};
    scLog('Mission capture session begin', {missionId, source});
  }

  function forceEnd(): void {
    stopHeartbeat();
    if (!session) {
      return;
    }
    scLog('Mission capture session force end', {
      missionId: session.missionId,
      source: session.source,
    });
    session = null;
    invokeResume();
  }

  function reset(): void {
    stopHeartbeat();
    session = null;
  }

  function isPaused(): boolean {
    return session !== null;
  }

  async function checkBackstop(): Promise<void> {
    const current = session;
    if (!current) {
      return;
    }

    const totalAge = deps.now() - current.startedAtMs;
    if (totalAge > MISSION_SESSION_HARD_MAX_MS) {
      scWarn(
        'Mission capture session exceeded HARD max age — force-releasing regardless of liveness',
        {
          missionId: current.missionId,
          source: current.source,
          totalAgeMs: totalAge,
        },
      );
      forceEnd();
      return;
    }

    const age = deps.now() - current.lastTouchedAtMs;
    if (age <= MISSION_SESSION_MAX_MS) {
      return;
    }

    if (current.source === 'overlay' && deps.isOverlayShowing) {
      let stillShowing = false;
      try {
        stillShowing = await deps.isOverlayShowing();
      } catch {
        // Fails toward reclaiming — consistent with this file's "unconditional release fails
        // toward more monitoring" philosophy.
        stillShowing = false;
      }
      if (session !== current) {
        // The session identity changed while we awaited the native query (handoff, an unrelated
        // forceEnd, a fresh begin()) — nothing to do; the next check will evaluate the new session
        // fresh, on its own timestamps.
        return;
      }
      if (stillShowing) {
        touch(current.missionId);
        scLog(
          'Mission capture session backstop deferred — overlay still attached',
          {
            missionId: current.missionId,
          },
        );
        return;
      }
    }

    if (session !== current) {
      return;
    }
    scWarn('Mission capture session exceeded max age — force-releasing', {
      missionId: current.missionId,
      source: current.source,
      ageMs: age,
    });
    forceEnd();
  }

  function payOwedResume(): void {
    if (resumeOwed) {
      invokeResume();
    }
  }

  function registerHandlers(
    pause: CaptureControl,
    resume: CaptureControl,
  ): void {
    pauseCaptureFn = pause;
    resumeCaptureFn = resume;
  }

  function unregisterHandlers(): void {
    pauseCaptureFn = null;
    resumeCaptureFn = null;
  }

  return {
    begin,
    forceEnd,
    reset,
    isPaused,
    checkBackstop,
    touch,
    startHeartbeat,
    payOwedResume,
    registerHandlers,
    unregisterHandlers,
  };
}

const tracker = createMissionCaptureSessionTracker({
  now: () => Date.now(),
  isOverlayShowing: nativeIsOverlayShowing,
});

export function registerMissionCaptureHandlers(
  pause: CaptureControl,
  resume: CaptureControl,
): void {
  tracker.registerHandlers(pause, resume);
}

export function unregisterMissionCaptureHandlers(): void {
  tracker.unregisterHandlers();
}

export function isMissionCapturePaused(): boolean {
  return tracker.isPaused();
}

export function beginMissionCaptureSession(
  missionId: string,
  source: MissionCaptureSource,
): void {
  tracker.begin(missionId, source);
}

/** Always resume capture when a mission flow ends, regardless of which mission opened it. */
export function forceEndMissionCaptureSession(): void {
  tracker.forceEnd();
}

/** Clears a stuck session (e.g. monitoring toggled off/on, or a MediaProjection revoke). Does not resume native capture. */
export function resetMissionCaptureSession(): void {
  tracker.reset();
}

/**
 * Force-releases a stale session. Call from signals that survive backgrounding. Async since the
 * 'overlay' source may await a native liveness query (see the top-of-file doc comment,
 * ALL_IS_FIXED #58) — callers on hot paths should call this with `void` rather than awaiting it;
 * see C3 in the ALL_IS_FIXED #58 plan for the resulting one-event capture-resume delay.
 */
export async function checkMissionCaptureSessionBackstop(): Promise<void> {
  await tracker.checkBackstop();
}

/** Pays a resume that was owed because no handler was registered at release time. Safe to call speculatively. */
export function payOwedMissionCaptureResume(): void {
  tracker.payOwedResume();
}

/**
 * Refreshes the lease's proof-of-life clock if `missionId` matches the currently open session.
 * No-ops otherwise — never resurrects a closed session or extends a different one.
 */
export function touchMissionCaptureSession(missionId: string): void {
  tracker.touch(missionId);
}

/**
 * Starts (or restarts) a periodic proof-of-life touch for `missionId`. Only safe for a UI that is
 * guaranteed to be foregrounded whenever it's mounted — see the top-of-file doc comment for why
 * this is correct for MissionScreen and NOT used for the overlay.
 */
export function startMissionCaptureSessionHeartbeat(missionId: string): void {
  tracker.startHeartbeat(missionId);
}
