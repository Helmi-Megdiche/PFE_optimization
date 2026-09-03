import {
  computeAdaptiveIntervalMs,
  computeEffectiveAdaptiveInterval,
  decideScrollSettle,
  decideTickAction,
  initialScrollSettleState,
  NATIVE_TICK_INTERVAL_MS,
  OCR_LOCK_LIVENESS_MS,
  PHASE_DEADLINE_MS,
  pushRiskScore,
  recordScrollEvent,
  RISK_INTERVAL_HIGH_MS,
  RISK_INTERVAL_LOW_MS,
  RISK_INTERVAL_MEDIUM_MS,
  SCROLL_SETTLE_COOLDOWN_MS,
  SCROLL_SETTLE_MS,
  shouldEmitPeriodicCapture,
  shouldForceReleasePhase,
  shouldForceReleaseProcessingLock,
} from '../src/utils/adaptiveCapture';

/**
 * Run a native-tick train through the subsample gate and return the realized
 * spacing (ms) between the ticks that passed. Mirrors the hook's tick handler:
 * `lastPass` only advances on a pass.
 */
function realizedSpacings(tickMs: number, targetMs: number, ticks = 120): number[] {
  let lastPass = 0; // seed at 0 (not -Infinity) so we measure steady-state spacing
  const passAt: number[] = [];
  for (let k = 1; k <= ticks; k++) {
    const now = k * tickMs;
    if (shouldEmitPeriodicCapture(now, lastPass, targetMs)) {
      passAt.push(now);
      lastPass = now;
    }
  }
  const gaps: number[] = [];
  for (let i = 1; i < passAt.length; i++) {
    gaps.push(passAt[i] - passAt[i - 1]);
  }
  return gaps;
}

describe('adaptiveCapture', () => {
  it('uses 10s interval when average risk > 70', () => {
    expect(computeAdaptiveIntervalMs([85, 90, 80])).toBe(RISK_INTERVAL_HIGH_MS);
  });

  it('uses 15s interval when average risk is 30-70', () => {
    expect(computeAdaptiveIntervalMs([40, 50, 45])).toBe(RISK_INTERVAL_MEDIUM_MS);
  });

  it('uses 20s interval when average risk < 30', () => {
    expect(computeAdaptiveIntervalMs([10, 15, 20])).toBe(RISK_INTERVAL_LOW_MS);
  });

  it('returns to 20s after three low-risk captures', () => {
    let history: number[] = [];
    history = pushRiskScore(history, 85);
    expect(computeAdaptiveIntervalMs(history)).toBe(RISK_INTERVAL_HIGH_MS);
    history = pushRiskScore(history, 10);
    history = pushRiskScore(history, 12);
    history = pushRiskScore(history, 8);
    expect(computeAdaptiveIntervalMs(history)).toBe(RISK_INTERVAL_LOW_MS);
  });

  it('computeEffectiveAdaptiveInterval caps Chrome at 15s when risk base is 20s', () => {
    expect(
      computeEffectiveAdaptiveInterval([10, 15, 20], 'com.android.chrome'),
    ).toBe(15_000);
  });

  it('computeEffectiveAdaptiveInterval keeps 10s for high-risk Chrome', () => {
    expect(
      computeEffectiveAdaptiveInterval([85, 90, 80], 'com.android.chrome'),
    ).toBe(RISK_INTERVAL_HIGH_MS);
  });

  it('computeEffectiveAdaptiveInterval returns 0 for games', () => {
    expect(
      computeEffectiveAdaptiveInterval([10, 15, 20], 'com.roblox.client'),
    ).toBe(0);
  });

  it('computeEffectiveAdaptiveInterval ignores unknown package', () => {
    expect(computeEffectiveAdaptiveInterval([85, 90, 80], 'unknown')).toBe(
      RISK_INTERVAL_HIGH_MS,
    );
    expect(computeEffectiveAdaptiveInterval([85, 90, 80])).toBe(
      RISK_INTERVAL_HIGH_MS,
    );
  });

  it('computeEffectiveAdaptiveInterval floors education at 120s', () => {
    expect(
      computeEffectiveAdaptiveInterval([85, 90, 80], 'com.duolingo'),
    ).toBe(120_000);
  });
});

