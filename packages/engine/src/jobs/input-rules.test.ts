import { describe, expect, it } from 'vitest';
import {
  hasControlCharacter,
  hasLongRunDeep,
  isTooDeep,
  longestRun,
  MAX_NESTING,
  MAX_UNBROKEN_RUN,
  refProblem,
  sourceProblem,
} from './input-rules.ts';

describe('refProblem', () => {
  it('accepts the usual refs', () => {
    for (const ref of [
      'main',
      'origin/main',
      'feature/add-retries',
      'v1.2.3',
      'HEAD~3',
      'abc1234',
      'main@{upstream}',
      'refs/pull/1/head',
    ]) {
      expect(refProblem(ref), ref).toBeNull();
    }
  });

  it('refuses anything git could read as an option, or that is not one word', () => {
    for (const ref of [
      '',
      '-x',
      '--upload-pack=touch x',
      'two words',
      'tab\there',
      'line\nbreak',
      'nul\u0000',
      'del\u007f',
      'x'.repeat(257),
    ]) {
      expect(refProblem(ref), JSON.stringify(ref)).not.toBeNull();
    }
  });
});

describe('sourceProblem', () => {
  it('accepts pull requests and paths, spaces included', () => {
    for (const source of [
      'acme/app#1',
      'https://github.com/acme/app/pull/1',
      '/work/my repo',
      '.',
      '../other',
      'C:\\repos\\app',
    ]) {
      expect(sourceProblem(source), source).toBeNull();
    }
  });

  it('refuses options, control characters and absurd lengths', () => {
    for (const source of [
      '',
      '-rf',
      '--x',
      'a\nb',
      'a\u0000b',
      'x'.repeat(2049),
      'https://user:secret@github.com/acme/app/pull/1',
      'https://ghp_abcdef@github.com/acme/app/pull/1',
    ]) {
      expect(sourceProblem(source), JSON.stringify(source)).not.toBeNull();
    }
  });
});

describe('hasControlCharacter', () => {
  it('finds C0 controls and DEL only', () => {
    expect(hasControlCharacter('plain text \u00e9 \u2713')).toBe(false);
    expect(hasControlCharacter('a\u001fb')).toBe(true);
    expect(hasControlCharacter('a\u007fb')).toBe(true);
    expect(hasControlCharacter(' ')).toBe(false);
  });
});

describe('longestRun', () => {
  it('counts runs of letters, digits, underscore, dot and dash', () => {
    expect(longestRun('')).toBe(0);
    expect(longestRun('hello world')).toBe(5);
    expect(longestRun('a.b-c_d9 xy')).toBe(8);
    expect(longestRun('path/to/file.ts')).toBe(7);
    expect(longestRun('"quoted-value"')).toBe(12);
    expect(longestRun('a'.repeat(5000))).toBe(5000);
  });

  it('is fast on a huge input', () => {
    const started = Date.now();
    expect(longestRun('a.'.repeat(500_000))).toBe(1_000_000);
    expect(Date.now() - started).toBeLessThan(500);
    expect(MAX_UNBROKEN_RUN).toBe(1000);
  });
});

describe('hasLongRunDeep', () => {
  const blob = 'a'.repeat(MAX_UNBROKEN_RUN + 1);

  it('looks at every string in a document, keys included', () => {
    expect(hasLongRunDeep({ a: 'short', b: [1, true, null, { c: ['fine'] }] })).toBe(false);
    expect(hasLongRunDeep(blob)).toBe(true);
    expect(hasLongRunDeep({ a: { b: [{ c: blob }] } })).toBe(true);
    expect(hasLongRunDeep({ [blob]: 1 })).toBe(true);
    expect(hasLongRunDeep([[[[blob]]]])).toBe(true);
    expect(hasLongRunDeep('a'.repeat(MAX_UNBROKEN_RUN))).toBe(false);
  });

  it('sees through escape sequences, because it works on decoded text', () => {
    const escaped = `{"notes": "${'\\u0061'.repeat(MAX_UNBROKEN_RUN + 1)}"}`;
    expect(escaped.length).toBeGreaterThan(5000);
    expect(hasLongRunDeep(JSON.parse(escaped))).toBe(true);
  });

  it('copes with deep nesting and numbers', () => {
    let nested: unknown = 'x';
    for (let i = 0; i < 50_000; i++) nested = [nested];
    expect(hasLongRunDeep(nested)).toBe(false);
    expect(hasLongRunDeep([1e308, -5, 0])).toBe(false);
  });
});

describe('isTooDeep', () => {
  const nested = (levels: number) => {
    let value: unknown = 'x';
    for (let i = 0; i < levels; i++) value = i % 2 === 0 ? [value] : { a: value };
    return value;
  };

  it('accepts nesting up to the limit and refuses more, without a stack overflow', () => {
    expect(isTooDeep({ a: [{ b: [1, 2] }], c: 'text' })).toBe(false);
    expect(isTooDeep(nested(MAX_NESTING))).toBe(false);
    expect(isTooDeep(nested(MAX_NESTING + 1))).toBe(true);
    expect(isTooDeep(nested(200_000))).toBe(true);
  });
});
