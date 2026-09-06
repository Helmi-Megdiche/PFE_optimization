import { createScreenEventSchema } from '../src/validators/screenEvents.validator';
import { logger } from '../src/utils/logger';

const OPTS = { abortEarly: false as const, stripUnknown: true as const };

const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

afterAll(() => {
  warnSpy.mockRestore();
});
beforeEach(() => {
  warnSpy.mockClear();
});

/** A realistic payload shaped like MobileApp useScreenshotCapture.ts:952-966. */
function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-05-17T18:30:00.000Z',
    appPackage: 'com.instagram.android',
    appLabel: 'Instagram',
    extractedTextPreview: 'Sample OCR text from screen',
    riskFlag: true,
    riskScore: 72,
    imageRiskScore: 81,
    combinedRiskScore: 78,
    category: 'violent',
    imageClassificationDetails: {
      source: 'mlkit',
      violenceScore: 0.62,
      adultScore: 0.1,
      goreScore: 0.05,
      dangerousChallengeScore: 0.02,
      educationalScore: 0.0,
      imageRiskScore: 81,
      mappedCategory: 'violent',
      topRiskLabels: ['weapon', 'gun'],
      categoryWeights: { violent: 0.7, adult: 0.1 },
      mlKitLabels: Array.from({ length: 15 }, (_, i) => ({
        text: `label${i}`,
        confidence: 0.9 - i * 0.01,
      })),
      nsfwSource: 'tflite',
      nsfwProbabilities: { porn: 0.1, sexy: 0.2, hentai: 0, neutral: 0.6, drawing: 0.1 },
      tfliteOutputs: [0.4, 0.6],
      captureQualityHint: 'ok',
      mockHint: '/data/user/0/com.mobileapp/cache/frame_1234.jpg',
    },
    ...overrides,
  };
}