describe('shouldEmitPeriodicCapture (native-tick subsample gate)', () => {
  it('never passes when the target interval is 0 (category disables periodic)', () => {
    expect(shouldEmitPeriodicCapture(1_000_000, Number.NEGATIVE_INFINITY, 0)).toBe(
      false,
    );
  });

  it('never passes for a negative target', () => {
    expect(shouldEmitPeriodicCapture(1_000_000, 0, -5)).toBe(false);
  });

  it('does not pass before a full target interval has elapsed', () => {
    expect(shouldEmitPeriodicCapture(19_999, 0, 20_000)).toBe(false);
  });

  it('passes exactly at the target interval', () => {
    expect(shouldEmitPeriodicCapture(20_000, 0, 20_000)).toBe(true);
  });

  it('passes past the target interval', () => {
    expect(shouldEmitPeriodicCapture(45_000, 20_000, 20_000)).toBe(true);
  });

  it('the first tick always passes (lastPassAt = -Infinity)', () => {
    expect(
      shouldEmitPeriodicCapture(0, Number.NEGATIVE_INFINITY, RISK_INTERVAL_LOW_MS),
    ).toBe(true);
  });

  it('NATIVE_TICK_INTERVAL_MS is 5s and divides every effective interval exactly (no quantization)', () => {
    expect(NATIVE_TICK_INTERVAL_MS).toBe(5_000);
    for (const target of [
      RISK_INTERVAL_HIGH_MS,
      RISK_INTERVAL_MEDIUM_MS,
      RISK_INTERVAL_LOW_MS,
      120_000,
    ]) {
      expect(target % NATIVE_TICK_INTERVAL_MS).toBe(0);
    }
  });
});

describe('native-tick subsample realizes each target exactly (A3c-2 quantization fix)', () => {
  it.each([
    [RISK_INTERVAL_HIGH_MS],
    [RISK_INTERVAL_MEDIUM_MS],
    [RISK_INTERVAL_LOW_MS],
    [120_000],
  ])('a %ims target is realized with exact %ims spacing on the 5s tick', (target) => {
    const gaps = realizedSpacings(NATIVE_TICK_INTERVAL_MS, target);
    expect(gaps.length).toBeGreaterThan(2);
    for (const gap of gaps) {
      expect(gap).toBe(target);
    }
  });

  it('permanent guard: a 10s tick CANNOT realize a 15s target — it quantizes up to 20s (the shipped A3c-2 bug)', () => {
    const gaps = realizedSpacings(10_000, RISK_INTERVAL_MEDIUM_MS);
    expect(gaps.length).toBeGreaterThan(2);
    for (const gap of gaps) {
      expect(gap).toBe(20_000);
    }
  });
});

describe('shouldForceReleaseProcessingLock (backgrounded OCR-lock liveness backstop)', () => {
  it('never releases when the lock is not held, regardless of elapsed', () => {
    expect(shouldForceReleaseProcessingLock(false, 1, 10_000_000, 60_000)).toBe(
      false,
    );
  });

  it('does not release before the threshold has elapsed', () => {
    expect(shouldForceReleaseProcessingLock(true, 1_000, 40_000, 60_000)).toBe(
      false,
    );
  });

  it('releases once the lock has been held past the threshold', () => {
    expect(shouldForceReleaseProcessingLock(true, 1_000, 100_000, 60_000)).toBe(
      true,
    );
  });

  it('releases exactly at the threshold', () => {
    expect(shouldForceReleaseProcessingLock(true, 1_000, 61_000, 60_000)).toBe(
      true,
    );
  });

  it('does not release when the start timestamp is unset (0) even if held', () => {
    expect(shouldForceReleaseProcessingLock(true, 0, 10_000_000, 60_000)).toBe(
      false,
    );
  });

  it('does not release for a negative start timestamp', () => {
    expect(shouldForceReleaseProcessingLock(true, -1, 10_000_000, 60_000)).toBe(
      false,
    );
  });
});

