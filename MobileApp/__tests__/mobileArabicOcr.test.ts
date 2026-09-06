import {Platform} from 'react-native';

import {OCR_LOCK_LIVENESS_MS} from '../src/utils/adaptiveCapture';
import {
  RECOGNITION_STALE_MS,
  extractArabicTextOnDevice,
  isRecognitionStale,
  resetActiveArabicRecognition,
} from '../src/services/mobileArabicOcr';
import {scWarn} from '../src/utils/screenCaptureLogger';

jest.mock('@devinikhiya/react-native-tesseractocr', () => ({
  __esModule: true,
  default: {recognize: jest.fn()},
}));
jest.mock('../src/utils/screenCaptureLogger', () => ({
  scLog: jest.fn(),
  scWarn: jest.fn(),
  scError: jest.fn(),
}));

const TesseractOcr = require('@devinikhiya/react-native-tesseractocr').default;
const recognize = TesseractOcr.recognize as jest.Mock;
const scWarnMock = scWarn as jest.Mock;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return {promise, resolve};
}

const flush = () => new Promise(r => setImmediate(r));

describe('isRecognitionStale', () => {
  it('is false when no recognition has started', () => {
    expect(isRecognitionStale(null, 1_000, 500)).toBe(false);
  });

  it('is false while the recognition is younger than the threshold', () => {
    expect(isRecognitionStale(1_000, 1_400, 500)).toBe(false);
  });

  it('is true exactly at the threshold', () => {
    expect(isRecognitionStale(1_000, 1_500, 500)).toBe(true);
  });

  it('is true past the threshold', () => {
    expect(isRecognitionStale(1_000, 9_999, 500)).toBe(true);
  });
});

describe('RECOGNITION_STALE_MS invariant', () => {
  it('stays below the OCR-lock tick-liveness ceiling (or wedge recovery never triggers)', () => {
    expect(RECOGNITION_STALE_MS).toBeLessThan(OCR_LOCK_LIVENESS_MS);
  });
});

describe('extractArabicTextOnDevice — wedged-recognition degrade', () => {
  const openDeferreds: Array<Deferred<string>> = [];
  let nowSpy: jest.SpyInstance<number, []>;

  const newDeferred = () => {
    const d = deferred<string>();
    openDeferreds.push(d);
    return d;
  };

  beforeAll(() => {
    (Platform as unknown as {OS: string}).OS = 'android';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  beforeEach(() => {
    resetActiveArabicRecognition();
    recognize.mockReset();
    scWarnMock.mockClear();
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(async () => {
    // Let any promise left pending settle so the withTimeout timer is cleared.
    openDeferreds.forEach(d => d.resolve('cleanup'));
    openDeferreds.length = 0;
    await flush();
    nowSpy.mockRestore();
  });

  it('disables Arabic OCR for the session instead of starting a second native run', async () => {
    const d1 = newDeferred();
    recognize.mockReturnValueOnce(d1.promise);

    const pending = extractArabicTextOnDevice('img-1'); // never settles while backgrounded
    expect(pending).toBeInstanceOf(Promise);
    await flush();
    expect(recognize).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + RECOGNITION_STALE_MS);
    const second = await extractArabicTextOnDevice('img-2');

    expect(second).toBeNull();
    expect(recognize).toHaveBeenCalledTimes(1); // no second native run against the shared field
    expect(scWarnMock).toHaveBeenCalledTimes(1);
    expect(scWarnMock.mock.calls[0][0]).toContain('did not settle');

    const third = await extractArabicTextOnDevice('img-3');
    expect(third).toBeNull();
    expect(recognize).toHaveBeenCalledTimes(1); // disabled flag still latched
  });

  it('re-enables on reset, and a late-settling abandoned promise cannot clobber the new run', async () => {
    const dA = newDeferred();
    recognize.mockReturnValueOnce(dA.promise);
    const pA = extractArabicTextOnDevice('A');
    expect(pA).toBeInstanceOf(Promise);
    await flush();

    nowSpy.mockReturnValue(1_000_000 + RECOGNITION_STALE_MS);
    expect(await extractArabicTextOnDevice('A-2')).toBeNull(); // disabled
    expect(recognize).toHaveBeenCalledTimes(1);

    resetActiveArabicRecognition(); // monitoring toggle

    const dB = newDeferred();
    recognize.mockReturnValueOnce(dB.promise);
    const pB = extractArabicTextOnDevice('B');
    await flush();
    expect(recognize).toHaveBeenCalledTimes(2); // fresh run started

    // The ancient abandoned recognition settles now — its finally must NOT clear the live slot.
    dA.resolve('stale-text');
    await flush();

    const pB2 = extractArabicTextOnDevice('B-2'); // should ride the same in-flight run
    await flush();
    expect(recognize).toHaveBeenCalledTimes(2); // not 3 — slot still owned by run B

    dB.resolve('fresh-text');
    expect(await pB).toEqual({
      text: 'fresh-text',
      confidence: expect.any(Number),
    });
    expect(await pB2).toEqual(await pB);
  });

  it('still coalesces concurrent callers onto one native run (single-flight not regressed)', async () => {
    const d = newDeferred();
    recognize.mockReturnValueOnce(d.promise);

    const p1 = extractArabicTextOnDevice('same');
    await flush();
    nowSpy.mockReturnValue(1_000_000 + 1_000); // still fresh, not stale
    const p2 = extractArabicTextOnDevice('same');

    expect(recognize).toHaveBeenCalledTimes(1);

    d.resolve('shared-text');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({text: 'shared-text', confidence: expect.any(Number)});
    expect(r2).toEqual(r1);
  });

  it('a native rejection settles the slot cleanly — no disable, re-armed for the next frame', async () => {
    // After #4b the native module rejects (E_TESSERACT) on any worker-thread
    // failure instead of orphaning the promise. That rejection must NOT trip the
    // #4 degrade path — it is a clean settlement.
    recognize.mockRejectedValueOnce(
      new Error('E_TESSERACT TessBaseAPI.init failed'),
    );

    const first = await extractArabicTextOnDevice('reject-1');
    expect(first).toBeNull();
    expect(recognize).toHaveBeenCalledTimes(1);
    const disableCalls = scWarnMock.mock.calls.filter(c =>
      String(c[0]).includes('did not settle'),
    );
    expect(disableCalls).toHaveLength(0);

    // Slot was cleared under the generation guard: the next frame starts a fresh
    // native run and succeeds — no monitoring toggle needed.
    recognize.mockResolvedValueOnce('نص عربي للاختبار');
    const second = await extractArabicTextOnDevice('reject-2');
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(second).toEqual({
      text: 'نص عربي للاختبار',
      confidence: expect.any(Number),
    });
  });
});
