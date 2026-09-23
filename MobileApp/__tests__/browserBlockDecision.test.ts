import {
  addDetectedDomainForFrame,
  leaveBlockedPageForFrame,
  resolveCaptureTimestampMs,
  shouldAddDetectedDomain,
  shouldLeaveBlockedPage,
  shouldShowBlockScreen,
  shouldShowBrowserWarning,
} from '../src/utils/browserBlockDecision';

const chromeAdult = {
  finalCategory: 'adult',
  adultScore: 0.9,
  appPackage: 'com.android.chrome',
};

describe('shouldAddDetectedDomain (R4)', () => {
  it('adds a confident adult vision frame in Chrome', () => {
    expect(shouldAddDetectedDomain(chromeAdult)).toBe(true);
  });
  it('accepts exactly the 0.7 threshold and the near-cut real sample (0.728)', () => {
    expect(shouldAddDetectedDomain({...chromeAdult, adultScore: 0.7})).toBe(true);
    expect(shouldAddDetectedDomain({...chromeAdult, adultScore: 0.728})).toBe(true);
  });
  it('rejects OCR-only adult (raw adultScore 0.033 / 0.007)', () => {
    expect(shouldAddDetectedDomain({...chromeAdult, adultScore: 0.033})).toBe(false);
    expect(shouldAddDetectedDomain({...chromeAdult, adultScore: 0.007})).toBe(false);
  });
  it('rejects just below the threshold', () => {
    expect(shouldAddDetectedDomain({...chromeAdult, adultScore: 0.699})).toBe(false);
  });
  it('rejects a non-adult category even with a high adultScore (violent news case)', () => {
    expect(shouldAddDetectedDomain({...chromeAdult, finalCategory: 'violent'})).toBe(false);
    expect(shouldAddDetectedDomain({...chromeAdult, finalCategory: 'neutral'})).toBe(false);
  });
  it('rejects any package other than Chrome', () => {
    expect(
      shouldAddDetectedDomain({...chromeAdult, appPackage: 'com.instagram.android'}),
    ).toBe(false);
    expect(shouldAddDetectedDomain({...chromeAdult, appPackage: 'com.chrome.beta'})).toBe(
      false,
    );
    expect(shouldAddDetectedDomain({...chromeAdult, appPackage: null})).toBe(false);
  });
  it('lets an unknown package through (foreground lookup failed) - native attribution decides', () => {
    expect(shouldAddDetectedDomain({...chromeAdult, appPackage: 'unknown'})).toBe(true);
  });
  it('rejects a missing adultScore', () => {
    expect(shouldAddDetectedDomain({...chromeAdult, adultScore: undefined})).toBe(false);
    expect(shouldAddDetectedDomain({...chromeAdult, adultScore: null})).toBe(false);
  });
});

describe('shouldLeaveBlockedPage (F2)', () => {
  it('sends the child back on a vision-confirmed adult frame too (superset of shouldAddDetectedDomain)', () => {
    expect(
      shouldLeaveBlockedPage({finalCategory: 'adult', appPackage: 'com.android.chrome'}),
    ).toBe(true);
  });
  it('sends the child back on an OCR-only adult frame (no adultScore involved at all)', () => {
    expect(
      shouldLeaveBlockedPage({finalCategory: 'adult', appPackage: 'com.android.chrome'}),
    ).toBe(true);
  });
  it('never triggers for violent or any other non-adult category', () => {
    expect(
      shouldLeaveBlockedPage({finalCategory: 'violent', appPackage: 'com.android.chrome'}),
    ).toBe(false);
    expect(
      shouldLeaveBlockedPage({finalCategory: 'neutral', appPackage: 'com.android.chrome'}),
    ).toBe(false);
    expect(
      shouldLeaveBlockedPage({finalCategory: 'suggestive', appPackage: 'com.android.chrome'}),
    ).toBe(false);
  });
  it('rejects any package other than Chrome', () => {
    expect(
      shouldLeaveBlockedPage({finalCategory: 'adult', appPackage: 'com.instagram.android'}),
    ).toBe(false);
    expect(shouldLeaveBlockedPage({finalCategory: 'adult', appPackage: null})).toBe(false);
  });
  it('lets an unknown package through, same as the add path', () => {
    expect(shouldLeaveBlockedPage({finalCategory: 'adult', appPackage: 'unknown'})).toBe(true);
  });
});

