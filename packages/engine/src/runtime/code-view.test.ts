import { describe, expect, it } from 'vitest';
import type { CodeLine, ResolvedCode } from '../core/render-plan.ts';
import {
  CODE_CHAR_EM,
  DIM_OPACITY,
  focusIndexRange,
  languageLabel,
  MIN_CODE_FONT,
  planCodeLayout,
  planCodeView,
  prepareTokens,
  wrapCodeLine,
} from './code-view.ts';

const row = (
  kind: CodeLine['kind'],
  oldNumber: number | null,
  newNumber: number | null,
  text = 'x',
): CodeLine => ({
  kind,
  oldNumber,
  newNumber,
  tokens: [{ t: text, c: null, s: 0 }],
});

const diff: ResolvedCode = {
  path: 'src/a.ts',
  language: 'typescript',
  side: 'head',
  masked: false,
  truncated: false,
  lines: [
    row('ctx', 4, 17),
    row('del', 5, null),
    row('add', null, 18),
    row('ctx', 6, 19),
    row('add', null, 20),
    row('ctx', 7, 21),
  ],
};

describe('languageLabel', () => {
  it('names common languages and falls back to a capitalised id', () => {
    expect(languageLabel('ts')).toBe('TypeScript');
    expect(languageLabel(' TypeScript ')).toBe('TypeScript');
    expect(languageLabel('sh')).toBe('Shell');
    expect(languageLabel('terraform')).toBe('Terraform');
    expect(languageLabel('')).toBe('Text');
  });
});

describe('prepareTokens', () => {
  it('expands tabs to the next tab stop across tokens', () => {
    const out = prepareTokens([
      { t: '\tfoo', c: null, s: 0 },
      { t: '\tbar', c: '#fff', s: 1 },
    ]);
    expect(out.tokens.map((t) => t.t)).toEqual(['    foo', ' bar']);
    expect(out.length).toBe(11);
    expect(out.tokens[1]?.c).toBe('#fff');
  });

  it('drops line breaks and empty tokens', () => {
    const out = prepareTokens([
      { t: 'a\r\n', c: null, s: 0 },
      { t: '\n', c: null, s: 0 },
    ]);
    expect(out.tokens.map((t) => t.t)).toEqual(['a']);
    expect(out.length).toBe(1);
  });
});

describe('focusIndexRange', () => {
  it('maps file line numbers on the code side to rows', () => {
    expect(focusIndexRange(diff, 18, 19)).toEqual({ first: 2, last: 3 });
    expect(focusIndexRange(diff, 20, 20)).toEqual({ first: 4, last: 4 });
    expect(focusIndexRange(diff, 19, 18)).toEqual({ first: 2, last: 3 });
  });

  it('returns null when no row carries the numbers', () => {
    expect(focusIndexRange(diff, 100, 101)).toBeNull();
  });

  it('finds removed rows through their own numbers when nothing else matches', () => {
    expect(focusIndexRange(diff, 5, 5)).toEqual({ first: 1, last: 1 });
  });

  it('uses old numbers for base-side code', () => {
    expect(focusIndexRange({ ...diff, side: 'base' }, 5, 6)).toEqual({ first: 1, last: 3 });
  });
});

describe('planCodeLayout', () => {
  it('picks a comfortable font for a short block', () => {
    const plan = planCodeLayout({ lineCount: 14, avail: 520, minFont: 22, maxFont: 26 });
    expect(plan.fontSize).toBeGreaterThanOrEqual(22);
    expect(plan.fontSize).toBeLessThanOrEqual(26);
    expect(plan.lineHeight / plan.fontSize).toBeGreaterThanOrEqual(1.4);
    expect(plan.lineHeight * plan.shown).toBeLessThanOrEqual(520);
    expect(plan.shown).toBe(14);
  });

  it('uses the largest font when there is room', () => {
    expect(planCodeLayout({ lineCount: 5, avail: 500, minFont: 22, maxFont: 26 }).fontSize).toBe(26);
  });

  it('keeps the smallest font and shows only the rows that fit for very long blocks', () => {
    const plan = planCodeLayout({ lineCount: 60, avail: 500, minFont: 22, maxFont: 26 });
    expect(plan.fontSize).toBe(22);
    expect(plan.shown).toBeLessThan(60);
    expect(plan.shown * plan.lineHeight).toBeLessThanOrEqual(500);
  });
});

