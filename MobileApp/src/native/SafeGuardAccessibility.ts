import { NativeModules, Platform } from 'react-native';

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

interface SafeGuardAccessibilityNativeModule {
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
    (NativeModules.SafeGuardAccessibility as SafeGuardAccessibilityNativeModule | undefined) ??
    null
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