describe('createScreenEventSchema — imageClassificationDetails', () => {
  it('accepts a realistic full payload; keeps every known detail field except mockHint', () => {
    const { error, value } = createScreenEventSchema.validate(validPayload(), OPTS);
    expect(error).toBeUndefined();
    const d = value.imageClassificationDetails;
    expect(d.source).toBe('mlkit');
    expect(d.mlKitLabels).toHaveLength(15);
    expect(d.categoryWeights).toEqual({ violent: 0.7, adult: 0.1 });
    // MF2: mockHint is validated but stripped — a device filesystem-path tail is never stored.
    expect(d).not.toHaveProperty('mockHint');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts imageClassificationDetails omitted or null without warning', () => {
    for (const v of [undefined, null]) {
      warnSpy.mockClear();
      const { error } = createScreenEventSchema.validate(
        validPayload({ imageClassificationDetails: v }),
        OPTS,
      );
      expect(error).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  it('strips an unknown top-level detail key (does not 400) and warns once', () => {
    const { error, value } = createScreenEventSchema.validate(
      validPayload({
        imageClassificationDetails: { source: 'mlkit', evil: 'x'.repeat(20000) },
      }),
      OPTS,
    );
    expect(error).toBeUndefined();
    expect(value.imageClassificationDetails).not.toHaveProperty('evil');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const meta = warnSpy.mock.calls[0][1] as { strippedCount: number; strippedKeys: string[] };
    expect(meta.strippedCount).toBe(1);
    expect(meta.strippedKeys).toEqual(['evil']);
  });

  it('strips an unknown key inside an mlKitLabels item', () => {
    const { error, value } = createScreenEventSchema.validate(
      validPayload({
        imageClassificationDetails: {
          source: 'mlkit',
          mlKitLabels: [{ text: 'gun', confidence: 0.9, evil: 'leak' }],
        },
      }),
      OPTS,
    );
    expect(error).toBeUndefined();
    expect(value.imageClassificationDetails.mlKitLabels[0]).toEqual({
      text: 'gun',
      confidence: 0.9,
    });
  });

  it('rejects over-count arrays and maps (count caps are reject, with headroom)', () => {
    const over = {
      mlKitLabels: {
        source: 'mlkit',
        mlKitLabels: Array.from({ length: 16 }, () => ({ text: 't', confidence: 0.1 })),
      },
      topRiskLabels: { source: 'mlkit', topRiskLabels: Array.from({ length: 16 }, () => 'x') },
      categoryWeights: {
        source: 'mlkit',
        categoryWeights: Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [`k${i}`, 0.1]),
        ),
      },
    };
    for (const details of Object.values(over)) {
      const { error } = createScreenEventSchema.validate(
        validPayload({ imageClassificationDetails: details }),
        OPTS,
      );
      expect(error).toBeDefined();
    }
  });

  it('truncates over-long detail strings instead of rejecting (13a)', () => {
    const { error, value } = createScreenEventSchema.validate(
      validPayload({
        imageClassificationDetails: {
          source: 'mlkit',
          mappedCategory: 'a'.repeat(5000),
          nsfwSource: 'b'.repeat(500),
          topRiskLabels: ['c'.repeat(300)],
          mlKitLabels: [{ text: 'd'.repeat(200), confidence: 0.5 }],
        },
      }),
      OPTS,
    );
    expect(error).toBeUndefined();
    const d = value.imageClassificationDetails;
    expect(d.mappedCategory).toHaveLength(40);
    expect(d.nsfwSource).toHaveLength(40);
    expect(d.topRiskLabels[0]).toHaveLength(40);
    expect(d.mlKitLabels[0].text).toHaveLength(40);
  });

  it('rejects a non-number categoryWeights value but strips an over-long key', () => {
    const bad = createScreenEventSchema.validate(
      validPayload({
        imageClassificationDetails: { source: 'mlkit', categoryWeights: { violent: { n: 1 } } },
      }),
      OPTS,
    );
    expect(bad.error).toBeDefined();

    const longKey = 'k'.repeat(200);
    const stripped = createScreenEventSchema.validate(
      validPayload({
        imageClassificationDetails: { source: 'mlkit', categoryWeights: { [longKey]: 0.5 } },
      }),
      OPTS,
    );
    expect(stripped.error).toBeUndefined();
    expect(stripped.value.imageClassificationDetails.categoryWeights).toEqual({});
  });

  it('warns only when a top-level unknown key was actually present', () => {
    createScreenEventSchema.validate(validPayload(), OPTS);
    expect(warnSpy).not.toHaveBeenCalled();

    createScreenEventSchema.validate(
      validPayload({
        imageClassificationDetails: { source: 'mlkit', a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
      }),
      OPTS,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const meta = warnSpy.mock.calls[0][1] as { strippedCount: number; strippedKeys: string[] };
    expect(meta.strippedCount).toBe(6);
    expect(meta.strippedKeys).toHaveLength(5); // capped at MAX_LOGGED_STRIPPED_KEYS
  });

  it('sanitises logged key names: no control chars, capped at 40', () => {
    const nastyKey = `evil\x01\x7fpad${'z'.repeat(60)}`;
    createScreenEventSchema.validate(
      validPayload({
        imageClassificationDetails: { source: 'mlkit', [nastyKey]: 'v' },
      }),
      OPTS,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const meta = warnSpy.mock.calls[0][1] as { strippedKeys: string[] };
    const logged = meta.strippedKeys[0];
    expect(logged.length).toBeLessThanOrEqual(40);
    expect(/[\x00-\x1f\x7f]/.test(logged)).toBe(false);
  });

  it('does not warn when the only missing key is a declared .strip()ped one (MF1)', () => {
    const { error, value } = createScreenEventSchema.validate(
      validPayload({
        imageClassificationDetails: {
          source: 'mlkit',
          imageRiskScore: 40,
          mockHint: '/some/device/path/frame.jpg',
        },
      }),
      OPTS,
    );
    expect(error).toBeUndefined();
    expect(value.imageClassificationDetails).not.toHaveProperty('mockHint');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('createScreenEventSchema — extractedTextPreview (primary privacy field, reject-on-overflow)', () => {
  it('accepts exactly 500 chars, empty string, and defaults to empty', () => {
    expect(
      createScreenEventSchema.validate(
        validPayload({ extractedTextPreview: 'a'.repeat(500) }),
        OPTS,
      ).error,
    ).toBeUndefined();
    expect(
      createScreenEventSchema.validate(validPayload({ extractedTextPreview: '' }), OPTS).error,
    ).toBeUndefined();

    const { imageClassificationDetails, ...noPreview } = validPayload();
    delete (noPreview as Record<string, unknown>).extractedTextPreview;
    const { error, value } = createScreenEventSchema.validate(
      { ...noPreview, imageClassificationDetails },
      OPTS,
    );
    expect(error).toBeUndefined();
    expect(value.extractedTextPreview).toBe('');
  });

  it('rejects 501 and 5000 chars — not truncated (deliberate asymmetry vs detail strings)', () => {
    expect(
      createScreenEventSchema.validate(
        validPayload({ extractedTextPreview: 'a'.repeat(501) }),
        OPTS,
      ).error,
    ).toBeDefined();
    expect(
      createScreenEventSchema.validate(
        validPayload({ extractedTextPreview: 'a'.repeat(5000) }),
        OPTS,
      ).error,
    ).toBeDefined();
  });
});

describe('createScreenEventSchema — unknown top-level keys (regression guard)', () => {
  it('strips an unknown top-level request key (e.g. a screenshot) without a 400', () => {
    const { error, value } = createScreenEventSchema.validate(
      validPayload({ screenshotBase64: 'data:image/jpeg;base64,AAAA'.repeat(500) }),
      OPTS,
    );
    expect(error).toBeUndefined();
    expect(value).not.toHaveProperty('screenshotBase64');
  });
});
