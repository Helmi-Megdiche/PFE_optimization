import {
  CAPTURE_DEBOUNCE_MS,
  CaptureReason,
  CaptureSkipReason,
  createCaptureCoordinator,
  FOLLOW_UP_MIN_GAP_MS,
  isForceCaptureReason,
  isKeyboardSuppressibleReason,
} from '../src/capture/captureCoordinator';

interface Harness {
  clock: {t: number};
  flags: {monitoring: boolean; paused: boolean; processing: boolean};
  logs: Array<{event: string; data?: Record<string, unknown>}>;
  coordinator: ReturnType<typeof createCaptureCoordinator>;
}

function makeHarness(): Harness {
  const clock = {t: 0};
  const flags = {monitoring: true, paused: false, processing: false};
  const logs: Harness['logs'] = [];
  const coordinator = createCaptureCoordinator({
    now: () => clock.t,
    isMonitoring: () => flags.monitoring,
    isMissionPaused: () => flags.paused,
    isProcessing: () => flags.processing,
    log: (event, data) => logs.push({event, data}),
  });
  return {clock, flags, logs, coordinator};
}

describe('captureCoordinator', () => {
  it('exposes the preserved numeric constants', () => {
    expect(CAPTURE_DEBOUNCE_MS).toBe(5_000);
    expect(FOLLOW_UP_MIN_GAP_MS).toBe(2_000);
  });

  it('debounces rapid duplicate requests within the 5s window', () => {
    const {clock, coordinator} = makeHarness();

    const first = coordinator.requestCapture(CaptureReason.APP_SWITCH);
    expect(first.allowed).toBe(true);
    coordinator.onFrameAccepted(clock.t);

    clock.t = 1_000;
    const second = coordinator.requestCapture(CaptureReason.APP_SWITCH);
    expect(second).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.DEBOUNCED,
    });

    clock.t = 5_000;
    const third = coordinator.requestCapture(CaptureReason.APP_SWITCH);
    expect(third.allowed).toBe(true);
  });

  it('uses the 2s gap for follow-up but 5s for everything else', () => {
    const {clock, coordinator} = makeHarness();
    coordinator.onFrameAccepted(0);

    clock.t = 2_000;
    expect(
      coordinator.requestCapture(CaptureReason.APP_SWITCH_FOLLOW_UP).allowed,
    ).toBe(true);
    expect(coordinator.requestCapture(CaptureReason.APP_SWITCH).allowed).toBe(
      false,
    );
  });

  it('defers a request while OCR is busy and exposes it via takePendingReason', () => {
    const {flags, coordinator} = makeHarness();
    flags.processing = true;

    const decision = coordinator.requestCapture(
      CaptureReason.PERIODIC_FALLBACK,
    );
    expect(decision).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.BUSY_DEFERRED,
      pendingReason: CaptureReason.PERIODIC_FALLBACK,
    });

    expect(coordinator.takePendingReason()).toBe(
      CaptureReason.PERIODIC_FALLBACK,
    );
    expect(coordinator.takePendingReason()).toBeNull();
  });

  it('a lower-priority request does not overwrite a higher pending one (SUPERSEDED)', () => {
    const {flags, coordinator} = makeHarness();
    flags.processing = true;

    coordinator.requestCapture(CaptureReason.APP_SWITCH);
    const superseded = coordinator.requestCapture(
      CaptureReason.PERIODIC_FALLBACK,
    );
    expect(superseded).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.SUPERSEDED,
      pendingReason: CaptureReason.APP_SWITCH,
    });
    expect(coordinator.takePendingReason()).toBe(CaptureReason.APP_SWITCH);
  });

  it('a higher-priority request overwrites a lower pending one', () => {
    const {flags, coordinator} = makeHarness();
    flags.processing = true;

    coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK);
    const overwrite = coordinator.requestCapture(CaptureReason.APP_SWITCH);
    expect(overwrite).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.BUSY_DEFERRED,
      pendingReason: CaptureReason.APP_SWITCH,
    });
    expect(coordinator.takePendingReason()).toBe(CaptureReason.APP_SWITCH);
  });

  it('mission-paused blocks everything, before debounce and deferral', () => {
    const {flags, coordinator} = makeHarness();
    flags.paused = true;
    flags.processing = true;

    const decision = coordinator.requestCapture(CaptureReason.APP_SWITCH);
    expect(decision).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.MISSION_PAUSED,
    });
    // nothing was coalesced
    expect(coordinator.takePendingReason()).toBeNull();
  });

  it('not-monitoring blocks everything, checked first', () => {
    const {flags, coordinator} = makeHarness();
    flags.monitoring = false;
    flags.paused = true;

    const decision = coordinator.requestCapture(CaptureReason.APP_SWITCH);
    expect(decision).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.NOT_MONITORING,
    });
  });

  it('reset clears pending state and the debounce clock', () => {
    const {clock, flags, coordinator} = makeHarness();

    flags.processing = true;
    coordinator.requestCapture(CaptureReason.APP_SWITCH);
    flags.processing = false;
    coordinator.onFrameAccepted(0);

    coordinator.reset();

    expect(coordinator.takePendingReason()).toBeNull();
    clock.t = 1_000;
    expect(coordinator.requestCapture(CaptureReason.APP_SWITCH).allowed).toBe(
      true,
    );
  });
});

