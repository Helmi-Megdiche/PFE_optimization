/**
 * Pure filter for the accessibility service's `onAccessibilityWindowChanged` stream.
 *
 * The raw window-event feed is noisy: it fires for the app's own window, for the
 * soft-keyboard (IME) window, and it flaps between the launcher and the Google
 * search surface on the launcher's `-1` screen (2–4 events within a second or two).
 * Feeding every event straight into `triggerAppSwitchCapture` would fire a burst of
 * near-identical captures. This module collapses that feed to the genuine app
 * switches worth a capture.
 *
 * Pure and injectable — no React, no react-native, no native modules — so it is
 * unit-testable with a fake clock. Reuses `isLauncherPackage` / `APP_OWN_PACKAGE`
 * from the existing utils rather than duplicating those lists.
 */
import {APP_OWN_PACKAGE} from '../utils/appSwitchCapture';
import {isLauncherPackage} from '../utils/appCapturePolicy';

/** Window changes within this window of the last accepted one are treated as launcher settling. */
export const LAUNCHER_SETTLE_MS = 1_500;

/**
 * Known input-method (soft keyboard) packages. Exact matches we have actually
 * observed on device, seeded with the Gboard package that fires ~14 ms *before*
 * the `keyboard changed {visible:true}` event.
 */
const IME_PACKAGES = new Set<string>(['com.google.android.inputmethod.latin']);

/** Substrings that reliably mark an IME package across OEMs. */
const IME_SUBSTRINGS = ['inputmethod', 'latin', 'swiftkey', 'gboard', '.ime'];

/**
 * Heuristic: does this package look like a soft-keyboard / IME?
 *
 * This is a best-effort string match — the authoritative "keyboard is up" signal
 * is the `onAccessibilityKeyboardChanged` event, not this function. It exists only
 * so a window event for the IME window does not get mistaken for an app switch in
 * the ~14 ms before the keyboard event lands.
 */
export function isImePackage(pkg: string): boolean {
  if (!pkg) {
    return false;
  }
  if (IME_PACKAGES.has(pkg)) {
    return true;
  }
  const lower = pkg.toLowerCase();
  return IME_SUBSTRINGS.some(fragment => lower.includes(fragment));
}

/**
 * The launcher's `-1` panel hosts the Google search app; treat it as a launcher
 * surface for settle purposes so the `home ↔ googlequicksearchbox` flap collapses.
 * Added here (not in `appCapturePolicy`) because it is only a launcher *surface*,
 * not a home-screen replacement.
 */
const LAUNCHER_SURFACE_EXTRA = 'com.google.android.googlequicksearchbox';

function isLauncherSurfacePackage(pkg: string | null): boolean {
  return !!pkg && (isLauncherPackage(pkg) || pkg === LAUNCHER_SURFACE_EXTRA);
}

export type WindowEventDecision =
  | {accept: true}
  | {
      accept: false;
      reason: 'OWN_PACKAGE' | 'IME' | 'SAME_PACKAGE' | 'LAUNCHER_SETTLING';
    };

export interface WindowEventFilterDeps {
  now: () => number;
}

export function createWindowEventFilter(deps: WindowEventFilterDeps) {
  let lastAcceptedPackage: string | null = null;
  let lastAcceptedAtMs = Number.NEGATIVE_INFINITY;

  /**
   * Decide whether a window-changed event for `packageName` is a genuine app
   * switch. Rules run in order: own package → IME → same as last accepted →
   * launcher settling → accept (and record).
   */
  function accept(packageName: string): WindowEventDecision {
    if (packageName === APP_OWN_PACKAGE) {
      return {accept: false, reason: 'OWN_PACKAGE'};
    }
    if (isImePackage(packageName)) {
      return {accept: false, reason: 'IME'};
    }
    if (packageName === lastAcceptedPackage) {
      return {accept: false, reason: 'SAME_PACKAGE'};
    }
    if (
      (isLauncherSurfacePackage(packageName) ||
        isLauncherSurfacePackage(lastAcceptedPackage)) &&
      deps.now() - lastAcceptedAtMs < LAUNCHER_SETTLE_MS
    ) {
      return {accept: false, reason: 'LAUNCHER_SETTLING'};
    }
    lastAcceptedPackage = packageName;
    lastAcceptedAtMs = deps.now();
    return {accept: true};
  }

  /** The last package `accept` returned `{accept:true}` for (launchers included). */
  function getLastAcceptedPackage(): string | null {
    return lastAcceptedPackage;
  }

  /**
   * Clear all state. Must be called on every monitoring start/stop — otherwise the
   * first window event of a new session can be wrongly rejected `SAME_PACKAGE` and
   * the first app-switch capture is lost.
   */
  function reset(): void {
    lastAcceptedPackage = null;
    lastAcceptedAtMs = Number.NEGATIVE_INFINITY;
  }

  return {accept, getLastAcceptedPackage, reset};
}

export type WindowEventFilter = ReturnType<typeof createWindowEventFilter>;