describe('decideTickAction (native-tick action: liveness backstop before subsample gate)', () => {
  const THRESHOLD = OCR_LOCK_LIVENESS_MS;

  it('OCR_LOCK_LIVENESS_MS sits well above the ~40s worst-case legitimate frame and is a whole number of tick intervals', () => {
    expect(OCR_LOCK_LIVENESS_MS).toBe(60_000);
    expect(OCR_LOCK_LIVENESS_MS).toBeGreaterThan(40_000);
    expect(OCR_LOCK_LIVENESS_MS % NATIVE_TICK_INTERVAL_MS).toBe(0);
  });

  it('force-releases a stale lock during a game (target 0) even though the subsample gate would never pass', () => {
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: 1_000 + THRESHOLD + 5_000,
        livenessThresholdMs: THRESHOLD,
        lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
        dynamicIntervalMs: 0,
      }),
    ).toBe('forceReleaseLock');
  });

  it('force-releases a stale lock even when the subsample gate would skip (just passed)', () => {
    const now = 1_000 + THRESHOLD + 5_000;
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: now,
        livenessThresholdMs: THRESHOLD,
        lastPeriodicPassAtMs: now, // 0ms since last pass -> subsample would skip
        dynamicIntervalMs: 20_000,
      }),
    ).toBe('forceReleaseLock');
  });

  it('emits a capture when the lock is free and the subsample interval is due', () => {
    expect(
      decideTickAction({
        isProcessing: false,
        processingStartAtMs: 0,
        nowMs: 100_000,
        livenessThresholdMs: THRESHOLD,
        lastPeriodicPassAtMs: 80_000,
        dynamicIntervalMs: 20_000,
      }),
    ).toBe('emitCapture');
  });

  it('no-ops when the lock is free and the subsample interval is not yet due', () => {
    expect(
      decideTickAction({
        isProcessing: false,
        processingStartAtMs: 0,
        nowMs: 90_000,
        livenessThresholdMs: THRESHOLD,
        lastPeriodicPassAtMs: 80_000,
        dynamicIntervalMs: 20_000,
      }),
    ).toBe('noop');
  });

  it('a healthy long-ish frame (held, under threshold) does not block a due subsample tick', () => {
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: 1_000 + THRESHOLD - 10_000,
        livenessThresholdMs: THRESHOLD,
        lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
        dynamicIntervalMs: 20_000,
      }),
    ).toBe('emitCapture');
  });

  // Note (D1): "a slow ~45s Arabic frame" below is an UNMEASURED hypothetical —
  // it justified this 60s threshold when written, not a measurement. No
  // backgrounded vision-phase duration has ever been logged in this codebase.
  // That is precisely why D1's `vision` phase deadline is `null` (see
  // `PHASE_DEADLINE_MS` / the `shouldForceReleasePhase` describe block below)
  // and deliberately falls through to this 60s backstop rather than guessing a
  // tighter number — see Debt 1 in the D1 plan for what would justify one.
  it('boundary: at threshold + 1ms with a due subsample it force-releases and never emits (clip-risk case, e.g. a slow ~45s Arabic frame — unmeasured, see note above)', () => {
    const action = decideTickAction({
      isProcessing: true,
      processingStartAtMs: 1_000,
      nowMs: 1_000 + THRESHOLD + 1,
      livenessThresholdMs: THRESHOLD,
      lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
      dynamicIntervalMs: 20_000,
    });
    expect(action).toBe('forceReleaseLock');
    expect(action).not.toBe('emitCapture');
  });

  it('boundary: at threshold - 1ms with a due subsample it still emits (release path has not won yet)', () => {
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: 1_000 + THRESHOLD - 1,
        livenessThresholdMs: THRESHOLD,
        lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
        dynamicIntervalMs: 20_000,
      }),
    ).toBe('emitCapture');
  });
});