describe('captureCoordinator — keyboard suppression', () => {
  const SUPPRESSIBLE = [
    CaptureReason.PERIODIC_FALLBACK,
    CaptureReason.CONTENT_CHANGE,
    CaptureReason.SCROLL_SETTLED,
  ];
  const NOT_SUPPRESSED = [
    CaptureReason.APP_SWITCH,
    CaptureReason.BROWSER_NAVIGATION,
    CaptureReason.RISK_FOLLOW_UP,
    CaptureReason.APP_SWITCH_FOLLOW_UP,
  ];

  it.each(SUPPRESSIBLE)(
    'keyboard visible suppresses %s with KEYBOARD_SUPPRESSED',
    reason => {
      const {coordinator} = makeHarness();
      coordinator.setKeyboardVisible(true);
      expect(coordinator.requestCapture(reason)).toEqual({
        allowed: false,
        skipReason: CaptureSkipReason.KEYBOARD_SUPPRESSED,
      });
    },
  );

  it.each(NOT_SUPPRESSED)(
    'keyboard visible does NOT suppress %s',
    reason => {
      const {coordinator} = makeHarness();
      coordinator.setKeyboardVisible(true);
      // APP_SWITCH_FOLLOW_UP needs the 2s gap satisfied; clean clock at t=0 is fine
      // because lastAcceptedAtMs starts at -Infinity.
      expect(coordinator.requestCapture(reason).allowed).toBe(true);
    },
  );

  it('reset() clears keyboard state', () => {
    const {coordinator} = makeHarness();
    coordinator.setKeyboardVisible(true);
    expect(
      coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK).allowed,
    ).toBe(false);

    coordinator.reset();
    expect(
      coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK).allowed,
    ).toBe(true);
  });

  it('setKeyboardVisible(false) re-enables suppressible reasons without a reset', () => {
    const {coordinator} = makeHarness();
    coordinator.setKeyboardVisible(true);
    expect(
      coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK).allowed,
    ).toBe(false);

    coordinator.setKeyboardVisible(false);
    expect(
      coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK).allowed,
    ).toBe(true);
  });

  it('the keyboard check runs AFTER mission-paused', () => {
    const {flags, logs, coordinator} = makeHarness();
    flags.paused = true;
    flags.processing = true;
    coordinator.setKeyboardVisible(true);

    const decision = coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK);
    expect(decision).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.MISSION_PAUSED,
    });
    const skips = logs.filter(l => l.event === 'capture.skipped');
    expect(skips[skips.length - 1].data).toMatchObject({
      skipReason: CaptureSkipReason.MISSION_PAUSED,
    });
  });

  it('the keyboard check runs BEFORE the isProcessing deferral', () => {
    const {flags, logs, coordinator} = makeHarness();
    flags.paused = false;
    flags.processing = true;
    coordinator.setKeyboardVisible(true);

    const decision = coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK);
    expect(decision).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.KEYBOARD_SUPPRESSED,
    });
    const skips = logs.filter(l => l.event === 'capture.skipped');
    expect(skips[skips.length - 1].data).toMatchObject({
      skipReason: CaptureSkipReason.KEYBOARD_SUPPRESSED,
    });
    // nothing was coalesced as a pending reason
    expect(coordinator.takePendingReason()).toBeNull();
  });
});

