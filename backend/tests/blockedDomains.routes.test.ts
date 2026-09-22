/**
 * Live-HTTP route tests for Phase B Task 10 (blocked-domains / browser-incidents).
 *
 * Hermetic like routeAuthorization.test.ts: mocks config/env and db/pool, so this
 * sends no real DB queries. Unlike that suite (which only walks the router tree),
 * this actually starts the Express app on an ephemeral port and issues real HTTP
 * requests with real signed JWTs, so it can prove the 403/404 outcomes the
 * middleware chain is supposed to produce, not just that the chain is wired.
 */
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';

const mockEnv = {
  isProduction: false,
  jwtSecret: 'test-secret',
  jwtIssuer: 'pfe-parental-control',
  databaseUrl: 'postgres://t',
  missionRiskCooldownMinutes: 2,
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'silent',
  appTimezone: 'Africa/Tunis',
};

jest.mock('../src/config/env', () => ({ env: mockEnv }));

const mockedQuery = jest.fn();
jest.mock('../src/db/pool', () => ({ query: (...args: unknown[]) => mockedQuery(...args) }));

import { createApp } from '../src/app';

const PARENT_A = '11111111-1111-1111-1111-111111111111';
const PARENT_B = '55555555-5555-5555-5555-555555555555';
const CHILD_A = '33333333-3333-3333-3333-333333333333';

function signParent(sub: string): string {
  return jwt.sign({ sub, role: 'parent' }, mockEnv.jwtSecret, {
    issuer: mockEnv.jwtIssuer,
    algorithm: 'HS256',
  });
}

function signChild(childId: string): string {
  return jwt.sign(
    { sub: 'device-1', role: 'child', childId },
    mockEnv.jwtSecret,
    { issuer: mockEnv.jwtIssuer, algorithm: 'HS256' },
  );
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mockEnv.isProduction = false;
  mockedQuery.mockReset();
});

describe('GET /api/blocked-domains/:childId', () => {
  it('403s a parent who does not own the child', async () => {
    // requireChildAccess -> parentOwnsChild -> SELECT ... FROM children -> no row
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await fetch(`${baseUrl}/api/blocked-domains/${CHILD_A}`, {
      headers: { Authorization: `Bearer ${signParent(PARENT_B)}` },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access denied for this child' });
    // the list query itself must never run once ownership fails
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it('200s the owning parent and returns the mapped shape', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: CHILD_A }], rowCount: 1 }) // ownership
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bd-1',
            child_id: CHILD_A,
            domain: 'pornhub.com',
            source: 'detected',
            detected_at: '2026-09-21T10:00:00.000Z',
            created_at: '2026-09-21T10:00:00.000Z',
            removed_at: null,
          },
        ],
        rowCount: 1,
      });

    const res = await fetch(`${baseUrl}/api/blocked-domains/${CHILD_A}`, {
      headers: { Authorization: `Bearer ${signParent(PARENT_A)}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: Array<{ domain: string }> };
    expect(body.domains).toEqual([
      { id: 'bd-1', domain: 'pornhub.com', source: 'detected', detectedAt: '2026-09-21T10:00:00.000Z' },
    ]);
  });
});

describe('POST /api/blocked-domains/dev/unblock', () => {
  it('is a flat 404 in production, before any role or body check', async () => {
    mockEnv.isProduction = true;

    const res = await fetch(`${baseUrl}/api/blocked-domains/dev/unblock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signChild(CHILD_A)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId: CHILD_A, domain: 'pornhub.com' }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('403s a child token outside production (parent-only)', async () => {
    const res = await fetch(`${baseUrl}/api/blocked-domains/dev/unblock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signChild(CHILD_A)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId: CHILD_A, domain: 'pornhub.com' }),
    });

    expect(res.status).toBe(403);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('403s a parent who does not own the child, outside production', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ownership fails

    const res = await fetch(`${baseUrl}/api/blocked-domains/dev/unblock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signParent(PARENT_B)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId: CHILD_A, domain: 'pornhub.com' }),
    });

    expect(res.status).toBe(403);
  });

  it('unblocks for the owning parent outside production', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: CHILD_A }], rowCount: 1 }) // ownership
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE ... removed_at = NOW()

    const res = await fetch(`${baseUrl}/api/blocked-domains/dev/unblock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signParent(PARENT_A)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId: CHILD_A, domain: 'pornhub.com' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ domain: 'pornhub.com', unblocked: true });
  });
});

describe('domain validation (server-side, Task 10)', () => {
  it.each([
    ['a path', 'pornhub.com/videos'],
    ['a query string', 'pornhub.com?x=1'],
    ['a space', 'porn hub.com'],
    ['a scheme', 'https://pornhub.com'],
    ['over 253 chars', 'a'.repeat(250) + '.com'],
  ])('rejects a domain with %s', async (_label, domain) => {
    const res = await fetch(`${baseUrl}/api/blocked-domains`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signChild(CHILD_A)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, detectedAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(400);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('accepts a bare host and uses the token childId, not the body', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no existing row
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bd-2',
            child_id: CHILD_A,
            domain: 'xhamster.com',
            source: 'detected',
            detected_at: '2026-09-22T10:00:00.000Z',
            created_at: '2026-09-22T10:00:00.000Z',
            removed_at: null,
          },
        ],
        rowCount: 1,
      });

    const res = await fetch(`${baseUrl}/api/blocked-domains`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signChild(CHILD_A)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'xhamster.com', detectedAt: '2026-09-22T10:00:00.000Z' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ domain: 'xhamster.com', outcome: 'added' });
    // childId bound into the INSERT must be the token's childId (CHILD_A). Joi's
    // date().iso() converts detectedAt to a Date before it reaches the route handler,
    // which normalises it back to ISO before calling the service — compare loosely.
    const insertCall = mockedQuery.mock.calls[1];
    expect(insertCall[1][0]).toBe(CHILD_A);
    expect(insertCall[1][1]).toBe('xhamster.com');
    expect(new Date(insertCall[1][2] as string).toISOString()).toBe('2026-09-22T10:00:00.000Z');
  });
});
