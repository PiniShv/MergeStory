import { describe, expect, it } from 'vitest';
import { buildFixture, tinyFixture } from '../testing/storyboard-fixtures.ts';
import {
  changedLinesAt,
  diffViewSpan,
  fitDiffRange,
  hunkLines,
  hunkOverlaps,
  hunkTouches,
  overlapsAnyHunk,
  shrinkRange,
} from './diff-view.ts';
import { STORYBOARD_LIMITS } from './storyboard-schema.ts';
import type { DiffHunk } from './types.ts';

const MAX = STORYBOARD_LIMITS.maxCodeLines;

/** A function whose 14 body lines are all replaced: 16 lines at each side, 30 rows in a diff view. */
function swapFile() {
  const body = (tag: string): string[] => Array.from({ length: 14 }, (_, i) => `const ${tag}${i} = ${i};`);
  const fx = buildFixture({
    source: 'local',
    pr: null,
    files: [
      {
        path: 'src/a.ts',
        base: ['export function swap(): void {', ...body('old'), '}'],
        head: ['export function swap(): void {', ...body('new'), '}'],
        component: 'app',
      },
    ],
    components: [{ key: 'app', name: 'app', path: 'src', kind: 'module' }],
  });
  return fx.changeSet.files[0]!;
}

describe('diffViewSpan', () => {
  it('counts the lines in range and the removed lines next to them', () => {
    const file = tinyFixture().changeSet.files[0]!;
    // Three lines at head and one removed line between them.
    expect(diffViewSpan(file, 'head', 1, 3)?.length).toBe(4);
    expect(diffViewSpan(file, 'head', 50, 60)?.length).toBeUndefined();
  });

  it('counts the removed lines of a range of only sixteen lines, which is why the range may not fit', () => {
    const file = swapFile();
    expect(diffViewSpan(file, 'head', 1, 16)?.length).toBe(30);
    expect(diffViewSpan(file, 'base', 1, 16)?.length).toBe(30);
  });

  it('counts fewer rows for a shorter range', () => {
    const file = swapFile();
    expect(diffViewSpan(file, 'head', 1, 4)?.length).toBe(18);
    expect(diffViewSpan(file, 'head', 1, 3)?.length).toBe(17);
  });

  it('is null for a range that no hunk touches', () => {
    const file = swapFile();
    expect(diffViewSpan(file, 'head', 40, 50)?.length).toBeUndefined();
  });
});

describe('fitDiffRange', () => {
  it('shortens the range at the end that is farther from the lines to keep', () => {
    const file = swapFile();
    const fitted = fitDiffRange(file, 'head', 1, 16, [1, 3], MAX);
    expect(fitted).toEqual([1, 4]);
    expect(diffViewSpan(file, 'head', fitted![0], fitted![1])?.length).toBeLessThanOrEqual(MAX);
  });

  it('shortens the top when the lines to keep are at the bottom', () => {
    const file = swapFile();
    const fitted = fitDiffRange(file, 'head', 1, 16, [14, 16], MAX);
    expect(fitted).not.toBeNull();
    expect(fitted![0]).toBeGreaterThan(1);
    expect(fitted![1]).toBe(16);
    expect(diffViewSpan(file, 'head', fitted![0], fitted![1])?.length).toBeLessThanOrEqual(MAX);
  });

  it('never cuts into the lines to keep', () => {
    const file = swapFile();
    for (const keep of [
      [1, 1],
      [2, 6],
      [8, 9],
      [15, 16],
    ] as const) {
      const fitted = fitDiffRange(file, 'head', 1, 16, keep, MAX);
      if (fitted === null) continue;
      expect(fitted[0]).toBeLessThanOrEqual(keep[0]);
      expect(fitted[1]).toBeGreaterThanOrEqual(keep[1]);
    }
  });

  it('gives up when the lines to keep need more rows than fit', () => {
    const file = swapFile();
    expect(fitDiffRange(file, 'head', 1, 16, [2, 16], MAX)).toBeNull();
  });

  it('returns the range unchanged when it already fits', () => {
    const file = tinyFixture().changeSet.files[0]!;
    expect(fitDiffRange(file, 'head', 1, 3, [1, 1], MAX)).toEqual([1, 3]);
  });
});

/** A hunk that removes one line (old line 5) and adds none: it has no lines at head. */
const pureDeletion: DiffHunk = {
  id: 'h1',
  oldStart: 5,
  oldLines: 1,
  newStart: 4,
  newLines: 0,
  header: '',
  lines: [{ kind: 'del', oldLine: 5, newLine: null, text: 'gone' }],
};

describe('hunk predicates', () => {
  it('reads the start and count at one side', () => {
    expect(hunkLines(pureDeletion, 'base')).toEqual({ start: 5, count: 1 });
    expect(hunkLines(pureDeletion, 'head')).toEqual({ start: 4, count: 0 });
  });

  it('hunkOverlaps needs lines of the hunk at that side inside the range', () => {
    expect(hunkOverlaps(pureDeletion, 'base', 5, 9)).toBe(true);
    expect(hunkOverlaps(pureDeletion, 'base', 6, 9)).toBe(false);
    expect(hunkOverlaps(pureDeletion, 'head', 1, 10)).toBe(false);
  });

  it('hunkTouches also counts the point between lines where a one-sided hunk sits', () => {
    expect(hunkTouches(pureDeletion, 'head', 5, 9)).toBe(true);
    expect(hunkTouches(pureDeletion, 'head', 6, 9)).toBe(false);
    expect(hunkTouches(pureDeletion, 'head', 1, 3)).toBe(false);
    expect(hunkTouches(pureDeletion, 'base', 6, 9)).toBe(false);
  });

  it('overlapsAnyHunk asks every hunk of the file', () => {
    const file = tinyFixture().changeSet.files[0]!;
    expect(overlapsAnyHunk(file, 'head', 1, 3)).toBe(true);
    expect(overlapsAnyHunk(file, 'head', 50, 60)).toBe(false);
  });
});

describe('changedLinesAt and shrinkRange', () => {
  it('lists the added lines at head and the removed lines at base', () => {
    const file = swapFile();
    expect(changedLinesAt(file, 'head')).toEqual(Array.from({ length: 14 }, (_, i) => i + 2));
    expect(changedLinesAt(file, 'base')).toEqual(Array.from({ length: 14 }, (_, i) => i + 2));
  });

  it('keeps a short range and centres a long one on the focus line', () => {
    expect(shrinkRange(1, 10, 18, [], null)).toEqual([1, 10]);
    expect(shrinkRange(1, 100, 10, [], 50)).toEqual([46, 55]);
  });
});
