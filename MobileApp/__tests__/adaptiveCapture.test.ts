import {
  computeAdaptiveIntervalMs,
  computeEffectiveAdaptiveInterval,
  decideTickAction,
  NATIVE_TICK_INTERVAL_MS,
  OCR_LOCK_LIVENESS_MS,
  pushRiskScore,
  RISK_INTERVAL_HIGH_MS,
  RISK_INTERVAL_LOW_MS,
  RISK_INTERVAL_MEDIUM_MS,
  shouldEmitPeriodicCapture,
  shouldForceReleaseProcessingLock,
} from '../src/utils/adaptiveCapture';

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

  it('NATIVE_TICK_INTERVAL_MS is the fastest effective interval so subsampling can realize every slower one', () => {
    expect(NATIVE_TICK_INTERVAL_MS).toBe(RISK_INTERVAL_HIGH_MS);
    expect(NATIVE_TICK_INTERVAL_MS).toBeLessThanOrEqual(RISK_INTERVAL_MEDIUM_MS);
    expect(NATIVE_TICK_INTERVAL_MS).toBeLessThanOrEqual(RISK_INTERVAL_LOW_MS);
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

  it('boundary: at threshold + 1ms with a due subsample it force-releases and never emits (clip-risk case, e.g. a slow ~45s Arabic frame)', () => {
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
