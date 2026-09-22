import {
  dequeueFlushed,
  enqueueDetection,
  planBlockedDomainsSync,
  type QueuedDetection,
} from '../src/utils/blockedDomainsSyncPlan';

describe('enqueueDetection', () => {
  it('appends a new domain', () => {
    const q = enqueueDetection([], 'pornhub.com', '2026-09-22T10:00:00.000Z');
    expect(q).toEqual([
      {domain: 'pornhub.com', detectedAt: '2026-09-22T10:00:00.000Z'},
    ]);
  });

  it('dedupes by domain, keeping the newest detectedAt', () => {
    const first = enqueueDetection(
      [],
      'pornhub.com',
      '2026-09-22T09:00:00.000Z',
    );
    const second = enqueueDetection(
      first,
      'pornhub.com',
      '2026-09-22T11:00:00.000Z',
    );
    expect(second).toEqual([
      {domain: 'pornhub.com', detectedAt: '2026-09-22T11:00:00.000Z'},
    ]);
  });

  it('keeps other domains untouched when replacing one', () => {
    const q = enqueueDetection(
      [{domain: 'xhamster.com', detectedAt: '2026-09-22T08:00:00.000Z'}],
      'pornhub.com',
      '2026-09-22T09:00:00.000Z',
    );
    expect(q).toHaveLength(2);
    expect(q).toContainEqual({
      domain: 'xhamster.com',
      detectedAt: '2026-09-22T08:00:00.000Z',
    });
  });
});

describe('dequeueFlushed', () => {
  const queue: QueuedDetection[] = [
    {domain: 'a.com', detectedAt: '2026-09-22T09:00:00.000Z'},
    {domain: 'b.com', detectedAt: '2026-09-22T10:00:00.000Z'},
  ];

  it('removes exactly the succeeded entries', () => {
    const next = dequeueFlushed(queue, [
      {domain: 'a.com', detectedAt: '2026-09-22T09:00:00.000Z'},
    ]);
    expect(next).toEqual([
      {domain: 'b.com', detectedAt: '2026-09-22T10:00:00.000Z'},
    ]);
  });

  it('leaves the queue untouched when nothing succeeded', () => {
    expect(dequeueFlushed(queue, [])).toEqual(queue);
  });

  it('does not remove a re-queued entry with a different detectedAt than the one that succeeded', () => {
    // The queue was re-read after the flush and now has a newer detection for a.com — the
    // succeeded {a.com, old-ts} POST must not silently drop the newer pending one.
    const requeued: QueuedDetection[] = [
      {domain: 'a.com', detectedAt: '2026-09-22T12:00:00.000Z'},
      {domain: 'b.com', detectedAt: '2026-09-22T10:00:00.000Z'},
    ];
    const next = dequeueFlushed(requeued, [
      {domain: 'a.com', detectedAt: '2026-09-22T09:00:00.000Z'},
    ]);
    expect(next).toEqual(requeued);
  });
});

describe('planBlockedDomainsSync', () => {
  it('backfills every device domain once, before backfillDone', () => {
    const plan = planBlockedDomainsSync({
      backfillDone: false,
      deviceDynamicDomains: ['pornhub.com', 'xhamster.com', 'pornhub.com'],
      serverDomains: null,
    });
    expect(plan.backfillDomains.sort()).toEqual([
      'pornhub.com',
      'xhamster.com',
    ]);
  });

  it('never backfills again once backfillDone is true', () => {
    const plan = planBlockedDomainsSync({
      backfillDone: true,
      deviceDynamicDomains: ['pornhub.com'],
      serverDomains: null,
    });
    expect(plan.backfillDomains).toEqual([]);
  });

  it('applyToNative is null when the server read failed/was skipped', () => {
    const plan = planBlockedDomainsSync({
      backfillDone: true,
      deviceDynamicDomains: [],
      serverDomains: null,
    });
    expect(plan.applyToNative).toBeNull();
  });

  it('applyToNative is an empty array (not null) on a genuinely empty server list', () => {
    const plan = planBlockedDomainsSync({
      backfillDone: true,
      deviceDynamicDomains: [],
      serverDomains: [],
    });
    expect(plan.applyToNative).toEqual([]);
  });

  it('applyToNative passes the server list straight through (reconciliation is native-side)', () => {
    const plan = planBlockedDomainsSync({
      backfillDone: true,
      deviceDynamicDomains: ['stale.com'],
      serverDomains: ['pornhub.com', 'xhamster.com'],
    });
    expect(plan.applyToNative).toEqual(['pornhub.com', 'xhamster.com']);
  });
});