describe('planCodeView', () => {
  it('sizes a diff window inside its limits and reserves a second gutter', () => {
    const plan = planCodeView(diff, { width: 'fit', minWidth: 600, maxWidth: 1100, maxHeight: 600 });
    expect(plan.diff).toBe(true);
    expect(plan.width).toBeGreaterThanOrEqual(600);
    expect(plan.width).toBeLessThanOrEqual(1100);
    expect(plan.height).toBeLessThanOrEqual(600);
    expect(plan.shown).toBe(6);
    expect(plan.hidden).toBe(0);
    const snippet = planCodeView(
      { ...diff, lines: diff.lines.map((l) => ({ ...l, kind: 'ctx' as const })) },
      {
        width: 'fit',
        maxHeight: 600,
      },
    );
    expect(snippet.diff).toBe(false);
    expect(snippet.gutterWidth).toBeLessThan(plan.gutterWidth);
  });

  it('steps the font down so a long line fits a narrow window', () => {
    const long: ResolvedCode = { ...diff, lines: [row('ctx', 1, 1, 'x'.repeat(60))] };
    const wide = planCodeView(long, { width: 1400, maxHeight: 400 });
    const narrow = planCodeView(long, { width: 900, maxHeight: 400 });
    expect(narrow.fontSize).toBeLessThan(wide.fontSize);
    expect(narrow.fontSize).toBeGreaterThanOrEqual(MIN_CODE_FONT);
    expect(narrow.wrapped).toBe(0);
    expect(narrow.rows).toBe(1);
  });

  it('keeps the whole longest line in view by lowering the font before it wraps anything', () => {
    // 97 characters: too wide for 1156 px at 25 px, still fine at 1680 px.
    const text = `export const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 250, maxDelayMs: 4_000 };`;
    const long: ResolvedCode = { ...diff, lines: [row('ctx', 8, 8, text), row('ctx', 9, 9, 'x')] };
    const full = planCodeView(long, { width: 'fit', minWidth: 700, maxWidth: 1680, maxHeight: 700 });
    expect(full.wrapped).toBe(0);
    expect(full.fontSize).toBeGreaterThanOrEqual(24);
    expect(full.cols).toBeGreaterThanOrEqual(text.length);
    // The gutter and the text must both fit inside the window.
    expect(full.gutterWidth + text.length * CODE_CHAR_EM * full.fontSize).toBeLessThanOrEqual(full.width);
    const narrower = planCodeView(long, { width: 'fit', minWidth: 700, maxWidth: 1300, maxHeight: 700 });
    expect(narrower.fontSize).toBeLessThan(full.fontSize);
    expect(narrower.wrapped).toBe(0);
  });

  it('wraps only what is still too long at the floor, and the window then uses the whole width', () => {
    const text = `${'const value = compute(argumentNumberOne, argumentNumberTwo); '.repeat(2)}done();`;
    const lines = [row('ctx', 1, 1, 'short'), row('ctx', 2, 2, text)];
    for (let i = 3; i <= 10; i++) lines.push(row('ctx', i, i, text));
    const plan = planCodeView(
      { ...diff, lines },
      { width: 'fit', minWidth: 700, maxWidth: 1000, maxHeight: 700 },
    );
    expect(plan.fontSize).toBeGreaterThanOrEqual(MIN_CODE_FONT);
    expect(plan.wrapped).toBe(9);
    expect(plan.hidden).toBe(0);
    expect(plan.lineRows[0]).toBe(1);
    expect(plan.lineRows.slice(1).every((n) => n >= 2)).toBe(true);
    expect(plan.rowStarts.slice(0, 3)).toEqual([0, 1, 1 + (plan.lineRows[1] as number)]);
    expect(plan.width).toBe(1000);
    expect(plan.height).toBe(plan.barHeight + 2 * plan.padY + plan.rows * plan.lineHeight);
    expect(plan.height).toBeLessThanOrEqual(700);
  });

  it('keeps the font large when lines have to wrap and there is room for the extra rows', () => {
    const text = `${'const value = compute(argumentNumberOne, argumentNumberTwo); '.repeat(3)}done();`;
    const plan = planCodeView(
      { ...diff, lines: [row('ctx', 1, 1, text), row('ctx', 2, 2, text)] },
      { width: 'fit', minWidth: 700, maxWidth: 1000, maxHeight: 700 },
    );
    expect(plan.wrapped).toBe(2);
    expect(plan.fontSize).toBeGreaterThan(MIN_CODE_FONT);
    expect(plan.hidden).toBe(0);
    // No line wraps more than three times as much as it would in one piece.
    expect(plan.rows).toBeLessThanOrEqual(2 * 3);
    expect(plan.height).toBeLessThanOrEqual(700);
    expect(plan.lineHeight / plan.fontSize).toBeGreaterThanOrEqual(1.4);
  });

  it('falls back to the floor with tight lines, and shows only the lines that fit, when there is no room', () => {
    const text = 'x'.repeat(300);
    const lines = Array.from({ length: 14 }, (_, i) => row('ctx', i + 1, i + 1, text));
    const plan = planCodeView(
      { ...diff, lines },
      { width: 'fit', minWidth: 700, maxWidth: 1000, maxHeight: 560 },
    );
    expect(plan.fontSize).toBe(MIN_CODE_FONT);
    expect(plan.hidden).toBeGreaterThan(0);
    expect(plan.footer).toBeGreaterThan(0);
    expect(plan.height).toBeLessThanOrEqual(560);
  });

  it('leaves room for every row of the wrapped lines in the height', () => {
    const text = 'a'.repeat(300);
    const lines = Array.from({ length: 6 }, (_, i) => row('ctx', i + 1, i + 1, text));
    const plan = planCodeView({ ...diff, lines }, { width: 1000, maxHeight: 700 });
    expect(plan.rows).toBeGreaterThan(plan.shown);
    expect(plan.height).toBeLessThanOrEqual(700);
    expect(plan.rows * plan.lineHeight + plan.barHeight + 2 * plan.padY + plan.footer).toBeLessThanOrEqual(
      700,
    );
  });

  it('adds the shortened footer and counts hidden rows', () => {
    const many: ResolvedCode = {
      ...diff,
      truncated: true,
      lines: Array.from({ length: 40 }, (_, i) => row('ctx', i + 1, i + 1)),
    };
    const plan = planCodeView(many, { width: 900, maxHeight: 500 });
    expect(plan.footer).toBeGreaterThan(0);
    expect(plan.hidden).toBe(40 - plan.shown);
    expect(plan.hidden).toBeGreaterThan(0);
    expect(plan.height).toBeLessThanOrEqual(500);
  });
});

