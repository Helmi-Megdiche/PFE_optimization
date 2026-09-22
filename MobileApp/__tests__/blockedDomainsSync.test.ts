import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../src/services/blockedDomainsApi', () => ({
  postBlockedDomain: jest.fn(),
  getBlockedDomains: jest.fn(),
  postBrowserIncident: jest.fn(),
}));

jest.mock('../src/native/SafeGuardAccessibility', () => ({
  getDynamicDomains: jest.fn(),
  syncBlockedDomains: jest.fn(),
}));

jest.mock('../src/auth/tokenStorage', () => ({
  tokenStorage: {
    getChildId: jest.fn(),
  },
}));

import {tokenStorage} from '../src/auth/tokenStorage';
import {
  getBlockedDomains,
  postBlockedDomain,
  postBrowserIncident,
} from '../src/services/blockedDomainsApi';
import {
  getDynamicDomains,
  syncBlockedDomains,
} from '../src/native/SafeGuardAccessibility';
import {
  flushBlockedDomainsQueue,
  queueBlockedDomainDetection,
  reportBrowserIncident,
  runBlockedDomainsSync,
} from '../src/services/blockedDomainsSync';

const mockGetChildId = tokenStorage.getChildId as jest.Mock;
const mockPostBlockedDomain = postBlockedDomain as jest.Mock;
const mockGetBlockedDomains = getBlockedDomains as jest.Mock;
const mockPostBrowserIncident = postBrowserIncident as jest.Mock;
const mockGetDynamicDomains = getDynamicDomains as jest.Mock;
const mockSyncBlockedDomains = syncBlockedDomains as jest.Mock;

async function readQueueRaw(): Promise<unknown> {
  const raw = await AsyncStorage.getItem('@pfe/phaseB/blockedDomains/queue');
  return raw ? JSON.parse(raw) : null;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockGetChildId.mockResolvedValue('child-1');
  mockGetDynamicDomains.mockResolvedValue([]);
  mockGetBlockedDomains.mockResolvedValue({domains: []});
  mockSyncBlockedDomains.mockResolvedValue(true);
});

describe('flushBlockedDomainsQueue', () => {
  it('does nothing on an empty queue', async () => {
    await flushBlockedDomainsQueue();
    expect(mockPostBlockedDomain).not.toHaveBeenCalled();
  });
});

