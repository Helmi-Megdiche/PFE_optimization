import {NativeModules, Platform} from 'react-native';

// The react-native jest preset already provides a safe mock for the whole 'react-native'
// module (re-mocking it via jest.requireActual pulls in real native-module dependencies
// that aren't set up in this test environment) — mutate its NativeModules/Platform
// directly instead of replacing the module.
Object.defineProperty(Platform, 'OS', {get: () => 'android'});
(NativeModules as Record<string, unknown>).ForegroundApp = {
  getCurrentForegroundApp: jest.fn(),
  hasUsageAccess: jest.fn(),
  hasUsageStatsPermission: jest.fn(),
  openUsageAccessSettings: jest.fn(),
};

import {
  resolveForegroundApp,
  resolveForegroundAppWithRetry,
  resetForegroundLookup,
} from '../src/native/ForegroundApp';

const mockNative = (NativeModules as any).ForegroundApp
  .getCurrentForegroundApp as jest.Mock;

// Mirrors ForegroundApp.ts's private FOREGROUND_NATIVE_TIMEOUT_MS — not exported, so
// pinned here. If that constant ever changes, this must change with it.
const FOREGROUND_NATIVE_TIMEOUT_MS = 2_500;

function unknownResult(): Promise<null> {
  return Promise.resolve(null);
}

function knownResult(
  pkg: string,
): Promise<{packageName: string; appLabel: string; source: string}> {
  return Promise.resolve({
    packageName: pkg,
    appLabel: pkg,
    source: 'usage_stats',
  });
}

describe('resolveForegroundAppWithRetry', () => {
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    resetForegroundLookup();
    jest.useFakeTimers();
    setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    mockNative.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function callsWithDelay(delay: number): number {
    return setTimeoutSpy.mock.calls.filter(call => call[1] === delay).length;
  }

  test('backgrounded + native returns unknown: exactly one native call, never sleeps 200ms', async () => {
    mockNative.mockImplementation(unknownResult);

    const promise = resolveForegroundAppWithRetry(3, 200, true);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.packageName).toBe('unknown');
    expect(mockNative).toHaveBeenCalledTimes(1);
    expect(callsWithDelay(200)).toBe(0);
    expect(callsWithDelay(FOREGROUND_NATIVE_TIMEOUT_MS)).toBe(1);
  });

  test('backgrounded + first attempt already succeeds: exactly one native call, never sleeps 200ms', async () => {
    mockNative.mockImplementation(() => knownResult('com.example.app'));

    const promise = resolveForegroundAppWithRetry(3, 200, true);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.packageName).toBe('com.example.app');
    expect(mockNative).toHaveBeenCalledTimes(1);
    expect(callsWithDelay(200)).toBe(0);
    expect(callsWithDelay(FOREGROUND_NATIVE_TIMEOUT_MS)).toBe(1);
  });

  test('foregrounded + native returns unknown every time: 3 native calls, sleeps 200ms twice', async () => {
    mockNative.mockImplementation(unknownResult);

    const promise = resolveForegroundAppWithRetry(3, 200, false);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.packageName).toBe('unknown');
    expect(mockNative).toHaveBeenCalledTimes(3);
    expect(callsWithDelay(200)).toBe(2);
    expect(callsWithDelay(FOREGROUND_NATIVE_TIMEOUT_MS)).toBe(3);
  });

  test('foregrounded + attempt 2 succeeds: 2 native calls, sleeps 200ms once', async () => {
    mockNative
      .mockImplementationOnce(unknownResult)
      .mockImplementationOnce(() => knownResult('com.example.two'));

    const promise = resolveForegroundAppWithRetry(3, 200, false);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.packageName).toBe('com.example.two');
    expect(mockNative).toHaveBeenCalledTimes(2);
    expect(callsWithDelay(200)).toBe(1);
    expect(callsWithDelay(FOREGROUND_NATIVE_TIMEOUT_MS)).toBe(2);
  });

  test('a late-settling stale lookup does not clobber a fresher one (generation guard)', async () => {
    const start = Date.now();
    let resolveFirstNative: (value: unknown) => void = () => {};
    mockNative.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirstNative = resolve;
        }),
    );

    const first = resolveForegroundApp();

    // Advance wall-clock time (Date.now()) past the native timeout WITHOUT firing the
    // pending withTimeout fallback timer — this is the backgrounded scenario: RN
    // freezes JS timers, but wall-clock time still moves. isForegroundLookupStuck()
    // reads Date.now(), so it flips true even though nothing has fired yet.
    jest.setSystemTime(start + FOREGROUND_NATIVE_TIMEOUT_MS + 500);

    mockNative.mockImplementationOnce(() => knownResult('com.example.fresh'));
    const second = resolveForegroundApp();

    // The stale first call's native promise finally settles late, after the second
    // (fresher) lookup has already started.
    resolveFirstNative({
      packageName: 'com.example.stale',
      appLabel: 'stale',
      source: 'usage_stats',
    });
    await jest.runAllTimersAsync();

    const secondResult = await second;
    expect(secondResult.packageName).toBe('com.example.fresh');

    // A subsequent call still gets its own fresh native lookup — proof the stale
    // first call's .finally() did not clear state out from under the second call.
    mockNative.mockImplementationOnce(() => knownResult('com.example.third'));
    const thirdResult = await resolveForegroundApp();
    expect(thirdResult.packageName).toBe('com.example.third');
    expect(mockNative).toHaveBeenCalledTimes(3);

    await first;
  });
});
