import { domainSchema, recordBlockedDomainSchema } from '../src/validators/blockedDomains.validator';

describe('domainSchema', () => {
  it('accepts a bare host', () => {
    expect(domainSchema.validate('pornhub.com').error).toBeUndefined();
    expect(domainSchema.validate('sub.example.co.uk').error).toBeUndefined();
  });

  it('lowercases before validating', () => {
    const { value, error } = domainSchema.validate('PornHub.COM');
    expect(error).toBeUndefined();
    expect(value).toBe('pornhub.com');
  });

  it.each([
    ['a path', 'pornhub.com/videos'],
    ['a query string', 'pornhub.com?x=1'],
    ['a space', 'porn hub.com'],
    ['a scheme', 'https://pornhub.com'],
    ['userinfo', 'user:pw@pornhub.com'],
    ['no dot', 'localhost'],
    ['empty', ''],
  ])('rejects a domain with %s', (_label, domain) => {
    expect(domainSchema.validate(domain).error).toBeDefined();
  });

  it('rejects over 253 characters', () => {
    const tooLong = 'a'.repeat(250) + '.com';
    expect(tooLong.length).toBeGreaterThan(253);
    expect(domainSchema.validate(tooLong).error).toBeDefined();
  });

  it('accepts exactly 253 characters (respecting the 63-char DNS label limit)', () => {
    const label63 = 'a'.repeat(63);
    const label61 = 'a'.repeat(61);
    const exact = [label63, label63, label63, label61].join('.');
    expect(exact.length).toBe(253);
    expect(domainSchema.validate(exact).error).toBeUndefined();
  });
});

describe('recordBlockedDomainSchema', () => {
  it('requires both fields', () => {
    expect(recordBlockedDomainSchema.validate({}).error).toBeDefined();
    expect(
      recordBlockedDomainSchema.validate({ domain: 'pornhub.com' }).error,
    ).toBeDefined();
  });

  it('accepts a valid pair', () => {
    const { error } = recordBlockedDomainSchema.validate({
      domain: 'pornhub.com',
      detectedAt: '2026-09-22T10:00:00.000Z',
    });
    expect(error).toBeUndefined();
  });
});
