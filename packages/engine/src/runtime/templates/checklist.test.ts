import { describe, expect, it } from 'vitest';
import {
  type CardMeasure,
  checklistLevels,
  cutTitles,
  DENSE_LEVELS,
  GRID_LEVELS,
  LIST_LEVELS,
  type Measure,
  pickLevel,
} from './checklist.ts';

const ok = (title: string): CardMeasure => ({
  title,
  clamps: [{ scrollHeight: 60, clientHeight: 60 }],
  content: 100,
  inner: 100,
});
const clamped = (title: string): CardMeasure => ({
  ...ok(title),
  clamps: [{ scrollHeight: 90, clientHeight: 60 }],
});
const overflowing = (title: string): CardMeasure => ({ ...ok(title), content: 140 });
const measure = (cards: CardMeasure[], listOverflow = false): Measure => ({ cards, listOverflow });

describe('checklist levels', () => {
  it('chooses the table by item count', () => {
    expect(checklistLevels(1)).toBe(LIST_LEVELS);
    expect(checklistLevels(3)).toBe(LIST_LEVELS);
    expect(checklistLevels(4)).toBe(GRID_LEVELS);
    expect(checklistLevels(5)).toBe(DENSE_LEVELS);
    expect(checklistLevels(6)).toBe(DENSE_LEVELS);
  });

  it.each([[LIST_LEVELS], [GRID_LEVELS], [DENSE_LEVELS]])(
    'only gets smaller and tighter down the table',
    (levels) => {
      for (let i = 1; i < levels.length; i++) {
        const [a, b] = [levels[i - 1]!, levels[i]!];
        expect(b.title).toBeLessThanOrEqual(a.title);
        expect(b.detail).toBeLessThanOrEqual(a.detail);
        expect(b.pad).toBeLessThanOrEqual(a.pad);
        expect(b.titleLines).toBeGreaterThanOrEqual(a.titleLines);
        expect(b.detailLines).toBeGreaterThanOrEqual(a.detailLines);
      }
    },
  );

  it.each([[LIST_LEVELS], [GRID_LEVELS], [DENSE_LEVELS]])('never goes below a readable size', (levels) => {
    for (const level of levels) {
      expect(level.title).toBeGreaterThanOrEqual(28);
      expect(level.detail).toBeGreaterThanOrEqual(24);
    }
  });
});

describe('cutTitles', () => {
  it('finds nothing when every card fits', () => {
    expect(cutTitles(measure([ok('a'), ok('b')]))).toEqual([]);
  });

  it('names a card whose text is hidden by the line limit', () => {
    expect(cutTitles(measure([ok('a'), clamped('b')]))).toEqual(['b']);
  });

  it('names a card whose content is taller than its box', () => {
    expect(cutTitles(measure([overflowing('a'), ok('b')]))).toEqual(['a']);
  });

  it('allows one pixel of rounding', () => {
    const card = { ...ok('a'), content: 101, clamps: [{ scrollHeight: 61, clientHeight: 60 }] };
    expect(cutTitles(measure([card]))).toEqual([]);
  });

  it('names every item when the list is too tall', () => {
    expect(cutTitles(measure([ok('a'), ok('b')], true))).toEqual(['a', 'b']);
  });
});

describe('pickLevel', () => {
  const levels = ['roomy', 'tight', 'smallest'];

  it('uses the first level that fits', () => {
    const result = pickLevel(levels, (l) => measure([l === 'roomy' ? clamped('a') : ok('a')]));
    expect(result).toEqual({ level: 'tight', cut: [] });
  });

  it('goes to the next level when a card overflows its box', () => {
    const seen: string[] = [];
    const result = pickLevel(levels, (l) => {
      seen.push(l);
      return measure([l === 'smallest' ? ok('a') : overflowing('a')]);
    });
    expect(seen).toEqual(levels);
    expect(result.level).toBe('smallest');
  });

  it('stops measuring after the first fit', () => {
    const seen: string[] = [];
    pickLevel(levels, (l) => {
      seen.push(l);
      return measure([ok('a')]);
    });
    expect(seen).toEqual(['roomy']);
  });

  it('keeps the last level and reports what it cuts when nothing fits', () => {
    const result = pickLevel(levels, () => measure([ok('a'), overflowing('b')]));
    expect(result).toEqual({ level: 'smallest', cut: ['b'] });
  });

  it('refuses an empty table', () => {
    expect(() => pickLevel([], () => measure([]))).toThrow();
  });
});
