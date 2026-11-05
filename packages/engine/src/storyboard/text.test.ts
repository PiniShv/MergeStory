import { describe, expect, it } from 'vitest';
import { capitalise, escapeRegExp } from './text.ts';

describe('capitalise', () => {
  it('raises the first letter only', () => {
    expect(capitalise('the function withRetry')).toBe('The function withRetry');
    expect(capitalise('')).toBe('');
  });
});

describe('escapeRegExp', () => {
  it('makes a name match itself as written', () => {
    const name = 'Client.get$(a)+[b]';
    expect(new RegExp(`^${escapeRegExp(name)}$`).test(name)).toBe(true);
    expect(new RegExp(`^${escapeRegExp('a.c')}$`).test('abc')).toBe(false);
  });
});
