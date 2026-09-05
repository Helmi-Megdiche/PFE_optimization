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
 * Backstop: a lease older than MISSION_SESSION_MAX_MS force-releases itself the next time
 * checkMissionCaptureSessionBackstop() runs (see useScreenshotCapture's handleA11yWindowChanged
 * and useMissionOverlayListener's AppState listener). This is a lease expiry on a known,
 * timestamped fact, not an inference from silence — it does not contradict a11yHealth's "no
 * time-based decay" rule, which is about inferring service health from the absence of a signal.
 * The native periodic tick cannot drive this: pauseCapture() stops the tick's Runnable from
 * rescheduling itself, so onNativePeriodicTick is silent for the entire lifetime of a paused
 * session — exactly when a backstop would need to fire. The backstop instead rides two signals
 * proven to survive backgrounding: a11y window-changed events (DeviceEventEmitter-driven, not
 * foreground-gated) and AppState -> 'active'. It does NOT fire while the a11y service is down and
 * the app never foregrounds, and not at all while the screen is off (JS thread frozen) — a bound,
 * not a guarantee.
 *
 * Same missionId + same source is a no-op. Same missionId + a different source (the
 * overlay -> MissionScreen handoff) re-stamps the lease's clock rather than preserving the
 * original start time — a source change is evidence of a live owner (a newly-mounted component
 * whose unmount will release the lease), so the ceiling should measure time-since-engagement, not
 * time-since-overlay-shown. This cannot be looped to extend a lease indefinitely:
 * presentMissionFromCapture (the only caller that passes a source) is reachable only from the
 * frame-processing path, itself gated by isMissionCapturePaused(), so it cannot re-fire while a
 * session is already open; the quiz-retry path calls showMissionOverlay directly without a fresh
 * begin().
 */

import {scLog, scWarn} from './screenCaptureLogger';

export const MISSION_SESSION_MAX_MS = 10 * 60 * 1000;

export type MissionCaptureSource = 'overlay' | 'screen' | 'fallback';

type CaptureControl = () => void | Promise<void>;

interface MissionCaptureSession {
  missionId: string;
  source: MissionCaptureSource;
  startedAtMs: number;
}

export interface MissionCaptureSessionTracker {
  begin: (missionId: string, source: MissionCaptureSource) => void;
  forceEnd: () => void;
  reset: () => void;
  isPaused: () => boolean;
  checkBackstop: () => void;
  payOwedResume: () => void;
  registerHandlers: (pause: CaptureControl, resume: CaptureControl) => void;
  unregisterHandlers: () => void;
}

export function createMissionCaptureSessionTracker(deps: {
  now: () => number;
}): MissionCaptureSessionTracker {
  let session: MissionCaptureSession | null = null;
  let pauseCaptureFn: CaptureControl | null = null;
  let resumeCaptureFn: CaptureControl | null = null;
  let resumeOwed = false;

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
      session = {missionId, source, startedAtMs: deps.now()};
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

    session = {missionId, source, startedAtMs: deps.now()};
    scLog('Mission capture session begin', {missionId, source});
  }

  function forceEnd(): void {
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
    session = null;
  }

  function isPaused(): boolean {
    return session !== null;
  }

  function checkBackstop(): void {
    if (!session) {
      return;
    }
    const age = deps.now() - session.startedAtMs;
    if (age > MISSION_SESSION_MAX_MS) {
      scWarn('Mission capture session exceeded max age — force-releasing', {
        missionId: session.missionId,
        source: session.source,
        ageMs: age,
      });
      forceEnd();
    }
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
    payOwedResume,
    registerHandlers,
    unregisterHandlers,
  };
}

const tracker = createMissionCaptureSessionTracker({now: () => Date.now()});

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

/** Force-releases a session older than MISSION_SESSION_MAX_MS. Call from signals that survive backgrounding. */
export function checkMissionCaptureSessionBackstop(): void {
  tracker.checkBackstop();
}

/** Pays a resume that was owed because no handler was registered at release time. Safe to call speculatively. */
export function payOwedMissionCaptureResume(): void {
  tracker.payOwedResume();
}
