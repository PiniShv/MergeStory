import { describe, expect, it } from 'vitest';
import { capitalise, escapeRegExp, splitSentences, stripMarkdown } from './text.ts';

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

describe('stripMarkdown', () => {
  it('drops tags, also one that only forms when another is taken out', () => {
    expect(stripMarkdown('a <b>bold</b> word')).toBe('a bold word');
    expect(stripMarkdown('<scr<b>ipt>x')).toBe('x');
  });

  it('drops a comment, also one that never closes', () => {
    expect(stripMarkdown('<!-- note -->\nKept.')).toBe('Kept.');
    expect(stripMarkdown('Kept.\n<!-- template')).toBe('Kept.');
  });
});

describe('splitSentences', () => {
  it('keeps a run of marks with its sentence', () => {
    expect(splitSentences('Really?!! Yes. "Done." Next')).toEqual(['Really?!!', 'Yes.', '"Done."', 'Next']);
  });
});
