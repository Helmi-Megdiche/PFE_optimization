import {NativeModules, Platform} from 'react-native';

/**
 * Bridge to `com.mobileapp.accessibility.SafeGuardAccessibilityModule`.
 *
 * The native `SafeGuardAccessibilityService` is a parallel event source: it emits
 * window/package, software-keyboard, and (throttled) scroll signals over the RN
 * DeviceEventEmitter. It reads package names and booleans only — never node text,
 * `AccessibilityNodeInfo` content, URLs, or field values. Nothing consumes these
 * events yet. The service must be enabled manually in system Accessibility settings.
 */

export const ACCESSIBILITY_EVENTS = {
  windowChanged: 'onAccessibilityWindowChanged',
  keyboardChanged: 'onAccessibilityKeyboardChanged',
  scroll: 'onAccessibilityScroll',
  /** Phase B: an adult site was blocked. Host only. */
  browserBlocked: 'onBrowserBlocked',
} as const;

export interface AccessibilityWindowChangedEvent {
  packageName: string;
  /** wall-clock ms (System.currentTimeMillis on the native side) */
  timestamp: number;
}

export interface AccessibilityKeyboardChangedEvent {
  visible: boolean;
  timestamp: number;
}

export interface AccessibilityScrollEvent {
  packageName: string;
  timestamp: number;
}

/** Phase B: the host is the ONLY thing that ever leaves the address bar — never a path or query. */
export interface BrowserBlockedEvent {
  host: string;
  listSource: 'static' | 'detected';
  timestamp: number;
}

/** Outcome of asking native to attribute + blacklist the frame captured at a given time. */
export interface AddDetectedDomainResult {
  added: boolean;
  /** True when the host is on a list after the call (added OR already there). */
  listed: boolean;
  reason: string;
  host?: string;
}

/** Outcome of asking native to send Chrome back one page for an OCR-only adult detection (F2). */
export interface LeaveBlockedPageResult {
  left: boolean;
  reason: string;
  host?: string;
}

interface SafeGuardAccessibilityNativeModule {
  addDetectedDomain(
    captureTimestampMs: number,
  ): Promise<AddDetectedDomainResult>;
  leaveBlockedPage(captureTimestampMs: number): Promise<LeaveBlockedPageResult>;
  devAddDetectedDomainNow(): Promise<AddDetectedDomainResult>;
  showBrowserBlockScreen(): Promise<boolean>;
  getDynamicDomains(): Promise<string[]>;
  syncBlockedDomains(domains: string[]): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  openAccessibilitySettings(): Promise<boolean>;
  flushPendingEvents(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export function getSafeGuardAccessibilityModule(): SafeGuardAccessibilityNativeModule | null {
  if (Platform.OS !== 'android') {
    return null;
  }
  return (
    (NativeModules.SafeGuardAccessibility as
      | SafeGuardAccessibilityNativeModule
      | undefined) ?? null
  );
}

export function isSafeGuardAccessibilityAvailable(): boolean {
  return getSafeGuardAccessibilityModule() != null;
}

/** True only when the service is connected AND listed in ENABLED_ACCESSIBILITY_SERVICES. */
export async function isAccessibilityServiceEnabled(): Promise<boolean> {
  const mod = getSafeGuardAccessibilityModule();
  if (!mod) {
    return false;
  }
  try {
    return await mod.isEnabled();
  } catch {
    return false;
  }
}

export async function openAccessibilitySettings(): Promise<void> {
  const mod = getSafeGuardAccessibilityModule();
  if (!mod) {
    return;
  }
  try {
    await mod.openAccessibilitySettings();
  } catch {
    // ignore — settings screen unavailable
  }
}

/** Ask native to drain any events buffered while the JS context was dead. */
export async function flushPendingAccessibilityEvents(): Promise<void> {
  const mod = getSafeGuardAccessibilityModule();
  if (!mod) {
    return;
  }
  try {
    await mod.flushPendingEvents();
  } catch {
    // ignore
  }
}

/**
 * Phase B. Native resolves the Chrome host at `captureTimestampMs` from its own history and adds
 * its registrable domain to the blacklist. Never rejects: any failure is reported as a refusal.
 */
export async function addDetectedDomain(
  captureTimestampMs: number,
): Promise<AddDetectedDomainResult> {
  const mod = getSafeGuardAccessibilityModule();
  if (!mod) {
    return {added: false, listed: false, reason: 'module_unavailable'};
  }
  try {
    return await mod.addDetectedDomain(captureTimestampMs);
  } catch {
    return {added: false, listed: false, reason: 'native_error'};
  }
}

/**
 * DEBUG BUILDS ONLY (Q2 device arm, review round 4). Calls native `addDetectedDomain` with the
 * capture timestamp genuinely `now`, so attribution runs against the real history ring without a
 * staged screenshot/vision pipeline run. Gated exactly like the static-list switch: the native
 * side refuses outside a debug build (`BuildConfig.DEBUG`), and this wrapper is a no-op outside
 * `__DEV__` too, so it is inert on both sides regardless of which check a caller might skip.
 */
export async function devAddDetectedDomainNow(): Promise<AddDetectedDomainResult> {
  if (!__DEV__) {
    return {added: false, listed: false, reason: 'not_dev_build'};
  }
  const mod = getSafeGuardAccessibilityModule();
  if (!mod) {
    return {added: false, listed: false, reason: 'module_unavailable'};
  }
  try {
    return await mod.devAddDetectedDomainNow();
  } catch {
    return {added: false, listed: false, reason: 'native_error'};
  }
}

/**
 * F2. An OCR-only adult detection in Chrome: native resolves the Chrome host at
 * `captureTimestampMs` the same way `addDetectedDomain` does, and runs the Back-only sequence.
 * Never lists anything, never files an incident. Never rejects: any failure is a refusal.
 */
export async function leaveBlockedPage(
  captureTimestampMs: number,
): Promise<LeaveBlockedPageResult> {
  const mod = getSafeGuardAccessibilityModule();
  if (!mod) {
    return {left: false, reason: 'module_unavailable'};
  }
  try {
    return await mod.leaveBlockedPage(captureTimestampMs);
  } catch {
    return {left: false, reason: 'native_error'};
  }
}

/** Phase B. Shows the block screen unless a mission overlay is up. Resolves whether it was shown. */
export async function showBrowserBlockScreen(): Promise<boolean> {
  const mod = getSafeGuardAccessibilityModule();
  if (!mod) {
    return false;
  }
  try {
    return await mod.showBrowserBlockScreen();
  } catch {
    return false;
  }
}

/** Task 11 (device sync). The dynamic list as it stands right now, for the one-time backfill. */
export async function getDynamicDomains(): Promise<string[]> {
  const mod = getSafeGuardAccessibilityModule();
  if (!mod) {
    return [];
  }
  try {
    return await mod.getDynamicDomains();
  } catch {
    return [];
  }
}

/**
 * Task 11 (device sync). Replaces the dynamic list with the server's current active set —
 * additions and parent removals (via the dev unblock endpoint) both take effect. Never throws.
 */
export async function syncBlockedDomains(domains: string[]): Promise<boolean> {
  const mod = getSafeGuardAccessibilityModule();
  if (!mod) {
    return false;
  }
  try {
    return await mod.syncBlockedDomains(domains);
  } catch {
    return false;
  }
}
