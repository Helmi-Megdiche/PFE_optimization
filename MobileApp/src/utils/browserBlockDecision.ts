import {withTimeout} from './withTimeout';
import type {AddDetectedDomainResult} from '../native/SafeGuardAccessibility';

/**
 * Phase B: pure decisions for "did this capture show an adult site in Chrome, and what do we do".
 * No React, no native imports at runtime (the type import is erased).
 */

export const CHROME_PACKAGE = 'com.android.chrome';

/** The existing raw vision threshold (`nsfwClassifier.ADULT_THRESHOLD`). Not a new number. */
export const ADULT_SCORE_THRESHOLD = 0.7;

/** A7: the native attribution call is a local, immediate read; never let it hold up the POST. */
export const ADD_DETECTED_TIMEOUT_MS = 500;

/**
 * R4. `finalCategory` alone is not enough: OCR keywords can raise it to 'adult' with no image
 * evidence (raw vision adultScore 0.007 / 0.033 in the recon), and `imageRiskScore` is boosted by
 * OCR. The RAW vision `adultScore` is the only pre-boost image signal. Known limits: real adult
 * frames scored 0.728-0.953, so 0.728 is close to the cut; drawn/animated content (hanime.tv,
 * 0.007-0.067) is a vision blind spot covered by the static list only.
 */
export function shouldAddDetectedDomain(input: {
  finalCategory: string;
  adultScore: number | null | undefined;
  appPackage: string | null | undefined;
}): boolean {
  return (
    input.finalCategory === 'adult' &&
    typeof input.adultScore === 'number' &&
    input.adultScore >= ADULT_SCORE_THRESHOLD &&
    input.appPackage === CHROME_PACKAGE
  );
}

/**
 * B3: the capture time, never "now" and never the post-vision payload timestamp. Order: the native
 * `onScreenCaptured` timestamp, else the epoch embedded in `screen_<ms>.jpg`. Neither -> null (the
 * caller skips the add and logs `no_capture_ts`).
 */
export function resolveCaptureTimestampMs(event: {
  timestamp?: number | null;
  filePath?: string | null;
}): number | null {
  if (
    typeof event.timestamp === 'number' &&
    Number.isFinite(event.timestamp) &&
    event.timestamp > 0
  ) {
    return event.timestamp;
  }
  const m = /screen_(\d{10,})\.jpg$/i.exec(event.filePath ?? '');
  if (m) {
    const ms = Number(m[1]);
    if (Number.isFinite(ms) && ms > 0) {
      return ms;
    }
  }
  return null;
}

export type BrowserAddOutcome =
  | {qualifies: false}
  | {qualifies: true; skipped: 'no_capture_ts' | 'timeout'; result: null}
  | {qualifies: true; skipped?: undefined; result: AddDetectedDomainResult};

/**
 * Runs the R4 check and, if it holds, asks native to attribute + blacklist. Called BEFORE the
 * screen-event POST. Returns `qualifies` so the caller can also drive the mission warning line.
 */
export async function addDetectedDomainForFrame(
  input: {
    finalCategory: string;
    adultScore: number | null | undefined;
    appPackage: string | null | undefined;
    event: {timestamp?: number | null; filePath?: string | null};
  },
  deps: {
    addDetectedDomain: (captureTimestampMs: number) => Promise<AddDetectedDomainResult>;
  },
): Promise<BrowserAddOutcome> {
  if (!shouldAddDetectedDomain(input)) {
    return {qualifies: false};
  }
  const ts = resolveCaptureTimestampMs(input.event);
  if (ts == null) {
    return {qualifies: true, skipped: 'no_capture_ts', result: null};
  }
  const result = await withTimeout<AddDetectedDomainResult | null>(
    deps.addDetectedDomain(ts),
    ADD_DETECTED_TIMEOUT_MS,
    null,
  );
  if (result == null) {
    return {qualifies: true, skipped: 'timeout', result: null};
  }
  return {qualifies: true, result};
}

/**
 * A1/B9: the block screen comes from JS only when the domain is listed and NO mission was
 * presented (the mission overlay already interrupts the child, and a mission wins over the block
 * screen). `presentedMission` is true only inside the `presentMissionFromCapture` branch.
 */
export function shouldShowBlockScreen(input: {
  listed: boolean;
  presentedMission: boolean;
}): boolean {
  return input.listed && !input.presentedMission;
}
