import {
  mapNsfwProbabilityToCategory,
  mapNsfwProbabilityToRiskScore,
  probabilitiesFromNsfwScore,
} from '../src/services/nsfwClassifier';

describe('nsfwClassifier', () => {
  it('maps high nsfw probability to adult', () => {
    expect(mapNsfwProbabilityToCategory(0.85)).toBe('adult');
    expect(mapNsfwProbabilityToRiskScore(0.85)).toBe(85);
  });

  it('maps mid nsfw probability to suggestive', () => {
    expect(mapNsfwProbabilityToCategory(0.45)).toBe('suggestive');
    expect(mapNsfwProbabilityToRiskScore(0.45)).toBe(45);
  });

  it('maps low nsfw probability to neutral', () => {
    expect(mapNsfwProbabilityToCategory(0.1)).toBe('neutral');
    expect(mapNsfwProbabilityToRiskScore(0.1)).toBe(10);
  });

  it('builds probability vector from nsfw score', () => {
    const p = probabilitiesFromNsfwScore(0.8);
    expect(p.porn).toBe(0.8);
    expect(p.neutral).toBeCloseTo(0.2);
  });
});

// C2 (#9 Option A): `initModel()` on the native module resolves a boolean; before
// this fix, `initNsfwModel()` (src/native/NsfwTflite.ts) discarded it, so a
// `false` ("not actually loaded") result was treated as success — `modelReady`
// latched `true` and every future `classifyImage()` call skipped re-init
// forever, silently running inference against an unloaded model.
//
// `modelReady` / `initPromise` (src/services/nsfwClassifier.ts) are
// un-resettable module-level singletons, and `NsfwTflite.ts` captures its
// native module reference at import time — so each case below installs its
// own native mock BEFORE a fresh `require()` of nsfwClassifier, via
// `jest.resetModules()`. Mirrors the house native-module mock pattern in
// `__tests__/foregroundApp.test.ts` (mutate the RN preset's shared
// `NativeModules` / `Platform` objects rather than `jest.mock('react-native')`,
// which would pull in real native-module dependencies not set up here).
describe('nsfwClassifier — initModel() failure propagation (C2)', () => {
  function loadFreshClassifier(initModelImpl: () => Promise<boolean>) {
    jest.resetModules();
    const RN = require('react-native');
    Object.defineProperty(RN.Platform, 'OS', {get: () => 'android'});
    const mockInitModel = jest.fn(initModelImpl);
    const mockClassifyImage = jest.fn(() =>
      Promise.resolve({sfwScore: 1, nsfwScore: 0, elapsedMs: 5}),
    );
    (RN.NativeModules as Record<string, unknown>).NsfwTflite = {
      initModel: mockInitModel,
      isModelLoaded: jest.fn(() => Promise.resolve(false)),
      classifyImage: mockClassifyImage,
    };

    const mod = require('../src/services/nsfwClassifier');
    return {
      classifyImage: mod.classifyImage as (
        imageUri: string,
        filePath?: string,
      ) => Promise<
        import('../src/services/nsfwClassifier').NsfwInferenceResult
      >,
      mockInitModel,
      mockClassifyImage,
    };
  }

  afterEach(() => {
    jest.resetModules();
  });

  it('returns an unavailable result when the native initModel() resolves false', async () => {
    const {classifyImage} = loadFreshClassifier(() => Promise.resolve(false));

    const result = await classifyImage('file:///a.jpg');

    expect(result.source).toBe('unavailable');
    expect(result.riskScore).toBe(0);
    expect(result.category).toBe('neutral');
  });

  it('self-heals: a false initModel() never latches modelReady, so the next classifyImage() re-attempts init', async () => {
    const {classifyImage, mockInitModel} = loadFreshClassifier(() =>
      Promise.resolve(false),
    );

    await classifyImage('file:///a.jpg');
    expect(mockInitModel).toHaveBeenCalledTimes(1);

    await classifyImage('file:///a.jpg');
    expect(mockInitModel).toHaveBeenCalledTimes(2);
  });

  it('control: a true initModel() latches modelReady, so a second classifyImage() does NOT re-init', async () => {
    const {classifyImage, mockInitModel, mockClassifyImage} =
      loadFreshClassifier(() => Promise.resolve(true));

    const first = await classifyImage('file:///a.jpg');
    expect(first.source).toBe('tflite');
    expect(mockInitModel).toHaveBeenCalledTimes(1);

    await classifyImage('file:///a.jpg');
    expect(mockInitModel).toHaveBeenCalledTimes(1);
    expect(mockClassifyImage).toHaveBeenCalledTimes(2);
  });
});