describe('shouldForceReleasePhase (D1: backgrounded-safe per-phase deadline)', () => {
  it('vision has no deadline (deliberately deferred — see PHASE_DEADLINE_MS)', () => {
    expect(PHASE_DEADLINE_MS.vision).toBeNull();
    expect(PHASE_DEADLINE_MS.foreground_lookup).not.toBeNull();
    expect(PHASE_DEADLINE_MS.api_post).not.toBeNull();
  });

  it('never fires for "vision" regardless of elapsed — regression guard against silently filling the number in', () => {
    expect(
      shouldForceReleasePhase('vision', 1_000, 1_000 + 10 * 60_000, 500, true),
    ).toBe(false);
  });

  it('never fires for "idle" regardless of elapsed', () => {
    expect(
      shouldForceReleasePhase('idle', 1_000, 1_000 + 10 * 60_000, 500, true),
    ).toBe(false);
  });

  it('never fires when phaseStartedAtMs is unset (0)', () => {
    expect(
      shouldForceReleasePhase('foreground_lookup', 0, 1_000_000, 500, true),
    ).toBe(false);
  });

  it('never fires when phaseStartedAtMs is negative', () => {
    expect(
      shouldForceReleasePhase('foreground_lookup', -5, 1_000_000, 500, true),
    ).toBe(false);
  });

  it('never fires when nothing is being processed (isProcessing: false)', () => {
    expect(
      shouldForceReleasePhase('api_post', 1_000, 1_000 + 60_000, 500, false),
    ).toBe(false);
  });

  it('anti-stale guard: never fires when the phase ref predates the frame it claims to belong to, even far past the deadline', () => {
    // A frame started at 40_000; a phase ref claims to have started at 1_000
    // (before the frame existed) — a stale ref left over by a missed reset.
    // Without this guard a 30s-old healthy frame carrying such a ref would be
    // force-released; the absolute-first ordering in decideTickAction does not
    // catch this case because 30s < the 60s backstop.
    expect(
      shouldForceReleasePhase('api_post', 1_000, 100_000, 40_000, true),
    ).toBe(false);
  });

  it('anti-stale guard: fires normally when the phase ref is exactly as old as the frame (equal timestamps, the common case)', () => {
    expect(
      shouldForceReleasePhase(
        'foreground_lookup',
        1_000,
        1_000 + PHASE_DEADLINE_MS.foreground_lookup!,
        1_000,
        true,
      ),
    ).toBe(true);
  });

  it.each([
    ['foreground_lookup', PHASE_DEADLINE_MS.foreground_lookup!],
    ['api_post', PHASE_DEADLINE_MS.api_post!],
  ] as const)(
    'boundary pair: %s does not fire at deadline-1ms, fires at deadline',
    (phase, deadline) => {
      expect(
        shouldForceReleasePhase(phase, 1_000, 1_000 + deadline - 1, 1_000, true),
      ).toBe(false);
      expect(
        shouldForceReleasePhase(phase, 1_000, 1_000 + deadline, 1_000, true),
      ).toBe(true);
    },
  );

  it('every non-null PHASE_DEADLINE_MS value is a whole multiple of NATIVE_TICK_INTERVAL_MS, exceeds its withTimeout budget, and stays under OCR_LOCK_LIVENESS_MS', () => {
    const budgetMs = { foreground_lookup: 2_500, api_post: 12_000 } as const;
    (['foreground_lookup', 'api_post'] as const).forEach((phase) => {
      const deadline = PHASE_DEADLINE_MS[phase];
      expect(deadline).not.toBeNull();
      expect(deadline! % NATIVE_TICK_INTERVAL_MS).toBe(0);
      expect(deadline!).toBeGreaterThan(budgetMs[phase]);
      expect(deadline!).toBeLessThan(OCR_LOCK_LIVENESS_MS);
    });
  });
});

