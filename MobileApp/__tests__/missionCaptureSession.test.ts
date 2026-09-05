import {
  MISSION_SESSION_MAX_MS,
  createMissionCaptureSessionTracker,
} from '../src/utils/missionCaptureSession';

function makeTracker() {
  const clock = {t: 0};
  const tracker = createMissionCaptureSessionTracker({now: () => clock.t});
  return {clock, tracker};
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