describe('isKeyboardSuppressibleReason', () => {
  const SUPPRESSIBLE: CaptureReason[] = [
    CaptureReason.PERIODIC_FALLBACK,
    CaptureReason.CONTENT_CHANGE,
    CaptureReason.SCROLL_SETTLED,
  ];
  const NOT_SUPPRESSIBLE: CaptureReason[] = [
    CaptureReason.APP_SWITCH,
    CaptureReason.APP_SWITCH_LAUNCHER_RETURN,
    CaptureReason.APP_SWITCH_FOLLOW_UP,
    CaptureReason.APP_SWITCH_DEFERRED,
    CaptureReason.APPSTATE_BACKGROUND,
    CaptureReason.MISSION_RESUME,
    CaptureReason.RISK_FOLLOW_UP,
    CaptureReason.BROWSER_NAVIGATION,
  ];

  it.each(SUPPRESSIBLE)('returns true for %s', reason => {
    expect(isKeyboardSuppressibleReason(reason)).toBe(true);
  });

  it.each(NOT_SUPPRESSIBLE)('returns false for %s', reason => {
    expect(isKeyboardSuppressibleReason(reason)).toBe(false);
  });

  it('covers every CaptureReason member exactly once (3 true, 8 false)', () => {
    const all = Object.values(CaptureReason);
    expect(all).toHaveLength(11);
    expect(SUPPRESSIBLE).toHaveLength(3);
    expect(NOT_SUPPRESSIBLE).toHaveLength(8);
    expect(all.filter(isKeyboardSuppressibleReason)).toHaveLength(3);
    expect(new Set([...SUPPRESSIBLE, ...NOT_SUPPRESSIBLE]).size).toBe(11);
  });
});

describe('isForceCaptureReason', () => {
  const FORCE_REASONS: CaptureReason[] = [
    CaptureReason.APP_SWITCH,
    CaptureReason.APP_SWITCH_LAUNCHER_RETURN,
    CaptureReason.APP_SWITCH_DEFERRED,
    CaptureReason.BROWSER_NAVIGATION,
  ];
  const NON_FORCE_REASONS: CaptureReason[] = [
    CaptureReason.APP_SWITCH_FOLLOW_UP,
    CaptureReason.APPSTATE_BACKGROUND,
    CaptureReason.MISSION_RESUME,
    CaptureReason.PERIODIC_FALLBACK,
    CaptureReason.RISK_FOLLOW_UP,
    CaptureReason.CONTENT_CHANGE,
    CaptureReason.SCROLL_SETTLED,
  ];

  it.each(FORCE_REASONS)(
    'returns true for %s (tier-0, bypasses hash gate)',
    reason => {
      expect(isForceCaptureReason(reason)).toBe(true);
    },
  );

  it.each(NON_FORCE_REASONS)('returns false for %s', reason => {
    expect(isForceCaptureReason(reason)).toBe(false);
  });

  it('covers every CaptureReason member exactly once (4 true, 7 false)', () => {
    const all = Object.values(CaptureReason);
    expect(all).toHaveLength(11);
    expect(FORCE_REASONS).toHaveLength(4);
    expect(NON_FORCE_REASONS).toHaveLength(7);
    expect(all.filter(isForceCaptureReason)).toHaveLength(4);
    expect(new Set([...FORCE_REASONS, ...NON_FORCE_REASONS]).size).toBe(11);
  });
});

