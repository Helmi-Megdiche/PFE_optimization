/**
 * Phase B Task 11: pure decision logic for device <-> backend blocked-domain sync. No React, no
 * AsyncStorage, no native imports — the orchestrator (`services/blockedDomainsSync.ts`) is the
 * only caller and owns all the I/O.
 */

export interface QueuedDetection {
  domain: string;
  detectedAt: string;
}

/**
 * Queues a detection for POST. Dedupes by domain (a domain already queued is replaced, not
 * duplicated) — the newest `detectedAt` for a domain is the one worth sending; an older queued
 * timestamp for the same domain carries no extra information once a newer one exists.
 */
export function enqueueDetection(
  queue: QueuedDetection[],
  domain: string,
  detectedAt: string,
): QueuedDetection[] {
  return [...queue.filter(q => q.domain !== domain), {domain, detectedAt}];
}

/** Removes the entries whose POST just succeeded; entries for the same domain that arrived
 * (and were re-queued, dedup'd in) after the flush read the queue are deliberately NOT dropped —
 * `succeeded` names the exact `{domain, detectedAt}` pairs that were actually sent. */
export function dequeueFlushed(
  queue: QueuedDetection[],
  succeeded: QueuedDetection[],
): QueuedDetection[] {
  const sent = new Set(succeeded.map(s => `${s.domain}\u0000${s.detectedAt}`));
  return queue.filter(q => !sent.has(`${q.domain}\u0000${q.detectedAt}`));
}

export interface SyncPlanInput {
  /** Has the one-time upload-what's-already-on-device backfill run before? */
  backfillDone: boolean;
  /** The device's current dynamic (detected) domain list, native-side. */
  deviceDynamicDomains: string[];
  /** The backend's current active list for this child, or null if the GET failed/was skipped
   * (offline, no childId yet) — null means "don't touch native", never "the list is empty". */
  serverDomains: string[] | null;
}

export interface SyncPlan {
  /** Domains to enqueue for POST because they're on-device but were never uploaded. Empty once
   * `backfillDone` is true — this only ever runs once. */
  backfillDomains: string[];
  /** The list to hand to native's full-replace sync, or null to skip (server read failed). */
  applyToNative: string[] | null;
}

/**
 * A10/plan Task 11: reconciliation is a straight pass-through of the server's list into native's
 * full-replace `syncBlockedDomains` (already proven correct at the JVM level — additions AND
 * parent removals both take effect in one `DomainLists.replaceDynamic` call, tested against
 * never-block and invalid rows there). The work this function actually owns is deciding WHETHER
 * to touch native at all (never on a failed/skipped GET) and what the one-time backfill batch is.
 */
export function planBlockedDomainsSync(input: SyncPlanInput): SyncPlan {
  const backfillDomains = input.backfillDone
    ? []
    : [...new Set(input.deviceDynamicDomains)];
  return {
    backfillDomains,
    applyToNative: input.serverDomains === null ? null : input.serverDomains,
  };
}