describe('decideTickAction — phase timeout composition (D1)', () => {
  it('returns forceReleasePhase when a live phase is past its deadline and the 60s absolute is not', () => {
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: 1_000 + PHASE_DEADLINE_MS.api_post!,
        livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
        lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
        dynamicIntervalMs: 20_000,
        phase: 'api_post',
        phaseStartedAtMs: 1_000,
      }),
    ).toBe('forceReleasePhase');
  });

  it('a "vision" phase at 55s does not force-release (no phase deadline) — falls through to emitCapture/noop', () => {
    const action = decideTickAction({
      isProcessing: true,
      processingStartAtMs: 1_000,
      nowMs: 1_000 + 55_000,
      livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
      lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
      dynamicIntervalMs: 20_000,
      phase: 'vision',
      phaseStartedAtMs: 1_000,
    });
    expect(action).not.toBe('forceReleasePhase');
  });

  it('the same "vision" frame force-releases via the absolute backstop once it crosses 60s', () => {
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: 1_000 + 65_000,
        livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
        lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
        dynamicIntervalMs: 20_000,
        phase: 'vision',
        phaseStartedAtMs: 1_000,
      }),
    ).toBe('forceReleaseLock');
  });

  it('the 60s backstop still fires when the phase ref is stale (younger than 60s, but the frame itself is 70s old)', () => {
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: 1_000 + 70_000,
        livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
        lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
        dynamicIntervalMs: 20_000,
        phase: 'api_post',
        phaseStartedAtMs: 1_000 + 68_000, // phase "started" 2s ago
      }),
    ).toBe('forceReleaseLock');
  });

  it('the 60s backstop still fires when the phase ref is unset — regression guard for a forgotten reset site', () => {
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: 1_000 + 65_000,
        livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
        lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
        dynamicIntervalMs: 20_000,
        // phase / phaseStartedAtMs omitted — defaults to 'idle' / 0
      }),
    ).toBe('forceReleaseLock');
  });

  it('phase timeout beats a due subsample gate', () => {
    const now = 1_000 + PHASE_DEADLINE_MS.api_post! + 1_000;
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: now,
        livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
        lastPeriodicPassAtMs: now - 30_000, // due
        dynamicIntervalMs: 20_000,
        phase: 'api_post',
        phaseStartedAtMs: 1_000,
      }),
    ).toBe('forceReleasePhase');
  });

  it('phase timeout fires during a game (dynamicIntervalMs 0), where the subsample gate would never pass', () => {
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: 1_000 + PHASE_DEADLINE_MS.foreground_lookup!,
        livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
        lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
        dynamicIntervalMs: 0,
        phase: 'foreground_lookup',
        phaseStartedAtMs: 1_000,
      }),
    ).toBe('forceReleasePhase');
  });

  it('a healthy frame mid-api_post at 10s with a due subsample still emits — the phase deadline does not block routine capture below its threshold', () => {
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 1_000,
        nowMs: 1_000 + 10_000,
        livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
        lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
        dynamicIntervalMs: 20_000,
        phase: 'api_post',
        phaseStartedAtMs: 1_000,
      }),
    ).toBe('emitCapture');
  });

  it('the 8 pre-D1 decideTickAction tests above pass unchanged — phase params are optional and default to the never-firing "idle"', () => {
    // Regression guard, not a new behavioral assertion: re-run the exact
    // pre-D1 liveness-vs-subsample case with no phase params at all.
    expect(
      decideTickAction({
        isProcessing: false,
        processingStartAtMs: 0,
        nowMs: 100_000,
        livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
        lastPeriodicPassAtMs: 80_000,
        dynamicIntervalMs: 20_000,
      }),
    ).toBe('emitCapture');
  });

  // D3: invariant guards on the pure contract that the one-line finally fix in
  // `processCapturedFrame` upholds — a superseded predecessor's late `finally`
  // must not zero the *active* successor frame's start stamp. `processCapturedFrame`
  // has no test harness, so these cannot exercise the moved line itself; they
  // pin the reducer behaviour on either side of it (real stamp -> backstop
  // fires; zeroed stamp -> backstop silently disabled, the pre-D3 bug).
  it('D3: the 60s backstop fires for a successor frame carrying its own real start stamp (predecessor superseded, its late finally left this stamp intact)', () => {
    const successorStart = 50_000;
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: successorStart,
        nowMs: successorStart + OCR_LOCK_LIVENESS_MS,
        livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
        lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY,
        dynamicIntervalMs: 20_000,
        phase: 'vision', // vision has no phase deadline — the 60s absolute is its only backstop
        phaseStartedAtMs: successorStart,
      }),
    ).toBe('forceReleaseLock');
  });

  it('D3: a zeroed start stamp silently disables the 60s backstop (the pre-D3 failure mode: predecessor finally ran `processingStartTimeRef.current = 0` unconditionally)', () => {
    expect(
      decideTickAction({
        isProcessing: true,
        processingStartAtMs: 0, // stomped by a stale predecessor's finally
        nowMs: 50_000 + OCR_LOCK_LIVENESS_MS,
        livenessThresholdMs: OCR_LOCK_LIVENESS_MS,
        lastPeriodicPassAtMs: 50_000 + OCR_LOCK_LIVENESS_MS, // subsample not due either
        dynamicIntervalMs: 20_000,
        phase: 'vision',
        phaseStartedAtMs: 50_000,
      }),
    ).toBe('noop');
  });
});

