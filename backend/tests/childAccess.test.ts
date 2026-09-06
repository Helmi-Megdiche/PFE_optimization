jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

import { query } from '../src/db/pool';
import {
  parentOwnsChild,
  userCanAccessChild,
  requireChildAccess,
} from '../src/middleware/childAccess';
import type { JwtPayload } from '../src/middleware/auth.types';

const mockQuery = query as jest.MockedFunction<typeof query>;

const CHILD_A = '33333333-3333-3333-3333-333333333333';
const CHILD_B = '44444444-4444-4444-4444-444444444444';
const PARENT_A = '11111111-1111-1111-1111-111111111111';

function rows(n: number) {
  return { rows: Array.from({ length: n }, () => ({ id: CHILD_A })), rowCount: n };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRes(): any {
  const res: Record<string, unknown> = {};
  res.statusCode = 0;
  res.body = undefined;
  res.status = jest.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = jest.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res;
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe('parentOwnsChild', () => {
  it('true when the ownership row exists', async () => {
    mockQuery.mockResolvedValueOnce(rows(1));
    await expect(parentOwnsChild(PARENT_A, CHILD_A)).resolves.toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('false when no row', async () => {
    mockQuery.mockResolvedValueOnce(rows(0));
    await expect(parentOwnsChild(PARENT_A, CHILD_A)).resolves.toBe(false);
  });

  it('false without querying when parentId or childId is empty', async () => {
    await expect(parentOwnsChild('', CHILD_A)).resolves.toBe(false);
    await expect(parentOwnsChild(PARENT_A, '')).resolves.toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('userCanAccessChild', () => {
  const child = (id: string): JwtPayload => ({ sub: 'u', role: 'child', childId: id });
  const parent = (id: string): JwtPayload => ({ sub: id, role: 'parent' });

  it('child token: own childId -> true, other -> false, no DB call', async () => {
    await expect(userCanAccessChild(child(CHILD_A), CHILD_A)).resolves.toBe(true);
    await expect(userCanAccessChild(child(CHILD_A), CHILD_B)).resolves.toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('parent token: owns -> true, does not own -> false', async () => {
    mockQuery.mockResolvedValueOnce(rows(1));
    await expect(userCanAccessChild(parent(PARENT_A), CHILD_A)).resolves.toBe(true);
    mockQuery.mockResolvedValueOnce(rows(0));
    await expect(userCanAccessChild(parent(PARENT_A), CHILD_A)).resolves.toBe(false);
  });

  it('false for undefined user, undefined childId, or unknown role', async () => {
    await expect(userCanAccessChild(undefined, CHILD_A)).resolves.toBe(false);
    await expect(userCanAccessChild(parent(PARENT_A), undefined)).resolves.toBe(false);
    await expect(
      userCanAccessChild({ sub: 'x', role: 'admin' } as unknown as JwtPayload, CHILD_A),
    ).resolves.toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('requireChildAccess factory', () => {
  const parentReq = (over: Record<string, unknown> = {}) => ({
    user: { sub: PARENT_A, role: 'parent' } as JwtPayload,
    params: {},
    query: {},
    body: {},
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  it('param:childId — allows and calls next() when owned', async () => {
    mockQuery.mockResolvedValueOnce(rows(1));
    const res = fakeRes();
    const next = jest.fn();
    await requireChildAccess('param:childId')(
      parentReq({ params: { childId: CHILD_A } }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('param:childId — 403 with the established body when not owned', async () => {
    mockQuery.mockResolvedValueOnce(rows(0));
    const res = fakeRes();
    const next = jest.fn();
    await requireChildAccess('param:childId')(
      parentReq({ params: { childId: CHILD_A } }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ error: 'Access denied for this child' });
  });

  it('param:childId — missing/non-string id -> 403, no DB call', async () => {
    const res = fakeRes();
    const next = jest.fn();
    await requireChildAccess('param:childId')(parentReq({ params: {} }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('query:childId — absent param passes through', async () => {
    const res = fakeRes();
    const next = jest.fn();
    await requireChildAccess('query:childId')(parentReq({ query: {} }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('query:childId — present but not owned -> 403', async () => {
    mockQuery.mockResolvedValueOnce(rows(0));
    const res = fakeRes();
    const next = jest.fn();
    await requireChildAccess('query:childId')(
      parentReq({ query: { childId: CHILD_A } }),
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('body:childId — reads req.body', async () => {
    mockQuery.mockResolvedValueOnce(rows(1));
    const res = fakeRes();
    const next = jest.fn();
    await requireChildAccess('body:childId')(
      parentReq({ body: { childId: CHILD_A } }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails closed with 500 when the ownership lookup throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const res = fakeRes();
    const next = jest.fn();
    await requireChildAccess('param:childId')(
      parentReq({ params: { childId: CHILD_A } }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body).toEqual({ error: 'Authorization check failed' });
  });

  it('child token reaching its own id passes without a DB call', async () => {
    const res = fakeRes();
    const next = jest.fn();
    const req = {
      user: { sub: 'u', role: 'child', childId: CHILD_A } as JwtPayload,
      params: { childId: CHILD_A },
      query: {},
      body: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await requireChildAccess('param:childId')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
