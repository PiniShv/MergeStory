import { describe, expect, it } from 'vitest';
import type { CodeToken } from '../core/render-plan.ts';
import { highlightText, plainTokens, resolveLanguage } from './highlight.ts';

const join = (tokens: CodeToken[]): string => tokens.map((t) => t.t).join('');

describe('resolveLanguage', () => {
  it('accepts Shiki ids and aliases, and ignores case', () => {
    expect(resolveLanguage('typescript')).toBe('typescript');
    expect(resolveLanguage('TS')).toBe('ts');
    expect(resolveLanguage('python')).toBe('python');
  });

  it('returns null for plain text and unknown languages', () => {
    for (const value of [null, undefined, '', 'text', 'plaintext', 'not-a-language']) {
      expect(resolveLanguage(value)).toBeNull();
    }
  });
});

describe('highlightText', () => {
  it('returns tokens per line that rebuild the text', async () => {
    const code = 'const a = 1;\n\n// done\n';
    const lines = await highlightText(code, { language: 'typescript', theme: 'dark' });
    expect(lines.map(join)).toEqual(['const a = 1;', '', '// done', '']);
    expect(lines[1]).toEqual([]);
  });

  it('colours tokens and leaves the default foreground as null', async () => {
    const [line] = await highlightText('const a = 1;', { language: 'typescript', theme: 'dark' });
    const keyword = line!.find((t) => t.t === 'const')!;
    expect(keyword.c).toMatch(/^#[0-9a-f]{6}$/);
    expect(line!.some((t) => t.c === null)).toBe(true);
    for (const token of line!) expect(token.s & ~7).toBe(0);
  });

  it('uses the theme that was asked for', async () => {
    const [dark] = await highlightText('const a = 1;', { language: 'typescript', theme: 'dark' });
    const [light] = await highlightText('const a = 1;', { language: 'typescript', theme: 'light' });
    expect(dark!.find((t) => t.t === 'const')!.c).not.toBe(light!.find((t) => t.t === 'const')!.c);
  });

  it('keeps grammar state across lines', async () => {
    const lines = await highlightText('/* start\n   still a comment */\nconst x = 1;', {
      language: 'typescript',
      theme: 'dark',
    });
    const comment = lines[0]![0]!.c;
    expect(comment).not.toBeNull();
    expect(lines[1]!.find((t) => t.t.includes('still a comment'))?.c).toBe(comment);
    expect(lines[2]!.find((t) => t.t === 'const')!.c).not.toBe(comment);
  });

  it('shows unknown languages as plain text', async () => {
    const lines = await highlightText('hello\n  world', { language: 'no-such-language', theme: 'dark' });
    expect(lines).toEqual([[{ t: 'hello', c: null, s: 0 }], [{ t: '  world', c: null, s: 0 }]]);
  });

  it('merges neighbouring tokens that look the same', async () => {
    const [line] = await highlightText('a b c', { language: 'text', theme: 'dark' });
    expect(line).toEqual([{ t: 'a b c', c: null, s: 0 }]);
  });
});

describe('plainTokens', () => {
  it('makes one token per non-empty line', () => {
    expect(plainTokens('a\n\nb')).toEqual([[{ t: 'a', c: null, s: 0 }], [], [{ t: 'b', c: null, s: 0 }]]);
  });
});
