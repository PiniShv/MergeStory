import { describe, expect, it } from 'vitest';
import { hunkLimitNote, selectHunkFiles } from './hunk-selection.ts';
import { DEFAULT_SOURCE_LIMITS } from './limits.ts';

const limits = { maxHunkFiles: 3, maxFilePatchLines: 100, maxTotalPatchLines: 150 };

describe('selectHunkFiles', () => {
  it('keeps everything when it fits', () => {
    const result = selectHunkFiles(
      [
        { index: 0, changedLines: 10 },
        { index: 1, changedLines: 20 },
      ],
      limits,
    );
    expect(result.selected).toEqual([0, 1]);
    expect(result.tooLarge.size).toBe(0);
    expect(result.overCap.size).toBe(0);
  });

  it('keeps the files with the most changed lines when there are too many', () => {
    const result = selectHunkFiles(
      [
        { index: 0, changedLines: 5 },
        { index: 1, changedLines: 50 },
        { index: 2, changedLines: 30 },
        { index: 3, changedLines: 40 },
        { index: 4, changedLines: 1 },
      ],
      { ...limits, maxTotalPatchLines: 10_000 },
    );
    expect(result.selected).toEqual([1, 2, 3]);
    expect([...result.overCap].sort()).toEqual([0, 4]);
  });

  it('skips a file that does not fit the line budget but still keeps smaller ones', () => {
    const result = selectHunkFiles(
      [
        { index: 0, changedLines: 90 },
        { index: 1, changedLines: 80 },
        { index: 2, changedLines: 40 },
      ],
      limits,
    );
    // 90 fits, 80 would take the total to 170 (over 150), 40 fits (total 130).
    expect(result.selected).toEqual([0, 2]);
    expect([...result.overCap]).toEqual([1]);
  });

  it('leaves out files that are too large on their own', () => {
    const result = selectHunkFiles(
      [
        { index: 0, changedLines: 101 },
        { index: 1, changedLines: 100 },
      ],
      limits,
    );
    expect(result.selected).toEqual([1]);
    expect([...result.tooLarge]).toEqual([0]);
  });

  it('breaks ties by file order', () => {
    const result = selectHunkFiles(
      [
        { index: 4, changedLines: 7 },
        { index: 2, changedLines: 7 },
        { index: 9, changedLines: 7 },
        { index: 1, changedLines: 7 },
      ],
      limits,
    );
    expect(result.selected).toEqual([1, 2, 4]);
    expect([...result.overCap]).toEqual([9]);
  });
});

describe('hunkLimitNote', () => {
  it('is null when nothing was left out', () => {
    expect(
      hunkLimitNote(2, { selected: [0, 1], tooLarge: new Set(), overCap: new Set() }, DEFAULT_SOURCE_LIMITS),
    ).toBeNull();
  });

  it('explains what was left out', () => {
    const note = hunkLimitNote(
      500,
      { selected: [0], tooLarge: new Set([1]), overCap: new Set([2]) },
      DEFAULT_SOURCE_LIMITS,
    );
    expect(note).toContain('1 of 500');
    expect(note).toContain('more than 5000 changed lines');
  });
});
