import {
  addDetectedDomainForFrame,
  resolveCaptureTimestampMs,
  shouldAddDetectedDomain,
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
