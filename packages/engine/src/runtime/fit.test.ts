import { describe, expect, it } from 'vitest';
import {
  clampText,
  formatInt,
  lineCount,
  middleTruncate,
  monoChars,
  monoWidth,
  pad2,
  truncatePath,
} from './fit.ts';

describe('middleTruncate', () => {
  it('leaves short text alone', () => {
    expect(middleTruncate('retry.ts', 20)).toBe('retry.ts');
  });

  it('keeps both ends and respects the limit', () => {
    const out = middleTruncate('abcdefghijklmnopqrstuvwxyz', 11);
    expect(out).toHaveLength(11);
    expect(out).toContain('…');
    expect(out.startsWith('a')).toBe(true);
    expect(out.endsWith('z')).toBe(true);
  });

  it('keeps more of the end than the start', () => {
    const out = middleTruncate('0123456789abcdefghij', 10);
    const [head, tail] = out.split('…');
    expect(tail!.length).toBeGreaterThan(head!.length);
  });

  it('handles tiny limits', () => {
    expect(middleTruncate('abcdef', 1)).toBe('…');
    expect(middleTruncate('abcdef', 0)).toBe('');
    expect(middleTruncate('abcdef', 2)).toHaveLength(2);
  });
});

describe('truncatePath', () => {
  it('returns paths that fit unchanged', () => {
    expect(truncatePath('src/a.ts', 40)).toBe('src/a.ts');
  });

  it('keeps the whole file name and shortens the directory', () => {
    const out = truncatePath('src/forecast/client/retry-policy.ts', 24);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out.endsWith('/retry-policy.ts')).toBe(true);
    expect(out).toContain('…/');
  });

  it('keeps a line range with the file name', () => {
    const out = truncatePath('packages/forecast/src/client.ts:88-112', 24);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out.endsWith('client.ts:88-112')).toBe(true);
  });

  it('falls back to the middle when the file name alone is too long', () => {
    const out = truncatePath('dir/a-very-long-file-name-for-testing.config.json', 20);
    expect(out).toHaveLength(20);
    expect(out).toContain('…');
  });

  it('never exceeds the limit', () => {
    for (const max of [4, 8, 12, 16, 30]) {
      expect(
        Array.from(truncatePath('packages/some-org/pkg/src/internal/implementation-details.ts', max)).length,
      ).toBeLessThanOrEqual(max);
    }
  });
});

describe('lineCount', () => {
  it('rounds to whole lines', () => {
    expect(lineCount(97, 48)).toBe(2);
    expect(lineCount(50, 48)).toBe(1);
    expect(lineCount(146, 48)).toBe(3);
  });

  it('is at least one line for content and zero without a line height', () => {
    expect(lineCount(0, 48)).toBe(1);
    expect(lineCount(100, 0)).toBe(0);
  });
});

describe('clampText', () => {
  it('cuts on a word boundary and adds an ellipsis', () => {
    expect(clampText('one two three four five', 20)).toBe('one two three four…');
    expect(clampText('short', 12)).toBe('short');
  });

  it('cuts inside a word when there is no good boundary', () => {
    expect(clampText('abcdefghijklmnop', 10)).toBe('abcdefghi…');
  });
});

describe('mono metrics', () => {
  it('uses 0.6 em per character', () => {
    expect(monoWidth(10, 20)).toBe(120);
    expect(monoChars(120, 20)).toBe(10);
    expect(monoChars(5, 20)).toBe(1);
  });
});

describe('number formatting', () => {
  it('adds thousands separators and rounds', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatInt(999)).toBe('999');
    expect(formatInt(1284)).toBe('1,284');
    expect(formatInt(1234567.4)).toBe('1,234,567');
  });

  it('pads counters to two digits', () => {
    expect(pad2(2)).toBe('02');
    expect(pad2(12)).toBe('12');
    expect(pad2(-1)).toBe('00');
  });
});