describe('leaveBlockedPageForFrame', () => {
  const base = {
    finalCategory: 'adult',
    appPackage: 'com.android.chrome',
    event: {timestamp: 1789411321800, filePath: '/x/screen_1.jpg'},
  };
  const ok = {left: true, reason: 'left', host: 'x.com'};

  it('does not call native for a non-adult category', async () => {
    const leave = jest.fn();
    const out = await leaveBlockedPageForFrame(
      {...base, finalCategory: 'violent'},
      {leaveBlockedPage: leave},
    );
    expect(out).toEqual({qualifies: false});
    expect(leave).not.toHaveBeenCalled();
  });
  it('passes the capture time to native and returns the result', async () => {
    const leave = jest.fn().mockResolvedValue(ok);
    const out = await leaveBlockedPageForFrame(base, {leaveBlockedPage: leave});
    expect(leave).toHaveBeenCalledWith(1789411321800);
    expect(out).toEqual({qualifies: true, result: ok});
  });
  it('skips with no_capture_ts and never calls native', async () => {
    const leave = jest.fn();
    const out = await leaveBlockedPageForFrame(
      {...base, event: {filePath: '/x/frame.jpg'}},
      {leaveBlockedPage: leave},
    );
    expect(out).toEqual({qualifies: true, skipped: 'no_capture_ts', result: null});
    expect(leave).not.toHaveBeenCalled();
  });
  it('gives up after 500 ms so the POST is never held up', async () => {
    jest.useFakeTimers();
    try {
      const leave = jest.fn().mockReturnValue(new Promise(() => {}));
      const p = leaveBlockedPageForFrame(base, {leaveBlockedPage: leave});
      await jest.advanceTimersByTimeAsync(500);
      expect(await p).toEqual({qualifies: true, skipped: 'timeout', result: null});
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('F2 sequencing: exactly one of addDetectedDomain / leaveBlockedPage per frame', () => {
  it('OCR-only adult (adultScore under 0.7): leaveBlockedPage runs, addDetectedDomain does not qualify', async () => {
    const ocrOnly = {finalCategory: 'adult', adultScore: 0.06, appPackage: 'com.android.chrome'};
    const event = {timestamp: 1789411321800, filePath: '/x/screen_1.jpg'};
    const add = jest.fn();
    const leave = jest.fn().mockResolvedValue({left: true, reason: 'left', host: 'x.com'});

    const addOutcome = await addDetectedDomainForFrame({...ocrOnly, event}, {addDetectedDomain: add});
    expect(addOutcome).toEqual({qualifies: false});
    expect(add).not.toHaveBeenCalled();

    // The caller only calls leave when add did not qualify (useScreenshotCapture.ts's branch).
    const leaveOutcome = await leaveBlockedPageForFrame({...ocrOnly, event}, {leaveBlockedPage: leave});
    expect(leaveOutcome.qualifies).toBe(true);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('a vision-confirmed adult frame (adultScore >= 0.7): addDetectedDomain qualifies, so leave is never asked to run', async () => {
    const confirmed = {finalCategory: 'adult', adultScore: 0.9, appPackage: 'com.android.chrome'};
    const event = {timestamp: 1789411321800, filePath: '/x/screen_1.jpg'};
    const add = jest.fn().mockResolvedValue({added: true, listed: true, reason: 'added', host: 'x.com'});

    const addOutcome = await addDetectedDomainForFrame({...confirmed, event}, {addDetectedDomain: add});
    expect(addOutcome.qualifies).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    // addOutcome.qualifies === true is exactly the condition useScreenshotCapture.ts uses to SKIP
    // calling leaveBlockedPageForFrame at all — shouldAddDetectedDomain's conditions are a strict
    // subset of shouldLeaveBlockedPage's, so this is the only guard needed to avoid two sequences.
  });

  it('violent category: neither addDetectedDomain nor leaveBlockedPage qualify', async () => {
    const violent = {finalCategory: 'violent', adultScore: 0.9, appPackage: 'com.android.chrome'};
    const event = {timestamp: 1789411321800, filePath: '/x/screen_1.jpg'};
    const add = jest.fn();
    const leave = jest.fn();

    const addOutcome = await addDetectedDomainForFrame({...violent, event}, {addDetectedDomain: add});
    const leaveOutcome = await leaveBlockedPageForFrame({...violent, event}, {leaveBlockedPage: leave});
    expect(addOutcome).toEqual({qualifies: false});
    expect(leaveOutcome).toEqual({qualifies: false});
    expect(add).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });
});

describe('resolveCaptureTimestampMs (B3)', () => {
  it('prefers the native event timestamp', () => {
    expect(
      resolveCaptureTimestampMs({
        timestamp: 1789411321800,
        filePath: '/x/screen_1789411321757.jpg',
      }),
    ).toBe(1789411321800);
  });
  it('falls back to the epoch in screen_<ms>.jpg', () => {
    expect(resolveCaptureTimestampMs({filePath: '/data/cache/screen_1789411321757.jpg'})).toBe(
      1789411321757,
    );
    expect(
      resolveCaptureTimestampMs({timestamp: 0, filePath: 'file:///c/screen_1789411321757.jpg'}),
    ).toBe(1789411321757);
  });
  it('is null (never "now") when neither yields a number', () => {
    expect(resolveCaptureTimestampMs({filePath: '/x/frame.jpg'})).toBeNull();
    expect(resolveCaptureTimestampMs({filePath: '/x/screen_abc.jpg'})).toBeNull();
    expect(resolveCaptureTimestampMs({timestamp: NaN, filePath: null})).toBeNull();
    expect(resolveCaptureTimestampMs({})).toBeNull();
  });
});

describe('addDetectedDomainForFrame', () => {
  const ok = {added: true, listed: true, reason: 'added', host: 'x.com'};
  const base = {
    ...chromeAdult,
    event: {timestamp: 1789411321800, filePath: '/x/screen_1.jpg'},
  };

  it('does not call native when R4 fails', async () => {
    const add = jest.fn();
    const out = await addDetectedDomainForFrame(
      {...base, adultScore: 0.1},
      {addDetectedDomain: add},
    );
    expect(out).toEqual({qualifies: false});
    expect(add).not.toHaveBeenCalled();
  });
  it('passes the capture time to native and returns the result', async () => {
    const add = jest.fn().mockResolvedValue(ok);
    const out = await addDetectedDomainForFrame(base, {addDetectedDomain: add});
    expect(add).toHaveBeenCalledWith(1789411321800);
    expect(out).toEqual({qualifies: true, result: ok});
  });
  it('skips with no_capture_ts and never calls native', async () => {
    const add = jest.fn();
    const out = await addDetectedDomainForFrame(
      {...base, event: {filePath: '/x/frame.jpg'}},
      {addDetectedDomain: add},
    );
    expect(out).toEqual({qualifies: true, skipped: 'no_capture_ts', result: null});
    expect(add).not.toHaveBeenCalled();
  });
  it('gives up after 500 ms so the POST is never held up (A7)', async () => {
    jest.useFakeTimers();
    try {
      const add = jest.fn().mockReturnValue(new Promise(() => {}));
      const p = addDetectedDomainForFrame(base, {addDetectedDomain: add});
      await jest.advanceTimersByTimeAsync(500);
      expect(await p).toEqual({qualifies: true, skipped: 'timeout', result: null});
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('shouldShowBlockScreen (A1/B9)', () => {
  it('shows when listed and no mission was presented', () => {
    expect(shouldShowBlockScreen({listed: true, presentedMission: false})).toBe(true);
  });
  it('does not show when a mission was presented', () => {
    expect(shouldShowBlockScreen({listed: true, presentedMission: true})).toBe(false);
  });
  it('does not show when the domain is not listed', () => {
    expect(shouldShowBlockScreen({listed: false, presentedMission: false})).toBe(false);
  });
});

describe('shouldShowBrowserWarning (B6)', () => {
  it('shows for a known Chrome frame even when nothing was listed (duplicate/refused)', () => {
    expect(
      shouldShowBrowserWarning({qualifies: true, appPackage: 'com.android.chrome', listed: false}),
    ).toBe(true);
  });
  it('for an unknown package needs native to have listed a host', () => {
    expect(shouldShowBrowserWarning({qualifies: true, appPackage: 'unknown', listed: false})).toBe(false);
    expect(shouldShowBrowserWarning({qualifies: true, appPackage: 'unknown', listed: true})).toBe(true);
  });
  it('never shows when R4 did not hold', () => {
    expect(shouldShowBrowserWarning({qualifies: false, appPackage: 'com.android.chrome', listed: true})).toBe(false);
  });
});
