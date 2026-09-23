jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

import { query } from '../src/db/pool';
import {
  listBlockedDomains,
  listBrowserIncidents,
  recordBrowserIncident,
  recordDetectedDomain,
  unblockDomain,
} from '../src/services/blockedDomainsService';

const mockedQuery = query as jest.Mock;

const CHILD_A = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  mockedQuery.mockReset();
});

describe('recordDetectedDomain (A10)', () => {
  it('inserts a new active row when none exists', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT: no existing row
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bd-1',
            child_id: CHILD_A,
            domain: 'pornhub.com',
            source: 'detected',
            detected_at: '2026-09-22T10:00:00.000Z',
            created_at: '2026-09-22T10:00:00.000Z',
            removed_at: null,
          },
        ],
      });

    const { outcome, row } = await recordDetectedDomain(
      CHILD_A,
      'pornhub.com',
      '2026-09-22T10:00:00.000Z',
    );
    expect(outcome).toBe('added');
    expect(row.removed_at).toBeNull();
    expect(mockedQuery).toHaveBeenCalledTimes(2);
    expect((mockedQuery.mock.calls[1][0] as string)).toMatch(/^\s*INSERT INTO blocked_domains/);
  });

  it('is idempotent when the row is already active — no write', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'bd-1',
          child_id: CHILD_A,
          domain: 'pornhub.com',
          source: 'detected',
          detected_at: '2026-09-22T10:00:00.000Z',
          created_at: '2026-09-22T09:00:00.000Z',
          removed_at: null,
        },
      ],
    });

    const { outcome } = await recordDetectedDomain(
      CHILD_A,
      'pornhub.com',
      '2026-09-22T09:00:00.000Z', // not newer than existing detected_at
    );
    expect(outcome).toBe('already_active');
    expect(mockedQuery).toHaveBeenCalledTimes(1); // SELECT only, no write
  });

  it('advances detected_at forward when a later duplicate POST arrives while active', async () => {
    mockedQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bd-1',
            child_id: CHILD_A,
            domain: 'pornhub.com',
            source: 'detected',
            detected_at: '2026-09-22T09:00:00.000Z',
            created_at: '2026-09-22T09:00:00.000Z',
            removed_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bd-1',
            child_id: CHILD_A,
            domain: 'pornhub.com',
            source: 'detected',
            detected_at: '2026-09-22T11:00:00.000Z',
            created_at: '2026-09-22T09:00:00.000Z',
            removed_at: null,
          },
        ],
      });

    const { outcome, row } = await recordDetectedDomain(
      CHILD_A,
      'pornhub.com',
      '2026-09-22T11:00:00.000Z',
    );
    expect(outcome).toBe('already_active');
    expect(row.detected_at).toBe('2026-09-22T11:00:00.000Z');
  });

  it('ignores a stale re-add whose detectedAt predates the removal', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'bd-1',
          child_id: CHILD_A,
          domain: 'pornhub.com',
          source: 'detected',
          detected_at: '2026-09-20T10:00:00.000Z',
          created_at: '2026-09-20T10:00:00.000Z',
          removed_at: '2026-09-21T10:00:00.000Z', // parent unblocked it
        },
      ],
    });

    const { outcome } = await recordDetectedDomain(
      CHILD_A,
      'pornhub.com',
      '2026-09-20T12:00:00.000Z', // before the removal — a queued/offline POST
    );
    expect(outcome).toBe('ignored');
    expect(mockedQuery).toHaveBeenCalledTimes(1); // SELECT only, no write
  });

  it('reactivates when a genuinely later detection arrives after removal', async () => {
    mockedQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bd-1',
            child_id: CHILD_A,
            domain: 'pornhub.com',
            source: 'detected',
            detected_at: '2026-09-20T10:00:00.000Z',
            created_at: '2026-09-20T10:00:00.000Z',
            removed_at: '2026-09-21T10:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bd-1',
            child_id: CHILD_A,
            domain: 'pornhub.com',
            source: 'detected',
            detected_at: '2026-09-22T10:00:00.000Z',
            created_at: '2026-09-20T10:00:00.000Z',
            removed_at: null,
          },
        ],
      });

    const { outcome, row } = await recordDetectedDomain(
      CHILD_A,
      'pornhub.com',
      '2026-09-22T10:00:00.000Z', // after the removal
    );
    expect(outcome).toBe('reactivated');
    expect(row.removed_at).toBeNull();
    expect((mockedQuery.mock.calls[1][0] as string)).toMatch(/^\s*UPDATE blocked_domains/);
  });
});

describe('unblockDomain', () => {
  it('true when an active row was cleared', async () => {
    mockedQuery.mockResolvedValueOnce({ rowCount: 1 });
    await expect(unblockDomain(CHILD_A, 'pornhub.com')).resolves.toBe(true);
  });

  it('false when nothing active matched', async () => {
    mockedQuery.mockResolvedValueOnce({ rowCount: 0 });
    await expect(unblockDomain(CHILD_A, 'pornhub.com')).resolves.toBe(false);
  });
});

describe('listBlockedDomains', () => {
  it('only ever selects active rows, newest first', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] });
    await listBlockedDomains(CHILD_A, 100);
    const sql = mockedQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/removed_at IS NULL/);
    expect(sql).toMatch(/ORDER BY detected_at DESC/);
  });
});

describe('browser incidents', () => {
  it('records an incident', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'inc-1',
          child_id: CHILD_A,
          domain: 'randomsite.example',
          list_source: 'static',
          occurred_at: '2026-09-22T10:00:00.000Z',
          created_at: '2026-09-22T10:00:00.000Z',
        },
      ],
    });
    const row = await recordBrowserIncident(
      CHILD_A,
      'randomsite.example',
      'static',
      '2026-09-22T10:00:00.000Z',
    );
    expect(row.list_source).toBe('static');
  });

  it('lists incidents newest first', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] });
    await listBrowserIncidents(CHILD_A, 50);
    const sql = mockedQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/ORDER BY occurred_at DESC/);
  });
});
