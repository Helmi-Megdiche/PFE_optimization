import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

export const OVERLAY_MISSION_EVENTS = {
  MISSION_ACTION: 'onOverlayMissionAction',
  PENDING_NOTIFICATION: 'onPendingNotificationMission',
} as const;

export type OverlayMissionActionEvent = {
  missionId: string;
  action: 'start' | 'complete' | 'abandon';
  missionType: string;
  metadataJson: string;
};

interface OverlayMissionNativeModule {
  flushPendingOverlayEvents(): Promise<boolean>;
  showOverlay(
    missionId: string,
    title: string,
    description: string,
    points: number,
    missionType: string,
    metadataJson: string,
    browserAdult: boolean,
  ): Promise<boolean>;
  hideOverlay(): Promise<boolean>;
  isOverlayShowing(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

function getModule(): OverlayMissionNativeModule | null {
  if (Platform.OS !== 'android') {
    return null;
  }
  return (
    (NativeModules.OverlayMission as OverlayMissionNativeModule | undefined) ??
    null
  );
}

export function isOverlayMissionAvailable(): boolean {
  return getModule() != null;
}

export async function flushPendingOverlayEvents(): Promise<void> {
  const mod = getModule();
  if (!mod) {
    return;
  }
  try {
    await mod.flushPendingOverlayEvents();
  } catch {
    // ignore
  }
}

export async function showMissionOverlay(params: {
  missionId: string;
  title: string;
  description: string;
  points: number;
  missionType: string;
  metadata: Record<string, unknown>;
  /** Phase B (B6): show the adult-site warning line. Set from the R4 condition, not from an add. */
  browserAdult?: boolean;
}): Promise<boolean> {
  const mod = getModule();
  if (!mod) {
    return false;
  }
  await mod.showOverlay(
    params.missionId,
    params.title,
    params.description,
    params.points,
    params.missionType,
    JSON.stringify(params.metadata ?? {}),
    params.browserAdult === true,
  );
  return true;
}

export async function hideMissionOverlay(): Promise<void> {
  const mod = getModule();
  if (!mod) {
    return;
  }
  try {
    await mod.hideOverlay();
  } catch {
    // overlay may already be gone
  }
}

/**
 * ALL_IS_FIXED #58: on-demand liveness check for the mission-capture-session backstop — "is the
 * overlay window still attached, right now." Deliberately not a subscription/heartbeat; the
 * backstop asks this only when its soft staleness threshold trips.
 */
export async function isOverlayShowing(): Promise<boolean> {
  const mod = getModule();
  if (!mod) {
    return false;
  }
  try {
    return await mod.isOverlayShowing();
  } catch {
    return false;
  }
}

let emitter: NativeEventEmitter | null = null;

export function getOverlayMissionEmitter(): NativeEventEmitter | null {
  const mod = getModule();
  if (!mod) {
    return null;
  }
  if (!emitter) {
    emitter = new NativeEventEmitter(mod);
  }
  return emitter;
}