describe('wrapCodeLine', () => {
  const prepared = (text: string) => prepareTokens([{ t: text, c: null, s: 0 }]);
  const flat = (rows: { tokens: { t: string }[] }[]) => rows.map((r) => r.tokens.map((t) => t.t).join(''));

  it('leaves a line that fits alone', () => {
    const wrap = wrapCodeLine(prepared('const a = 1;'), 40);
    expect(wrap.rows).toHaveLength(1);
    expect(wrap.hang).toBe(0);
    expect(flat(wrap.rows)).toEqual(['const a = 1;']);
  });

  it('breaks after a comma or a space near the end of the row and keeps every character', () => {
    const text = 'call(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive);';
    const wrap = wrapCodeLine(prepared(text), 40);
    expect(wrap.rows.length).toBeGreaterThan(1);
    for (const r of flat(wrap.rows)) expect(r.length).toBeLessThanOrEqual(40);
    expect(flat(wrap.rows)[0]?.endsWith(', ') || flat(wrap.rows)[0]?.endsWith(',')).toBe(true);
    // Nothing is lost except the spaces at the cuts.
    expect(flat(wrap.rows).join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  it('indents continuation rows by the indent of the line plus two columns', () => {
    const wrap = wrapCodeLine(prepared(`      ${'word '.repeat(30)}`), 50);
    expect(wrap.hang).toBe(8);
    expect(
      flat(wrap.rows)
        .slice(1)
        .every((r) => r.length <= 50 - 8),
    ).toBe(true);
  });

  it('caps the hanging indent so deep code still wraps into rows of useful width', () => {
    const wrap = wrapCodeLine(prepared(`${' '.repeat(60)}${'x'.repeat(100)}`), 80);
    expect(wrap.hang).toBeLessThanOrEqual(Math.floor(80 * 0.4));
    expect(wrap.rows.length).toBeGreaterThan(1);
  });

  it('breaks a long word at the column limit when there is no better place', () => {
    const wrap = wrapCodeLine(prepared('x'.repeat(100)), 30);
    expect(flat(wrap.rows).map((r) => r.length)).toEqual([30, 28, 28, 14]);
  });

  it('keeps the colour of every token across a cut', () => {
    const tokens = [
      { t: 'return ', c: '#f00', s: 0 },
      { t: 'someVeryLongFunctionName', c: '#0f0', s: 0 },
      { t: '(argumentNumberOne, argumentNumberTwo);', c: '#00f', s: 0 },
    ];
    const wrap = wrapCodeLine(prepareTokens(tokens), 30);
    const colours = wrap.rows.flatMap((r) => r.tokens.map((t) => t.c));
    expect(colours).toContain('#f00');
    expect(colours).toContain('#0f0');
    expect(colours).toContain('#00f');
    expect(wrap.rows[0]?.tokens[0]?.c).toBe('#f00');
  });

  it('reports each row length without the spaces at its end', () => {
    const wrap = wrapCodeLine(prepared('aaaa bbbb cccc dddd eeee ffff'), 10);
    for (const r of wrap.rows) expect(r.length).toBeLessThanOrEqual(10);
    expect(wrap.rows[0]?.length).toBe(9);
  });
});

describe('dimming', () => {
  it('keeps lines outside the focus easy to read', () => {
    expect(DIM_OPACITY).toBeGreaterThanOrEqual(0.45);
    expect(DIM_OPACITY).toBeLessThanOrEqual(0.55);
  });
});
