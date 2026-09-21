import {
  MISSION_SESSION_MAX_MS,
  MISSION_SESSION_HARD_MAX_MS,
  MISSION_TOUCH_INTERVAL_MS,
  createMissionCaptureSessionTracker,
} from '../src/utils/missionCaptureSession';

function makeTracker() {
  const clock = {t: 0};
  const tracker = createMissionCaptureSessionTracker({now: () => clock.t});
  return {clock, tracker};
}

/** Fake single-slot interval scheduler — mirrors the tracker's "one handle, not a counter" model. */
function makeSchedulableTracker(
  extraDeps: {isOverlayShowing?: () => Promise<boolean>} = {},
) {
  const clock = {t: 0};
  type ScheduledEntry = {fn: () => void; id: number};
  const scheduled: ScheduledEntry[] = [];
  let nextId = 1;
  const setIntervalFn = jest.fn((fn: () => void) => {
    const id = nextId++;
    scheduled.push({fn, id});
    return id as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalFn = jest.fn((handle: ReturnType<typeof setInterval>) => {
    const idx = scheduled.findIndex(
      s => s.id === (handle as unknown as number),
    );
    if (idx !== -1) {
      scheduled.splice(idx, 1);
    }
  });
  const tracker = createMissionCaptureSessionTracker({
    now: () => clock.t,
    setIntervalFn,
    clearIntervalFn,
    ...extraDeps,
  });
  const tickLatest = () => {
    const entry = scheduled[scheduled.length - 1];
    entry?.fn();
  };
  return {
    clock,
    tracker,
    scheduled,
    setIntervalFn,
    clearIntervalFn,
    tickLatest,
  };
}

describe('missionCaptureSession — begin/forceEnd basics', () => {
  it('begin then forceEnd releases once and resumes once; a second forceEnd is a no-op', () => {
    const {tracker} = makeTracker();
    const pause = jest.fn();
    const resume = jest.fn();
    tracker.registerHandlers(pause, resume);

    tracker.begin('A', 'screen');
    expect(pause).toHaveBeenCalledTimes(1);
    expect(tracker.isPaused()).toBe(true);

    tracker.forceEnd();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(tracker.isPaused()).toBe(false);

    tracker.forceEnd();
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe('missionCaptureSession — idempotent begin', () => {
  it('same id, same source is a pure no-op — does not re-pause or restart the clock', () => {
    const {clock, tracker} = makeTracker();
    const pause = jest.fn();
    tracker.registerHandlers(pause, jest.fn());

    tracker.begin('A', 'overlay');
    expect(pause).toHaveBeenCalledTimes(1);

    clock.t = MISSION_SESSION_MAX_MS;
    tracker.begin('A', 'overlay');
    expect(pause).toHaveBeenCalledTimes(1);

    tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(true);

    clock.t = MISSION_SESSION_MAX_MS + 1;
    tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
  });

  it('same id, different source re-stamps the clock — both halves', () => {
    const {clock, tracker} = makeTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());

    tracker.begin('A', 'overlay');
    const nineMin = 9 * 60 * 1000;
    clock.t = nineMin;
    tracker.begin('A', 'screen');

    clock.t = nineMin + MISSION_SESSION_MAX_MS;
    tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(true);

    clock.t = nineMin + MISSION_SESSION_MAX_MS + 1;
    tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
  });

  it('begin(A) then begin(B) mid-session: A closes without a resume call, B opens fresh', () => {
    const {tracker} = makeTracker();
    const pause = jest.fn();
    const resume = jest.fn();
    tracker.registerHandlers(pause, resume);

    tracker.begin('A', 'screen');
    expect(pause).toHaveBeenCalledTimes(1);

    tracker.begin('B', 'screen');
    expect(resume).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(tracker.isPaused()).toBe(true);

    tracker.forceEnd();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(tracker.isPaused()).toBe(false);
  });
});

describe('missionCaptureSession — forceEnd / reset', () => {
  it('forceEnd from empty state is a no-op', () => {
    const {tracker} = makeTracker();
    const resume = jest.fn();
    tracker.registerHandlers(jest.fn(), resume);
    tracker.forceEnd();
    expect(resume).not.toHaveBeenCalled();
  });

  it('reset clears without resuming', () => {
    const {tracker} = makeTracker();
    const resume = jest.fn();
    tracker.registerHandlers(jest.fn(), resume);
    tracker.begin('A', 'screen');
    tracker.reset();
    expect(tracker.isPaused()).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('missionCaptureSession — backstop', () => {
  it('does not expire at exactly MISSION_SESSION_MAX_MS, does expire at +1ms (strict >)', () => {
    const {clock, tracker} = makeTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'screen');

    clock.t = MISSION_SESSION_MAX_MS;
    tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(true);

    clock.t = MISSION_SESSION_MAX_MS + 1;
    tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
  });

  it('expiry resumes exactly once and leaves the module cleanly re-beginnable', () => {
    const {clock, tracker} = makeTracker();
    const resume = jest.fn();
    tracker.registerHandlers(jest.fn(), resume);
    tracker.begin('A', 'screen');

    clock.t = MISSION_SESSION_MAX_MS + 1;
    tracker.checkBackstop();
    expect(resume).toHaveBeenCalledTimes(1);

    tracker.begin('B', 'screen');
    expect(tracker.isPaused()).toBe(true);
  });
});

describe('missionCaptureSession — owed resume debt', () => {
  it('release with no resume handler registered still clears the session', () => {
    const {tracker} = makeTracker();
    tracker.begin('A', 'screen');
    tracker.forceEnd();
    expect(tracker.isPaused()).toBe(false);
  });

  it('payOwedResume pays a debt once a handler is registered, then is a no-op', () => {
    const {tracker} = makeTracker();
    tracker.begin('A', 'screen');
    tracker.forceEnd();

    const resume = jest.fn();
    tracker.registerHandlers(jest.fn(), resume);
    tracker.payOwedResume();
    expect(resume).toHaveBeenCalledTimes(1);

    tracker.payOwedResume();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('payOwedResume with the debt still unregistered is a no-op and leaves the debt armed', () => {
    const {tracker} = makeTracker();
    tracker.begin('A', 'screen');
    tracker.forceEnd();

    tracker.payOwedResume();

    const resume = jest.fn();
    tracker.registerHandlers(jest.fn(), resume);
    tracker.payOwedResume();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('payOwedResume with no debt owed is a no-op regardless of registration state', () => {
    const {tracker} = makeTracker();
    const resume = jest.fn();
    tracker.registerHandlers(jest.fn(), resume);
    tracker.payOwedResume();
    expect(resume).not.toHaveBeenCalled();
  });

  it('an ordinary resume elsewhere retires a stale debt — no double resume', () => {
    const {tracker} = makeTracker();
    tracker.begin('A', 'screen');
    tracker.forceEnd();

    const resume = jest.fn();
    tracker.registerHandlers(jest.fn(), resume);

    tracker.begin('B', 'screen');
    tracker.forceEnd();
    expect(resume).toHaveBeenCalledTimes(1);

    tracker.payOwedResume();
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe('missionCaptureSession — reset survives a monitoring restart', () => {
  it('reset then begin starts a clean session with no bleed-through', () => {
    const {clock, tracker} = makeTracker();
    const pause = jest.fn();
    const resume = jest.fn();
    tracker.registerHandlers(pause, resume);

    tracker.begin('A', 'screen');
    clock.t = 5000;
    tracker.reset();
    expect(resume).not.toHaveBeenCalled();
    expect(tracker.isPaused()).toBe(false);

    tracker.begin('B', 'screen');
    expect(tracker.isPaused()).toBe(true);
    expect(pause).toHaveBeenCalledTimes(2);

    clock.t = 5000 + MISSION_SESSION_MAX_MS;
    tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(true);
  });
});

describe('missionCaptureSession — touch / heartbeat (ALL_IS_FIXED #58)', () => {
  it('a touch after the soft threshold has passed since start defers the backstop', async () => {
    const {clock, tracker} = makeTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'screen');

    const nineMin = 9 * 60 * 1000;
    clock.t = nineMin;
    tracker.touch('A');

    // 18min since start (>10min), but only 9min since the touch (<10min) — must stay paused.
    clock.t = 18 * 60 * 1000;
    await tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(true);

    clock.t = nineMin + MISSION_SESSION_MAX_MS + 1;
    await tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
  });

  it('touch with a mismatched missionId is a no-op', async () => {
    const {clock, tracker} = makeTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'screen');

    clock.t = MISSION_SESSION_MAX_MS;
    tracker.touch('B');

    clock.t = MISSION_SESSION_MAX_MS + 1;
    await tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
  });

  it('touch with no session open is a no-op', () => {
    const {tracker} = makeTracker();
    expect(() => tracker.touch('A')).not.toThrow();
    expect(tracker.isPaused()).toBe(false);
  });

  it('touch never invokes pauseCaptureFn/resumeCaptureFn', () => {
    const {tracker} = makeTracker();
    const pause = jest.fn();
    const resume = jest.fn();
    tracker.registerHandlers(pause, resume);
    tracker.begin('A', 'screen');
    pause.mockClear();

    tracker.touch('A');
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('a source-change restamp also resets lastTouchedAtMs, not just startedAtMs', async () => {
    const {clock, tracker} = makeTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());

    tracker.begin('A', 'overlay');
    const nineMin = 9 * 60 * 1000;
    clock.t = nineMin;
    tracker.begin('A', 'screen'); // restamp

    clock.t = nineMin + MISSION_SESSION_MAX_MS;
    await tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(true);

    clock.t = nineMin + MISSION_SESSION_MAX_MS + 1;
    await tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
  });

  it(
    'startHeartbeat performs an immediate touch — proves the touch->backstop relationship only; ' +
      'whether RN actually invokes the scheduled interval callback has no test harness here and is ' +
      'device-smoke-only',
    async () => {
      const {clock, tracker} = makeSchedulableTracker();
      tracker.registerHandlers(jest.fn(), jest.fn());
      tracker.begin('A', 'screen');

      clock.t = MISSION_SESSION_MAX_MS;
      tracker.startHeartbeat('A'); // immediate touch resets lastTouchedAtMs to MISSION_SESSION_MAX_MS

      clock.t = MISSION_SESSION_MAX_MS + MISSION_SESSION_MAX_MS; // +10min since the touch, not since start
      await tracker.checkBackstop();
      expect(tracker.isPaused()).toBe(true);
    },
  );

  it('a continuously heartbeating session (interval callback manually driven) never force-ends', async () => {
    const {clock, tracker, tickLatest} = makeSchedulableTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'screen');
    tracker.startHeartbeat('A');

    // Simulate 50 minutes of a real interval firing every MISSION_TOUCH_INTERVAL_MS — well past
    // the soft threshold, comfortably under the hard ceiling.
    const ticks = Math.floor((50 * 60 * 1000) / MISSION_TOUCH_INTERVAL_MS);
    for (let i = 0; i < ticks; i++) {
      clock.t += MISSION_TOUCH_INTERVAL_MS;
      tickLatest();
      await tracker.checkBackstop();
    }
    expect(tracker.isPaused()).toBe(true);
  });

  it('calling startHeartbeat a second time clears the first handle before creating a new one', () => {
    const {tracker, scheduled, clearIntervalFn} = makeSchedulableTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'screen');

    tracker.startHeartbeat('A');
    expect(scheduled).toHaveLength(1);
    const firstId = scheduled[0].id;

    tracker.startHeartbeat('A');
    expect(clearIntervalFn).toHaveBeenCalledWith(
      firstId as unknown as ReturnType<typeof setInterval>,
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].id).not.toBe(firstId);
  });

  it('forceEnd/reset clear a running heartbeat unconditionally; an already-cleared callback cannot touch a later, different session', () => {
    const {clock, tracker, scheduled} = makeSchedulableTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'screen');
    tracker.startHeartbeat('A');
    expect(scheduled).toHaveLength(1);

    const orphanedTick = scheduled[0].fn; // captured before forceEnd, simulating a scheduler bug
    tracker.forceEnd();
    expect(scheduled).toHaveLength(0);

    tracker.begin('B', 'screen');
    clock.t = 1000;
    orphanedTick(); // would call touch('A') — must not affect B's session
    expect(tracker.isPaused()).toBe(true);

    // reset() also stops a running heartbeat.
    tracker.startHeartbeat('B');
    expect(scheduled).toHaveLength(1);
    tracker.reset();
    expect(scheduled).toHaveLength(0);
  });

  it('leaked lease (screen source, never heartbeated) is still reclaimed by the soft threshold', async () => {
    const {clock, tracker} = makeTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'overlay');

    clock.t = MISSION_SESSION_MAX_MS + 1;
    await tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
  });
});

describe('missionCaptureSession — overlay backstop query (ALL_IS_FIXED #58)', () => {
  it('below the soft threshold, the query is never called', async () => {
    const clock = {t: 0};
    const isOverlayShowing = jest.fn().mockResolvedValue(true);
    const tracker = createMissionCaptureSessionTracker({
      now: () => clock.t,
      isOverlayShowing,
    });
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'overlay');

    clock.t = MISSION_SESSION_MAX_MS;
    await tracker.checkBackstop();
    expect(isOverlayShowing).not.toHaveBeenCalled();
  });

  it('past the soft threshold, overlay source, query resolves true: deferred, not force-ended, and touched', async () => {
    const clock = {t: 0};
    const isOverlayShowing = jest.fn().mockResolvedValue(true);
    const tracker = createMissionCaptureSessionTracker({
      now: () => clock.t,
      isOverlayShowing,
    });
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'overlay');

    clock.t = MISSION_SESSION_MAX_MS + 1;
    await tracker.checkBackstop();
    expect(isOverlayShowing).toHaveBeenCalledTimes(1);
    expect(tracker.isPaused()).toBe(true);

    // The defer touched the lease — another full soft-threshold window must elapse before the
    // next check trips again.
    isOverlayShowing.mockClear();
    clock.t = MISSION_SESSION_MAX_MS + 2;
    await tracker.checkBackstop();
    expect(isOverlayShowing).not.toHaveBeenCalled();
    expect(tracker.isPaused()).toBe(true);
  });

  it('past the soft threshold, overlay source, query resolves false: force-ends', async () => {
    const clock = {t: 0};
    const isOverlayShowing = jest.fn().mockResolvedValue(false);
    const resume = jest.fn();
    const tracker = createMissionCaptureSessionTracker({
      now: () => clock.t,
      isOverlayShowing,
    });
    tracker.registerHandlers(jest.fn(), resume);
    tracker.begin('A', 'overlay');

    clock.t = MISSION_SESSION_MAX_MS + 1;
    await tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('past the soft threshold, overlay source, query rejects: treated as not-showing, force-ends', async () => {
    const clock = {t: 0};
    const isOverlayShowing = jest
      .fn()
      .mockRejectedValue(new Error('bridge dead'));
    const tracker = createMissionCaptureSessionTracker({
      now: () => clock.t,
      isOverlayShowing,
    });
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'overlay');

    clock.t = MISSION_SESSION_MAX_MS + 1;
    await tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
  });

  it('past the soft threshold, screen/fallback sources never call the query, regardless of what it would resolve', async () => {
    const clock = {t: 0};
    const isOverlayShowing = jest.fn().mockResolvedValue(true);
    for (const source of ['screen', 'fallback'] as const) {
      const tracker = createMissionCaptureSessionTracker({
        now: () => clock.t,
        isOverlayShowing,
      });
      tracker.registerHandlers(jest.fn(), jest.fn());
      clock.t = 0;
      tracker.begin('A', source);
      clock.t = MISSION_SESSION_MAX_MS + 1;
      await tracker.checkBackstop();
      expect(isOverlayShowing).not.toHaveBeenCalled();
      expect(tracker.isPaused()).toBe(false);
    }
  });

  it('overlay source with no isOverlayShowing injected falls through to immediate force-end (backward-compat default)', async () => {
    const {clock, tracker} = makeTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'overlay');

    clock.t = MISSION_SESSION_MAX_MS + 1;
    await tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
  });

  it('race: a session mutated while the query is in flight is not resurrected or touched by the stale check (N1)', async () => {
    const clock = {t: 0};
    let resolveQuery!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => {
      resolveQuery = resolve;
    });
    const isOverlayShowing = jest.fn().mockReturnValue(pending);
    const resume = jest.fn();
    const tracker = createMissionCaptureSessionTracker({
      now: () => clock.t,
      isOverlayShowing,
    });
    tracker.registerHandlers(jest.fn(), resume);
    tracker.begin('A', 'overlay');

    clock.t = MISSION_SESSION_MAX_MS + 1;
    const checkPromise = tracker.checkBackstop(); // starts, awaits the still-pending query

    // Mutate the session while the query is in flight: A's check should no longer act on it.
    tracker.forceEnd();
    expect(resume).toHaveBeenCalledTimes(1);
    tracker.begin('B', 'overlay');

    resolveQuery(true);
    await checkPromise;

    // B's session must be untouched by A's stale, now-resolved check.
    expect(tracker.isPaused()).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe('missionCaptureSession — hard ceiling (ALL_IS_FIXED #58, C1)', () => {
  it('deferral repeats normally below the hard ceiling, query always resolving true', async () => {
    const clock = {t: 0};
    const isOverlayShowing = jest.fn().mockResolvedValue(true);
    const tracker = createMissionCaptureSessionTracker({
      now: () => clock.t,
      isOverlayShowing,
    });
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'overlay');

    // Cross the soft threshold repeatedly, well below the hard ceiling.
    for (let i = 1; i <= 3; i++) {
      clock.t = i * (MISSION_SESSION_MAX_MS + 1);
      await tracker.checkBackstop();
      expect(tracker.isPaused()).toBe(true);
    }
    expect(isOverlayShowing.mock.calls.length).toBeGreaterThan(0);
  });

  it('past the hard ceiling, force-ends regardless of the query still resolving true, and logs the hard-ceiling warn distinctly', async () => {
    const clock = {t: 0};
    const isOverlayShowing = jest.fn().mockResolvedValue(true);
    const resume = jest.fn();
    const tracker = createMissionCaptureSessionTracker({
      now: () => clock.t,
      isOverlayShowing,
    });
    tracker.registerHandlers(jest.fn(), resume);
    tracker.begin('A', 'overlay');

    clock.t = MISSION_SESSION_HARD_MAX_MS + 1;
    await tracker.checkBackstop();

    expect(tracker.isPaused()).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    // The hard ceiling is checked first and unconditionally — the query must never even be asked.
    expect(isOverlayShowing).not.toHaveBeenCalled();
  });

  it('the hard ceiling also reclaims screen/fallback sessions (applied universally, not overlay-only)', async () => {
    const {clock, tracker} = makeTracker();
    tracker.registerHandlers(jest.fn(), jest.fn());
    tracker.begin('A', 'screen');

    clock.t = MISSION_SESSION_HARD_MAX_MS + 1;
    await tracker.checkBackstop();
    expect(tracker.isPaused()).toBe(false);
  });
});