describe('recordScrollEvent', () => {
  it('stamps lastScrollAtMs, arms, and preserves lastEmitAtMs', () => {
    const s0 = { ...initialScrollSettleState(), lastEmitAtMs: 4_000 };
    const s1 = recordScrollEvent(s0, 9_000);
    expect(s1).toEqual({ lastScrollAtMs: 9_000, armed: true, lastEmitAtMs: 4_000 });
  });
});

describe('decideScrollSettle (tick-driven scroll settle, A3c-3)', () => {
  const base = {
    periodicIntervalMs: 20_000, // default-category app: periodic on, 20s
    lastPeriodicPassAtMs: Number.NEGATIVE_INFINITY, // no recent periodic frame
    settleMs: SCROLL_SETTLE_MS,
    cooldownMs: SCROLL_SETTLE_COOLDOWN_MS,
    periodicGuardMs: 5_000,
  };

  it('does not emit when not armed, state unchanged', () => {
    const state = initialScrollSettleState();
    const out = decideScrollSettle({ ...base, state, nowMs: 1_000_000 });
    expect(out).toEqual({ emit: false, state });
  });

  it('does not emit while still scrolling (last scroll < settleMs ago), stays armed', () => {
    const state = { lastScrollAtMs: 100_000, armed: true, lastEmitAtMs: 0 };
    const out = decideScrollSettle({
      ...base,
      state,
      nowMs: 100_000 + SCROLL_SETTLE_MS - 1,
    });
    expect(out.emit).toBe(false);
    expect(out.state.armed).toBe(true);
    expect(out.state.lastScrollAtMs).toBe(100_000);
  });

  it('emits once settled with no periodic recency and no cooldown; disarms and stamps lastEmitAtMs', () => {
    const state = { lastScrollAtMs: 100_000, armed: true, lastEmitAtMs: 0 };
    const now = 100_000 + SCROLL_SETTLE_MS;
    const out = decideScrollSettle({ ...base, state, nowMs: now });
    expect(out.emit).toBe(true);
    expect(out.state).toEqual({
      armed: false,
      lastScrollAtMs: 100_000,
      lastEmitAtMs: now,
    });
  });

  it('disarms without emitting when the category disables periodic (periodicIntervalMs = 0)', () => {
    const state = { lastScrollAtMs: 100_000, armed: true, lastEmitAtMs: 0 };
    const out = decideScrollSettle({
      ...base,
      state,
      periodicIntervalMs: 0,
      nowMs: 200_000,
    });
    expect(out.emit).toBe(false);
    expect(out.state.armed).toBe(false);
  });

  it('DEFERS (stays armed, no emit) when a periodic frame fired within periodicGuardMs — flaw 1', () => {
    const state = { lastScrollAtMs: 100_000, armed: true, lastEmitAtMs: 0 };
    const now = 100_000 + SCROLL_SETTLE_MS + 3_000;
    const out = decideScrollSettle({
      ...base,
      state,
      lastPeriodicPassAtMs: now - 5_000, // exactly on the guard boundary
      nowMs: now,
    });
    expect(out.emit).toBe(false);
    expect(out.state.armed).toBe(true);
    expect(out.state.lastEmitAtMs).toBe(0); // untouched
  });

  it('emits once the periodic frame is older than periodicGuardMs', () => {
    const state = { lastScrollAtMs: 100_000, armed: true, lastEmitAtMs: 0 };
    const now = 100_000 + SCROLL_SETTLE_MS + 3_000;
    const out = decideScrollSettle({
      ...base,
      state,
      lastPeriodicPassAtMs: now - 5_001, // just past the guard
      nowMs: now,
    });
    expect(out.emit).toBe(true);
  });

  it('DEFERS (stays armed) when settled but still inside the cooldown — defer, not drop (flaw 3)', () => {
    const state = { lastScrollAtMs: 100_000, armed: true, lastEmitAtMs: 95_000 };
    const now = 100_000 + SCROLL_SETTLE_MS; // settled, but 7s since last emit < 10s cooldown
    const out = decideScrollSettle({ ...base, state, nowMs: now });
    expect(out.emit).toBe(false);
    expect(out.state.armed).toBe(true);
    expect(out.state.lastEmitAtMs).toBe(95_000);
  });

  it('emits once the cooldown has expired (deferral resolves on a later tick)', () => {
    const state = { lastScrollAtMs: 100_000, armed: true, lastEmitAtMs: 95_000 };
    const now = 95_000 + SCROLL_SETTLE_COOLDOWN_MS; // cooldown boundary
    const out = decideScrollSettle({ ...base, state, nowMs: now });
    expect(out.emit).toBe(true);
    expect(out.state.lastEmitAtMs).toBe(now);
  });

  it('cooldown boundary: === cooldownMs emits (strict <), cooldownMs - 1 defers', () => {
    const state = { lastScrollAtMs: 0, armed: true, lastEmitAtMs: 50_000 };
    const atBoundary = decideScrollSettle({
      ...base,
      state,
      nowMs: 50_000 + SCROLL_SETTLE_COOLDOWN_MS,
    });
    expect(atBoundary.emit).toBe(true);
    const justInside = decideScrollSettle({
      ...base,
      state,
      nowMs: 50_000 + SCROLL_SETTLE_COOLDOWN_MS - 1,
    });
    expect(justInside.emit).toBe(false);
    expect(justInside.state.armed).toBe(true);
  });

  it('first emit ignores the cooldown check when lastEmitAtMs is 0', () => {
    const state = { lastScrollAtMs: 0, armed: true, lastEmitAtMs: 0 };
    const out = decideScrollSettle({ ...base, state, nowMs: 3_000 });
    expect(out.emit).toBe(true);
  });

  it('education-scale cooldown (120s) defers every settle across the 10-119s window', () => {
    const state = { lastScrollAtMs: 0, armed: true, lastEmitAtMs: 10_000 };
    for (const dt of [10_000, 30_000, 60_000, 119_000]) {
      const out = decideScrollSettle({
        ...base,
        state,
        cooldownMs: 120_000,
        nowMs: 10_000 + dt,
      });
      expect(out.emit).toBe(false);
      expect(out.state.armed).toBe(true);
    }
    const past = decideScrollSettle({
      ...base,
      state,
      cooldownMs: 120_000,
      nowMs: 10_000 + 120_000,
    });
    expect(past.emit).toBe(true);
  });

  it('a continuous burst (scroll every tick) never emits — re-arming keeps lastScrollAtMs fresh', () => {
    let state = initialScrollSettleState();
    for (let k = 1; k <= 12; k++) {
      const now = k * NATIVE_TICK_INTERVAL_MS;
      state = recordScrollEvent(state, now); // a scroll landed this tick
      const out = decideScrollSettle({ ...base, state, nowMs: now });
      expect(out.emit).toBe(false);
      state = out.state;
    }
    expect(state.armed).toBe(true);
  });
});
