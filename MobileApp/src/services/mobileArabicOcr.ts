import TesseractOcr from '@devinikhiya/react-native-tesseractocr';
import {Platform} from 'react-native';
import {scWarn} from '../utils/screenCaptureLogger';
import {withTimeout} from '../utils/withTimeout';

export interface MobileArabicOcrResult {
  text: string;
  confidence: number;
}

/** First Tesseract load can be slow; cap so capture cycles do not block indefinitely. */
const RECOGNITION_TIMEOUT_MS = 25_000;

/**
 * Secondary wedged-recognition guard. The PRIMARY recovery clock is the OCR-lock tick-liveness
 * force-release at OCR_LOCK_LIVENESS_MS (60s, adaptiveCapture.ts) — by the time a fresh frame
 * re-enters this module after a backgrounded wedge, activeRecognition is already older than this.
 * MUST stay below OCR_LOCK_LIVENESS_MS or recovery never triggers — pinned by a test. The exact
 * value is NOT load-bearing: nothing evaluates it before that 60s release, so anything
 * comfortably below 60s behaves identically. Do not "tune" this. A legit Arabic pass still
 * running past 60s is a force-release-mid-work problem (D1 debt item 1 / native brief #4b), not a
 * threshold problem.
 */
export const RECOGNITION_STALE_MS = 45_000;

let tesseractInitDone = false;
let initializationPromise: Promise<void> | null = null;
let activeRecognition: Promise<MobileArabicOcrResult | null> | null = null;
let activeRecognitionStartedAt: number | null = null;
let recognitionGeneration = 0;
/**
 * Set when a recognition was seen not to settle. Cleared only by resetActiveArabicRecognition()
 * (monitoring start/stop/revoke). Lifetime = one monitoring session, NOT the app lifetime.
 */
let arabicOcrDisabledForMonitoringSession = false;

/** Pure: has a recognition started at `startedAtMs` been in flight for at least `staleMs`? */
export function isRecognitionStale(
  startedAtMs: number | null,
  nowMs: number,
  staleMs: number,
): boolean {
  return startedAtMs !== null && nowMs - startedAtMs >= staleMs;
}

/**
 * Re-arm Arabic OCR for a new monitoring session (start/stop/revoke). Clears the in-flight guard
 * and re-enables after a wedge-disable. Also re-arms lazy init: initTesseractLazy today is a
 * synchronous flag set in an async IIFE with NO native call, so it cannot park — those two lines
 * are future-proofing for if a real native init is ever added, not a live recovery path.
 */
export function resetActiveArabicRecognition(): void {
  activeRecognition = null;
  activeRecognitionStartedAt = null;
  recognitionGeneration += 1; // orphan any late-settling promise's finally
  arabicOcrDisabledForMonitoringSession = false;
  tesseractInitDone = false;
  initializationPromise = null;
}

function estimateConfidence(text: string): number {
  if (!text) {
    return 0;
  }
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const totalChars = text.replace(/\s+/g, '').length;
  if (totalChars === 0) {
    return 0;
  }
  return Math.min(0.95, arabicChars / totalChars);
}

async function initTesseractLazy(): Promise<void> {
  if (tesseractInitDone) {
    return;
  }
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    // Native module loads on first invocation; keep this non-blocking for UI.
    tesseractInitDone = true;
  })();

  return initializationPromise;
}

async function runRecognition(
  imageUri: string,
): Promise<MobileArabicOcrResult | null> {
  try {
    await initTesseractLazy();
    const startedAt = Date.now();
    if (__DEV__) {
      console.log(
        `[ArabicOCR] starting (ara model, path=${imageUri.slice(-48)})`,
      );
    }

    const rawText: string = await withTimeout(
      TesseractOcr.recognize(imageUri, 'ara', {}),
      RECOGNITION_TIMEOUT_MS,
      '',
    );

    if (!rawText) {
      if (__DEV__) {
        console.warn(`[ArabicOCR] timed out after ${Date.now() - startedAt}ms`);
      }
      return null;
    }

    const text = rawText.trim();
    const confidence = estimateConfidence(text);
    if (__DEV__) {
      console.log(
        `[ArabicOCR] done in ${Date.now() - startedAt}ms, chars=${
          text.length
        }, conf=${confidence.toFixed(2)}`,
      );
    }
    return {text, confidence};
  } catch (error) {
    if (__DEV__) {
      console.warn('[ArabicOCR] recognition failed', error);
    }
    return null;
  }
}

/**
 * Android-only on-device Arabic OCR.
 * - Lazy init on first Arabic request
 * - Single in-flight recognition to avoid native concurrency pressure
 */
export async function extractArabicTextOnDevice(
  imageUri: string,
): Promise<MobileArabicOcrResult | null> {
  if (Platform.OS !== 'android') {
    return null;
  }
  if (arabicOcrDisabledForMonitoringSession) {
    return null; // wedged earlier this session — ML Kit path only until the next monitoring toggle
  }

  // A recognition still bound here when a NEW frame enters means the previous one never settled
  // (RN froze withTimeout's timer while backgrounded; the owning frame was force-released by the
  // OCR-lock tick-liveness backstop at OCR_LOCK_LIVENESS_MS). We must NOT start a second native
  // run: `tesseract` is a shared instance field in TesseractocrModule and the wedged worker
  // thread may still be executing against it. Degrade — disable until the next monitoring session.
  if (
    activeRecognition &&
    isRecognitionStale(
      activeRecognitionStartedAt,
      Date.now(),
      RECOGNITION_STALE_MS,
    )
  ) {
    // Say only what is known — the code cannot distinguish a wedge from a slow-but-alive pass.
    scWarn(
      `[ArabicOCR] recognition did not settle within ${
        Date.now() - (activeRecognitionStartedAt ?? 0)
      }ms — disabling Arabic OCR for this monitoring session; ML Kit path continues`,
    );
    activeRecognition = null;
    activeRecognitionStartedAt = null;
    recognitionGeneration += 1;
    arabicOcrDisabledForMonitoringSession = true;
    return null;
  }

  if (activeRecognition) {
    return activeRecognition;
  }

  const myGeneration = (recognitionGeneration += 1);
  const startedAt = Date.now();
  activeRecognition = runRecognition(imageUri);
  activeRecognitionStartedAt = startedAt;
  try {
    return await activeRecognition;
  } finally {
    // Only clear if this invocation still owns the slot. After resetActiveArabicRecognition()
    // re-enables, run B starts fresh; the ancient parked promise A can still settle later and its
    // finally would otherwise null activeRecognition out from under B — the next call would then
    // see an empty slot and start C, two live native runs on the shared `tesseract` field.
    if (recognitionGeneration === myGeneration) {
      activeRecognition = null;
      activeRecognitionStartedAt = null;
    }
  }
}
