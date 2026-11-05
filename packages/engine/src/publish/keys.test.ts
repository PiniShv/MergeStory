import { describe, expect, it } from 'vitest';
import { buildKeyPrefix, sanitizeKeyPrefix } from './keys.ts';

describe('buildKeyPrefix', () => {
  it('builds "<prefix>/v/<32 hex characters>/"', () => {
    expect(buildKeyPrefix('mergestory')).toMatch(/^mergestory\/v\/[0-9a-f]{32}\/$/);
  });

  it('never repeats a token', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(buildKeyPrefix('mergestory'));
    expect(seen.size).toBe(2000);
  });

  it('sanitises the prefix', () => {
    expect(buildKeyPrefix('/My Team/../Videos/')).toMatch(/^my-team\/videos\/v\/[0-9a-f]{32}\/$/);
    expect(buildKeyPrefix('ACME_Weather')).toMatch(/^acme_weather\/v\//);
  });

  it('starts at "v/" when nothing is left of the prefix', () => {
    expect(buildKeyPrefix('')).toMatch(/^v\/[0-9a-f]{32}\/$/);
    expect(buildKeyPrefix('../..')).toMatch(/^v\/[0-9a-f]{32}\/$/);
  });

  it('only contains lowercase letters, digits, "_", "-" and "/"', () => {
    for (const prefix of ['a b', 'x.y', 'ü/ß', 'UP/PER', 'a//b', '\\win\\path', 'tab\tname', '💥']) {
      expect(buildKeyPrefix(prefix)).toMatch(/^[a-z0-9_/-]+$/);
    }
  });
});

describe('sanitizeKeyPrefix', () => {
  it.each([
    ['mergestory', 'mergestory'],
    ['  Merge Story  ', 'merge-story'],
    ['/leading/slash', 'leading/slash'],
    ['trailing/slash/', 'trailing/slash'],
    ['a/../b', 'a/b'],
    ['a/./b', 'a/b'],
    ['a//b', 'a/b'],
    ['a\\b', 'a/b'],
    ['--dash--', 'dash'],
    ['', ''],
    ['...', ''],
  ])('turns %j into %j', (input, expected) => {
    expect(sanitizeKeyPrefix(input)).toBe(expected);
  });

  it('never contains ".." or a leading slash', () => {
    for (const input of ['..', '../..', '/..', 'a/..%2f..', '....//....']) {
      const out = sanitizeKeyPrefix(input);
      expect(out).not.toContain('..');
      expect(out.startsWith('/')).toBe(false);
    }
  });

  it('caps the length', () => {
    expect(sanitizeKeyPrefix('a'.repeat(500)).length).toBeLessThanOrEqual(100);
    expect(sanitizeKeyPrefix(`${'a'.repeat(99)}/b/c`)).not.toMatch(/[/-]$/);
  });
});
