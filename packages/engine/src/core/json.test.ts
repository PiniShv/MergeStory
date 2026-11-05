import { describe, expect, it } from 'vitest';
import { asArray, asNumber, asString, isRecord } from './json.ts';

describe('isRecord', () => {
  it('accepts objects and nothing else', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    for (const value of [null, undefined, [], [1], 'text', 3, true, () => ({})]) {
      expect(isRecord(value), String(value)).toBe(false);
    }
  });
});

describe('asString', () => {
  it('returns strings, including an empty one, and null for anything else', () => {
    expect(asString('x')).toBe('x');
    expect(asString('')).toBe('');
    for (const value of [null, undefined, 1, {}, ['x']]) expect(asString(value)).toBeNull();
  });
});

describe('asNumber', () => {
  it('returns finite numbers, zero included, and null for anything else', () => {
    expect(asNumber(4)).toBe(4);
    expect(asNumber(0)).toBe(0);
    expect(asNumber(-1.5)).toBe(-1.5);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '4', null, undefined, {}]) {
      expect(asNumber(value), String(value)).toBeNull();
    }
  });
});

describe('asArray', () => {
  it('returns an array as it is and an empty array for anything else', () => {
    const list = [1, 'a'];
    expect(asArray(list)).toBe(list);
    for (const value of [null, undefined, 'abc', 3, { length: 2 }]) expect(asArray(value)).toEqual([]);
  });
});
