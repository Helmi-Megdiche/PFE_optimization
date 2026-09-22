import AsyncStorage from '@react-native-async-storage/async-storage';
import {tokenStorage} from '../auth/tokenStorage';
import {
  getBlockedDomains,
  postBlockedDomain,
  postBrowserIncident,
} from './blockedDomainsApi';
import {
  getDynamicDomains as nativeGetDynamicDomains,
  syncBlockedDomains as nativeSyncBlockedDomains,
} from '../native/SafeGuardAccessibility';
import {
  dequeueFlushed,
  enqueueDetection,
  planBlockedDomainsSync,
  type QueuedDetection,
} from '../utils/blockedDomainsSyncPlan';
import {scLog, scWarn} from '../utils/screenCaptureLogger';

/**
 * Phase B Task 11. Orchestration only — every decision (what to backfill, what to hand to
 * native) lives in the pure `utils/blockedDomainsSyncPlan.ts`, covered by its own Jest suite with
 * no AsyncStorage/network/native involved.
 */

const QUEUE_KEY = '@pfe/phaseB/blockedDomains/queue';
const BACKFILL_DONE_KEY = '@pfe/phaseB/blockedDomains/backfillDone';

async function readQueue(): Promise<QueuedDetection[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedDetection[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedDetection[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch (err) {
    scWarn('blockedDomains queue write failed', err);
  }
}

async function readBackfillDone(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(BACKFILL_DONE_KEY)) === '1';
  } catch {
    return false;
  }
}

async function writeBackfillDone(): Promise<void> {
  try {
    await AsyncStorage.setItem(BACKFILL_DONE_KEY, '1');
  } catch (err) {
    scWarn('blockedDomains backfill-done write failed', err);
  }
}

/**
 * Attempts to POST every queued detection; entries whose POST fails (offline, 5xx) stay queued
 * for the next attempt. Safe to call with an empty queue.
 */
export async function flushBlockedDomainsQueue(): Promise<void> {
  const queue = await readQueue();
  if (queue.length === 0) {
    return;
  }
  const succeeded: QueuedDetection[] = [];
  for (const item of queue) {
    try {
      await postBlockedDomain(item.domain, item.detectedAt);
      succeeded.push(item);
    } catch (err) {
      scWarn('blockedDomains queue flush failed', {domain: item.domain, err});
    }
  }
  if (succeeded.length > 0) {
    await writeQueue(dequeueFlushed(await readQueue(), succeeded));
  }
}

/**
 * Queues a just-detected domain for POST (real-time, called right after a successful native
 * `addDetectedDomain`), then makes one immediate best-effort attempt to flush the whole queue.
 */
export async function queueBlockedDomainDetection(
  domain: string,
  detectedAtMs: number,
): Promise<void> {
  const detectedAt = new Date(detectedAtMs).toISOString();
  await writeQueue(enqueueDetection(await readQueue(), domain, detectedAt));
  await flushBlockedDomainsQueue();
}

/**
 * Best-effort incident POST on `onBrowserBlocked`. Not queued on failure — a missed incident row
 * is a lesser loss than the complexity of a second offline queue, and the domain itself (which
 * IS queued, via `queueBlockedDomainDetection`) remains the durable signal that reaches the
 * dashboard either way.
 */
export async function reportBrowserIncident(
  host: string,
  listSource: 'static' | 'detected',
  timestampMs: number,
): Promise<void> {
  try {
    await postBrowserIncident(
      host,
      listSource,
      new Date(timestampMs).toISOString(),
    );
  } catch (err) {
    scWarn('browser incident POST failed', {host, err});
  }
}

/**
 * Full device<->backend sync: flush the offline queue, run the one-time backfill (uploads
 * whatever's already on the device the first time this ever succeeds — so the dashboard isn't
 * empty for domains detected before Task 11 shipped), THEN read the server's current active list
 * and reconcile it into native (additions and parent removals both take effect via
 * `DomainLists.replaceDynamic`, already JVM-tested). The GET runs after the backfill flush on
 * purpose — reading it first would let a same-round reconcile wipe domains the device just
 * uploaded but the server snapshot doesn't reflect yet. Safe to call repeatedly (e.g. every
 * monitoring start); every step is idempotent.
 */
export async function runBlockedDomainsSync(): Promise<void> {
  const childId = await tokenStorage.getChildId();
  if (!childId) {
    return;
  }

  await flushBlockedDomainsQueue();

  const backfillDone = await readBackfillDone();
  if (!backfillDone) {
    const deviceDomains = await nativeGetDynamicDomains();
    const prePlan = planBlockedDomainsSync({
      backfillDone: false,
      deviceDynamicDomains: deviceDomains,
      serverDomains: null,
    });
    if (prePlan.backfillDomains.length > 0) {
      const now = new Date().toISOString();
      let queue = await readQueue();
      for (const domain of prePlan.backfillDomains) {
        queue = enqueueDetection(queue, domain, now);
      }
      await writeQueue(queue);
    }
    await writeBackfillDone();
    await flushBlockedDomainsQueue();
  }

  let serverDomains: string[] | null = null;
  try {
    const {domains} = await getBlockedDomains(childId);
    serverDomains = domains.map(d => d.domain);
  } catch (err) {
    scWarn('blocked-domains GET failed — skipping this sync round', err);
  }

  const plan = planBlockedDomainsSync({
    backfillDone: true,
    deviceDynamicDomains: [],
    serverDomains,
  });
  if (plan.applyToNative != null) {
    await nativeSyncBlockedDomains(plan.applyToNative);
    scLog('blockedDomains sync applied', {count: plan.applyToNative.length});
  }
}
