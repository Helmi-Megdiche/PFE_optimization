import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export interface ScreenCapturedEvent {
  filePath: string;
  /** content:// or file:// URI for ML Kit OCR */
  imageUri?: string;
  appPackage: string;
  timestamp: number;
}

export interface ScreenCaptureErrorEvent {
  message: string;
}

/**
 * One-way signal that native dropped a capture attempt before it produced a frame.
 * `reason` is a `NativeRejectionReason` string literal (`'interval_floor'` | `'busy'`).
 * `elapsedMs` is present only for `'interval_floor'` (ms since the last emitted frame);
 * it is omitted for `'busy'` — no ambiguous sentinel.
 */
export interface ScreenCaptureRejectedEvent {
  reason: string;
  elapsedMs?: number;
  timestamp: number;
}

/**
 * Periodic heartbeat from the native capture loop. The native side no longer
 * captures on its own timer — JS subsamples this tick to the effective adaptive
 * interval and routes survivors through the capture coordinator.
 */
export interface ScreenCaptureTickEvent {
  timestamp: number;
}

/**
 * One-way signal that monitoring stopped involuntarily: the system (or the user via
 * the cast UI) revoked the MediaProjection while a capture loop was live. Native has
 * already torn the session down; JS turns monitoring off and prompts a re-enable.
 */
export interface MonitoringRevokedEvent {
  reason: string;
  timestamp: number;
}

export interface ScreenCaptureNativeModule {
  getPermissionRequestCode(): Promise<number>;
  requestPermission(): Promise<boolean>;
  isPermissionGranted(): Promise<boolean>;
  startCapture(intervalMs: number): Promise<boolean>;
  captureNow(): Promise<boolean>;
  /** Force the next acquired native frame to bypass the perceptual-hash frame-skip gate. */
  forceNextCapture(): Promise<void>;
  stopCapture(): Promise<boolean>;
  pauseCapture(): Promise<boolean>;
  resumeCapture(): Promise<boolean>;
  deleteFile(filePath: string): Promise<boolean>;
  getDebugState(): Promise<ScreenCaptureDebugState>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const LINKING_ERROR =
  'ScreenCapture native module is not linked. See MobileApp/android/NATIVE_SETUP.md';

export function getScreenCaptureModule(): ScreenCaptureNativeModule {
  if (Platform.OS !== 'android') {
    throw new Error('Screen capture is Android-only');
  }
  const mod = NativeModules.ScreenCapture as ScreenCaptureNativeModule | undefined;
  if (!mod) {
    throw new Error(LINKING_ERROR);
  }
  return mod;
}

export const SCREEN_CAPTURE_EVENTS = {
  captured: 'onScreenCaptured',
  error: 'onScreenCaptureError',
  log: 'onScreenCaptureLog',
  rejected: 'onScreenCaptureRejected',
  tick: 'onNativePeriodicTick',
  monitoringRevoked: 'onMonitoringRevoked',
} as const;

export interface ScreenCaptureDebugState {
  hasMediaProjection: boolean;
  isProjectionReady: boolean;
  isRunning: boolean;
  isPaused: boolean;
  hasVirtualDisplay: boolean;
  hasForegroundService: boolean;
  hasPermissionPromise: boolean;
  intervalMs: number;
}

const noopSubscription = { remove: () => undefined };

/** Safe on iOS (no-op emitter). */
export const screenCaptureEmitter =
  Platform.OS === 'android' && NativeModules.ScreenCapture
    ? new NativeEventEmitter(NativeModules.ScreenCapture)
    : ({
        addListener: () => noopSubscription,
      } as unknown as NativeEventEmitter);

export default getScreenCaptureModule;