describe('queueBlockedDomainDetection', () => {
  it('POSTs immediately and leaves the queue empty on success', async () => {
    mockPostBlockedDomain.mockResolvedValueOnce({
      domain: 'pornhub.com',
      outcome: 'added',
    });
    await queueBlockedDomainDetection('pornhub.com', 1_758_534_000_000);
    expect(mockPostBlockedDomain).toHaveBeenCalledWith(
      'pornhub.com',
      new Date(1_758_534_000_000).toISOString(),
    );
    expect(await readQueueRaw()).toEqual([]);
  });

  it('stays queued when the POST fails, and a later flush drains it', async () => {
    mockPostBlockedDomain.mockRejectedValueOnce(new Error('network down'));
    await queueBlockedDomainDetection('xhamster.com', 1_758_534_000_000);
    expect(await readQueueRaw()).toEqual([
      {
        domain: 'xhamster.com',
        detectedAt: new Date(1_758_534_000_000).toISOString(),
      },
    ]);

    mockPostBlockedDomain.mockResolvedValueOnce({
      domain: 'xhamster.com',
      outcome: 'added',
    });
    await flushBlockedDomainsQueue();
    expect(await readQueueRaw()).toEqual([]);
  });

  it('does not lose an unrelated queued domain when one POST fails and another succeeds', async () => {
    // Keyed on the domain argument (not call order) — flushing re-POSTs the whole queue in
    // array order on every call, so a call-order-based mock would attribute the wrong outcome
    // to the wrong domain once more than one item is queued.
    mockPostBlockedDomain.mockImplementation((domain: string) => {
      if (domain === 'a.com') {
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve({domain, outcome: 'added'});
    });

    await queueBlockedDomainDetection('a.com', 1);
    await queueBlockedDomainDetection('b.com', 2);

    expect(await readQueueRaw()).toEqual([
      {domain: 'a.com', detectedAt: new Date(1).toISOString()},
    ]);
  });
});

describe('reportBrowserIncident', () => {
  it('POSTs with an ISO timestamp', async () => {
    mockPostBrowserIncident.mockResolvedValueOnce({
      id: 'i1',
      domain: 'randomsite.example',
      listSource: 'static',
      occurredAt: '2026-09-22T10:00:00.000Z',
    });
    await reportBrowserIncident(
      'randomsite.example',
      'static',
      1_758_534_000_000,
    );
    expect(mockPostBrowserIncident).toHaveBeenCalledWith(
      'randomsite.example',
      'static',
      new Date(1_758_534_000_000).toISOString(),
    );
  });

  it('swallows a failed POST — never throws', async () => {
    mockPostBrowserIncident.mockRejectedValueOnce(new Error('offline'));
    await expect(
      reportBrowserIncident('randomsite.example', 'detected', 1),
    ).resolves.toBeUndefined();
  });
});

describe('runBlockedDomainsSync', () => {
  it('does nothing when no childId is known yet', async () => {
    mockGetChildId.mockResolvedValueOnce(null);
    await runBlockedDomainsSync();
    expect(mockGetDynamicDomains).not.toHaveBeenCalled();
    expect(mockGetBlockedDomains).not.toHaveBeenCalled();
  });

  it('backfills every on-device domain the first time, then reconciles from the server', async () => {
    mockGetDynamicDomains.mockResolvedValueOnce([
      'pornhub.com',
      'xhamster.com',
    ]);
    mockPostBlockedDomain.mockResolvedValue({domain: 'x', outcome: 'added'});
    mockGetBlockedDomains.mockResolvedValueOnce({
      domains: [
        {id: '1', domain: 'pornhub.com', source: 'detected', detectedAt: 't'},
        {id: '2', domain: 'xhamster.com', source: 'detected', detectedAt: 't'},
      ],
    });

    await runBlockedDomainsSync();

    // both backfilled domains were POSTed
    const posted = mockPostBlockedDomain.mock.calls.map(c => c[0]).sort();
    expect(posted).toEqual(['pornhub.com', 'xhamster.com']);
    // queue drained after the backfill flush
    expect(await readQueueRaw()).toEqual([]);
    // reconciled into native from the (post-backfill) server response
    expect(mockSyncBlockedDomains).toHaveBeenCalledWith([
      'pornhub.com',
      'xhamster.com',
    ]);
    // backfill flag persisted
    expect(
      await AsyncStorage.getItem('@pfe/phaseB/blockedDomains/backfillDone'),
    ).toBe('1');
  });

  it('never backfills a second time', async () => {
    await AsyncStorage.setItem('@pfe/phaseB/blockedDomains/backfillDone', '1');
    mockGetDynamicDomains.mockResolvedValueOnce(['pornhub.com']);

    await runBlockedDomainsSync();

    expect(mockPostBlockedDomain).not.toHaveBeenCalled();
  });

  it('marks backfill done even when the device has nothing to backfill', async () => {
    mockGetDynamicDomains.mockResolvedValueOnce([]);
    await runBlockedDomainsSync();
    expect(
      await AsyncStorage.getItem('@pfe/phaseB/blockedDomains/backfillDone'),
    ).toBe('1');
  });

  it('does not touch native when the server GET fails', async () => {
    await AsyncStorage.setItem('@pfe/phaseB/blockedDomains/backfillDone', '1');
    mockGetBlockedDomains.mockRejectedValueOnce(new Error('offline'));

    await runBlockedDomainsSync();

    expect(mockSyncBlockedDomains).not.toHaveBeenCalled();
  });

  it('reconciles a parent-side unblock (server list narrower than before) into native', async () => {
    await AsyncStorage.setItem('@pfe/phaseB/blockedDomains/backfillDone', '1');
    mockGetBlockedDomains.mockResolvedValueOnce({
      domains: [
        {id: '1', domain: 'xhamster.com', source: 'detected', detectedAt: 't'},
      ],
    });

    await runBlockedDomainsSync();

    expect(mockSyncBlockedDomains).toHaveBeenCalledWith(['xhamster.com']);
  });

  it('flushes any pre-existing offline queue before backfilling/reconciling', async () => {
    await AsyncStorage.setItem(
      '@pfe/phaseB/blockedDomains/queue',
      JSON.stringify([
        {domain: 'queued.example', detectedAt: '2026-09-22T09:00:00.000Z'},
      ]),
    );
    mockPostBlockedDomain.mockResolvedValueOnce({
      domain: 'queued.example',
      outcome: 'added',
    });

    await runBlockedDomainsSync();

    expect(mockPostBlockedDomain).toHaveBeenCalledWith(
      'queued.example',
      '2026-09-22T09:00:00.000Z',
    );
    expect(await readQueueRaw()).toEqual([]);
  });
});
