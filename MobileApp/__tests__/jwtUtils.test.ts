import { decodeJwtPayload, isJwtExpired } from '../src/auth/jwtUtils';

function makeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('jwtUtils', () => {
  const originalAtob = global.atob;

  beforeAll(() => {
    global.atob = (value: string) => Buffer.from(value, 'base64').toString('utf8');
  });

  afterAll(() => {
    global.atob = originalAtob;
  });

  it('decodes childId and exp', () => {
    const token = makeToken({ childId: 'c1', exp: 1_900_000_000 });
    expect(decodeJwtPayload(token)).toEqual(
      expect.objectContaining({ childId: 'c1', exp: 1_900_000_000 }),
    );
  });

  it('detects expired tokens', () => {
    const expired = makeToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const fresh = makeToken({ exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(isJwtExpired(expired)).toBe(true);
    expect(isJwtExpired(fresh)).toBe(false);
  });

  it('treats missing exp as not expired', () => {
    expect(isJwtExpired(makeToken({ childId: 'c1' }))).toBe(false);
  });
});
