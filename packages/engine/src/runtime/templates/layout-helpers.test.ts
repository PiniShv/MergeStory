import { describe, expect, it } from 'vitest';
import type { CodeLine, ResolvedCode } from '../../core/render-plan.ts';
import { panelStarts } from './before-after.ts';
import { focusStarts, planCodeScene } from './code.ts';

describe('panelStarts', () => {
  it('starts "before" on the first beat and "after" on the second', () => {
    const { before, after } = panelStarts([0.45, 1.75]);
    expect(before).toBeCloseTo(0.45, 6);
    expect(after).toBeCloseTo(1.75, 6);
  });

  it('keeps a pause between the panels', () => {
    const { before, after } = panelStarts([0.45, 0.55]);
    expect(after - before).toBeGreaterThanOrEqual(0.9);
  });

  it('brings "after" in on its own when there is only one beat', () => {
    const { before, after } = panelStarts([0.45]);
    expect(after).toBeCloseTo(before + 1.4, 5);
    expect(panelStarts([]).before).toBeGreaterThan(0);
  });
});

describe('focusStarts', () => {
  it('never starts before the earliest time and spaces ranges apart', () => {
    expect(focusStarts([0.1, 0.2, 5])).toEqual([0.5, 1.3, 5]);
  });

  it('keeps well-spaced times as they are', () => {
    expect(focusStarts([1, 3, 6])).toEqual([1, 3, 6]);
  });
});

describe('planCodeScene', () => {
  const line = (n: number, text: string): CodeLine => ({
    kind: 'ctx',
    oldNumber: n,
    newNumber: n,
    tokens: [{ t: text, c: null, s: 0 }],
  });
  const code = (texts: string[]): ResolvedCode => ({
    path: 'src/a.ts',
    language: 'typescript',
    side: 'head',
    masked: false,
    truncated: false,
    lines: texts.map((t, i) => line(i + 1, t)),
  });

  it('lets the window use the whole width when there are no notes', () => {
    const plan = planCodeScene(code(['x'.repeat(40)]), { hasNotes: false, hasCaption: false });
    expect(plan).toMatchObject({ mode: 'wide', maxWidth: 1680, maxHeight: 704 });
  });

  it('keeps a column for the notes when short lines leave room for it', () => {
    const plan = planCodeScene(code(Array(12).fill('const value = compute(argument);')), {
      hasNotes: true,
      hasCaption: false,
    });
    expect(plan.mode).toBe('side');
    expect(plan.maxWidth).toBeLessThan(1680 - 400);
  });

  it('gives the code the whole width when a note column would cost it a smaller font or a wrapped line', () => {
    const wide =
      'export const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 250, maxDelayMs: 4_000 };';
    const plan = planCodeScene(code([wide, 'x', 'y']), { hasNotes: true, hasCaption: false });
    expect(plan).toMatchObject({ mode: 'wide', maxWidth: 1680 });
  });

  it('keeps the window above the caption', () => {
    const plain = planCodeScene(code(['x']), { hasNotes: false, hasCaption: false });
    const captioned = planCodeScene(code(['x']), { hasNotes: false, hasCaption: true });
    expect(captioned.maxHeight).toBeLessThan(plain.maxHeight);
    expect(captioned.maxHeight).toBeLessThanOrEqual(604);
  });
});