describe('captureCoordinator — native rejection', () => {
  it('native interval-floor rejection does not advance the debounce clock', () => {
    const {clock, coordinator} = makeHarness();

    expect(coordinator.requestCapture(CaptureReason.APP_SWITCH).allowed).toBe(
      true,
    );
    coordinator.onFrameAccepted(1_000); // debounce clock anchored at t=1000

    clock.t = 3_000;
    coordinator.onNativeRejected('interval_floor');

    // 4500ms since the anchor — still inside the 5s window. If the rejection had
    // advanced the clock to 3000 this would be allowed; if it had rewound it to
    // -Infinity it would also be allowed. It must stay anchored at 1000.
    clock.t = 5_500;
    expect(coordinator.requestCapture(CaptureReason.APP_SWITCH)).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.DEBOUNCED,
    });

    // 5001ms since the anchor — now past the window.
    clock.t = 6_001;
    expect(coordinator.requestCapture(CaptureReason.APP_SWITCH).allowed).toBe(
      true,
    );
  });

  it('a rejected tier-0 attempt disarms the force flag so the next frame is not bypassed', () => {
    const {clock, coordinator} = makeHarness();

    expect(coordinator.requestCapture(CaptureReason.APP_SWITCH).allowed).toBe(
      true,
    );
    expect(coordinator.isForceArmed()).toBe(true);

    coordinator.onNativeRejected('interval_floor');
    expect(coordinator.isForceArmed()).toBe(false);

    // A later unrelated (non-tier-0) allowed request stays un-armed — the next
    // native frame goes through the normal hash gate.
    clock.t = 10_000;
    expect(
      coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK).allowed,
    ).toBe(true);
    expect(coordinator.isForceArmed()).toBe(false);
  });

  it('a successful tier-0 frame keeps existing bypass behavior (armed, then consumed on frame-accepted)', () => {
    const {clock, coordinator} = makeHarness();

    expect(
      coordinator.requestCapture(CaptureReason.APP_SWITCH_DEFERRED).allowed,
    ).toBe(true);
    expect(coordinator.isForceArmed()).toBe(true); // hook arms native forceNextCapture()

    coordinator.onFrameAccepted(clock.t); // frame succeeded — no onNativeRejected
    expect(coordinator.isForceArmed()).toBe(false); // consumed, not left dangling
  });

  it('a non-tier-0 allowed request never arms the force flag', () => {
    const {coordinator} = makeHarness();
    expect(
      coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK).allowed,
    ).toBe(true);
    expect(coordinator.isForceArmed()).toBe(false);
  });

  it("a 'busy' rejection leaves the force flag armed (the in-flight frame consumes it)", () => {
    const {coordinator} = makeHarness();

    expect(coordinator.requestCapture(CaptureReason.APP_SWITCH).allowed).toBe(
      true,
    );
    expect(coordinator.isForceArmed()).toBe(true);

    coordinator.onNativeRejected('busy');
    expect(coordinator.isForceArmed()).toBe(true);
  });

  it("a 'busy' rejection never touches the debounce clock", () => {
    const {clock, coordinator} = makeHarness();

    coordinator.onFrameAccepted(1_000); // anchor at t=1000
    clock.t = 2_000;
    coordinator.onNativeRejected('busy');

    clock.t = 5_500; // 4500ms since anchor — still inside the window
    expect(coordinator.requestCapture(CaptureReason.APP_SWITCH).allowed).toBe(
      false,
    );
  });

  it('reset() clears the force-arm mirror', () => {
    const {coordinator} = makeHarness();
    expect(coordinator.requestCapture(CaptureReason.APP_SWITCH).allowed).toBe(
      true,
    );
    expect(coordinator.isForceArmed()).toBe(true);

    coordinator.reset();
    expect(coordinator.isForceArmed()).toBe(false);
  });
});

describe('captureCoordinator — PERIODIC_FALLBACK routing (native tick)', () => {
  it('is allowed on a clean coordinator', () => {
    const {coordinator} = makeHarness();
    expect(
      coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK).allowed,
    ).toBe(true);
  });

  it('is keyboard-suppressed exactly like other suppressible reasons', () => {
    const {coordinator} = makeHarness();
    coordinator.setKeyboardVisible(true);
    expect(coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK)).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.KEYBOARD_SUPPRESSED,
    });
  });

  it('is blocked while a mission is paused', () => {
    const {flags, coordinator} = makeHarness();
    flags.paused = true;
    expect(coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK)).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.MISSION_PAUSED,
    });
  });

  it('is debounced within 5s of an accepted frame', () => {
    const {clock, coordinator} = makeHarness();
    coordinator.onFrameAccepted(0);
    clock.t = 4_999;
    expect(coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK)).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.DEBOUNCED,
    });
    clock.t = 5_000;
    expect(
      coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK).allowed,
    ).toBe(true);
  });

  it('is coalesced (BUSY_DEFERRED) while OCR is busy and never arms the force flag', () => {
    const {flags, coordinator} = makeHarness();
    flags.processing = true;
    expect(coordinator.requestCapture(CaptureReason.PERIODIC_FALLBACK)).toEqual({
      allowed: false,
      skipReason: CaptureSkipReason.BUSY_DEFERRED,
      pendingReason: CaptureReason.PERIODIC_FALLBACK,
    });
    expect(coordinator.takePendingReason()).toBe(CaptureReason.PERIODIC_FALLBACK);
    expect(coordinator.isForceArmed()).toBe(false);
  });
});
