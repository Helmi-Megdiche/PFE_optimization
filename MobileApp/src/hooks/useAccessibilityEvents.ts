import {useEffect, useState} from 'react';
import {AppState, DeviceEventEmitter, Platform} from 'react-native';
import {
  ACCESSIBILITY_EVENTS,
  flushPendingAccessibilityEvents,
  isAccessibilityServiceEnabled,
  type AccessibilityKeyboardChangedEvent,
  type AccessibilityScrollEvent,
  type AccessibilityWindowChangedEvent,
  type BrowserBlockedEvent,
} from '../native/SafeGuardAccessibility';
import {scLog} from '../utils/screenCaptureLogger';

export interface UseAccessibilityEventsOptions {
  onWindowChanged?: (event: AccessibilityWindowChangedEvent) => void;
  onKeyboardChanged?: (event: AccessibilityKeyboardChangedEvent) => void;
  onScroll?: (event: AccessibilityScrollEvent) => void;
  /** Phase B Task 11: a URL-watcher match ran Back (+ block screen). Host + list source only. */
  onBrowserBlocked?: (event: BrowserBlockedEvent) => void;
}

export interface UseAccessibilityEventsResult {
  /**
   * True only when `SafeGuardAccessibilityService` is connected AND listed in
   * `ENABLED_ACCESSIBILITY_SERVICES`. Refreshed on mount and every time the app
   * returns to the foreground (`AppState` → `active`).
   */
  connected: boolean;
}

/**
 * Subscribes to the three `SafeGuardAccessibilityService` events, logs each one, and
 * forwards it to the optional callbacks. Also asks native to flush buffered events
 * whenever the app returns to the foreground, so signals fired while JS was dead
 * still arrive, and reports whether the service is currently connected.
 *
 * `onAccessibilityScroll` stays log-only — no consumer wires `onScroll` yet.
 */
export function useAccessibilityEvents(
  options: UseAccessibilityEventsOptions = {},
): UseAccessibilityEventsResult {
  const {onWindowChanged, onKeyboardChanged, onScroll, onBrowserBlocked} =
    options;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }
    const refresh = () => {
      void isAccessibilityServiceEnabled().then(setConnected);
    };
    refresh();
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') {
        refresh();
      }
    });
    return () => {
      sub.remove();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    const windowSub = DeviceEventEmitter.addListener(
      ACCESSIBILITY_EVENTS.windowChanged,
      (event: AccessibilityWindowChangedEvent) => {
        scLog('[a11y] window changed', {
          packageName: event.packageName,
          timestamp: event.timestamp,
        });
        onWindowChanged?.(event);
      },
    );

    const keyboardSub = DeviceEventEmitter.addListener(
      ACCESSIBILITY_EVENTS.keyboardChanged,
      (event: AccessibilityKeyboardChangedEvent) => {
        scLog('[a11y] keyboard changed', {
          visible: event.visible,
          timestamp: event.timestamp,
        });
        onKeyboardChanged?.(event);
      },
    );

    const scrollSub = DeviceEventEmitter.addListener(
      ACCESSIBILITY_EVENTS.scroll,
      (event: AccessibilityScrollEvent) => {
        scLog('[a11y] scroll', {
          packageName: event.packageName,
          timestamp: event.timestamp,
        });
        onScroll?.(event);
      },
    );

    const browserBlockedSub = DeviceEventEmitter.addListener(
      ACCESSIBILITY_EVENTS.browserBlocked,
      (event: BrowserBlockedEvent) => {
        scLog('[a11y] browser blocked', {
          host: event.host,
          listSource: event.listSource,
        });
        onBrowserBlocked?.(event);
      },
    );

    const appStateSub = AppState.addEventListener('change', next => {
      if (next === 'active') {
        void flushPendingAccessibilityEvents();
      }
    });

    scLog('[a11y] event hook mounted');

    return () => {
      windowSub.remove();
      keyboardSub.remove();
      scrollSub.remove();
      browserBlockedSub.remove();
      appStateSub.remove();
    };
  }, [onWindowChanged, onKeyboardChanged, onScroll, onBrowserBlocked]);

  return {connected};
}

export default useAccessibilityEvents;
