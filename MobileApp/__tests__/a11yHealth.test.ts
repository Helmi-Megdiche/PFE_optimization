import {
  A11Y_MISS_GRACE_MS,
  POLL_FREEZE_GAP_MS,
  createA11yHealthTracker,
} from '../src/capture/a11yHealth';

function makeTracker() {
  const clock = {t: 0};
  const tracker = createA11yHealthTracker({now: () => clock.t});
  return {clock, tracker};
}

describe('a11yHealth — getHealth state machine', () => {
  it('is "off" after reset() while disabled', () => {
    const {tracker} = makeTracker();
    tracker.reset();
    expect(tracker.getHealth()).toBe('off');
  });

  it('is "unverified" once enabled with no events yet', () => {
    const {tracker} = makeTracker();
    tracker.setEnabled(true);
    expect(tracker.getHealth()).toBe('unverified');
  });

  it('is "live" after a real window event', () => {
    const {tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();
    expect(tracker.getHealth()).toBe('live');
  });

  it('"off" outranks a standing miss', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();
    clock.t += A11Y_MISS_GRACE_MS + 1;
    expect(tracker.onPollObservedSwitch()).toBe(true);
    expect(tracker.getHealth()).toBe('degraded');

    tracker.setEnabled(false);
    expect(tracker.getHealth()).toBe('off');
  });
});

describe('a11yHealth — onPollObservedSwitch', () => {
  it('within the grace window: no miss, stays "live"', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();

    clock.t += A11Y_MISS_GRACE_MS - 1;
    expect(tracker.onPollObservedSwitch()).toBe(false);
    expect(tracker.getHealth()).toBe('live');
  });

  it('past the grace window: proven miss, goes "degraded"', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();

    clock.t += A11Y_MISS_GRACE_MS + 1;
    expect(tracker.onPollObservedSwitch()).toBe(true);
    expect(tracker.getHealth()).toBe('degraded');
  });

  it('exactly at the grace boundary is NOT a miss (strict >)', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();

    clock.t += A11Y_MISS_GRACE_MS; // elapsed === missGraceMs
    expect(tracker.onPollObservedSwitch()).toBe(false);
    expect(tracker.getHealth()).toBe('live');
  });

  it('a window event clears a standing miss (degraded -> live)', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();
    clock.t += A11Y_MISS_GRACE_MS + 1;
    tracker.onPollObservedSwitch();
    expect(tracker.getHealth()).toBe('degraded');

    tracker.onWindowEvent();
    expect(tracker.getHealth()).toBe('live');
  });

  it('returns false and records nothing while disabled', () => {
    const {clock, tracker} = makeTracker();
    clock.t += A11Y_MISS_GRACE_MS + 1_000;
    expect(tracker.onPollObservedSwitch()).toBe(false);

    tracker.setEnabled(true);
    expect(tracker.getHealth()).toBe('unverified'); // no miss was latched
  });

  it('a switch just after reset() is inside grace (timestamp is seeded)', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    clock.t = 1_000_000;
    tracker.reset();

    clock.t += A11Y_MISS_GRACE_MS - 1;
    expect(tracker.onPollObservedSwitch()).toBe(false);
    expect(tracker.getHealth()).toBe('unverified');
  });

  it('two consecutive proven misses: the second still returns true, stays degraded', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();

    clock.t += A11Y_MISS_GRACE_MS + 1;
    expect(tracker.onPollObservedSwitch()).toBe(true);

    clock.t += A11Y_MISS_GRACE_MS + 1;
    expect(tracker.onPollObservedSwitch()).toBe(true);
    expect(tracker.getHealth()).toBe('degraded');
  });
});

describe('a11yHealth — setEnabled transitions', () => {
  it('false -> true clears a standing miss (degraded -> unverified when no real event seen)', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    // Reach "degraded" via the poll alone — no onWindowEvent(), so sawRealEvent
    // stays false and clearing the miss should drop straight to "unverified".
    clock.t += A11Y_MISS_GRACE_MS + 1;
    expect(tracker.onPollObservedSwitch()).toBe(true);
    expect(tracker.getHealth()).toBe('degraded');

    tracker.setEnabled(false);
    tracker.setEnabled(true);
    expect(tracker.getHealth()).toBe('unverified');
  });

  it('false -> true after a real event returns to "live", not "unverified"', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();
    clock.t += A11Y_MISS_GRACE_MS + 1;
    tracker.onPollObservedSwitch();
    expect(tracker.getHealth()).toBe('degraded');

    tracker.setEnabled(false);
    tracker.setEnabled(true);
    expect(tracker.getHealth()).toBe('live');
  });

  it('true -> true (no transition) does NOT clear a standing miss', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    clock.t += A11Y_MISS_GRACE_MS + 1;
    tracker.onPollObservedSwitch();
    expect(tracker.getHealth()).toBe('degraded');

    tracker.setEnabled(true);
    expect(tracker.getHealth()).toBe('degraded');
  });

  it('a window event received while disabled still counts once enabled', () => {
    const {tracker} = makeTracker();
    tracker.onWindowEvent();
    tracker.setEnabled(true);
    expect(tracker.getHealth()).toBe('live');
  });
});

describe('a11yHealth — reset()', () => {
  it('clears a standing miss and sawRealEvent but preserves enabled', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();
    clock.t += A11Y_MISS_GRACE_MS + 1;
    tracker.onPollObservedSwitch();
    expect(tracker.getHealth()).toBe('degraded');

    tracker.reset();
    expect(tracker.getHealth()).toBe('unverified'); // enabled kept, evidence cleared
  });
});

describe('a11yHealth — onPollTick freeze guard', () => {
  it('a large tick gap re-seeds liveness so the next poll switch is not a miss', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();

    // JS thread frozen (screen off) for four minutes, then the poll resumes.
    clock.t += 240_000;
    tracker.onPollTick();

    expect(tracker.onPollObservedSwitch()).toBe(false);
    expect(tracker.getHealth()).toBe('live');
  });

  it('normal tick gaps do not re-seed — a genuine miss is still caught', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();

    // Poll ticking normally every second; a11y feed silent throughout.
    for (let i = 0; i < 8; i += 1) {
      clock.t += 1_000;
      tracker.onPollTick();
    }
    expect(clock.t).toBeGreaterThan(A11Y_MISS_GRACE_MS);
    expect(tracker.onPollObservedSwitch()).toBe(true);
    expect(tracker.getHealth()).toBe('degraded');
  });

  it('a standing degraded survives a large-gap onPollTick()', () => {
    const {clock, tracker} = makeTracker();
    tracker.setEnabled(true);
    tracker.onWindowEvent();
    clock.t += A11Y_MISS_GRACE_MS + 1;
    tracker.onPollObservedSwitch();
    expect(tracker.getHealth()).toBe('degraded');

    clock.t += POLL_FREEZE_GAP_MS + 100_000;
    tracker.onPollTick();
    expect(tracker.getHealth()).toBe('degraded');
  });
});
