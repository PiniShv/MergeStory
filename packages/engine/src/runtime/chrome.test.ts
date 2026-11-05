import { describe, expect, it } from 'vitest';
import {
  activeCueIndex,
  badgeText,
  CAPTION_FADE_SEC,
  captionAlpha,
  chapterIndexAt,
  chipBudgets,
  progressSegments,
  steppedFill,
} from './chrome.ts';

const chapters = [{ startSec: 0 }, { startSec: 6 }, { startSec: 13.2 }];

describe('chapterIndexAt', () => {
  it('finds the chapter that has started', () => {
    expect(chapterIndexAt(chapters, 0)).toBe(0);
    expect(chapterIndexAt(chapters, 5.99)).toBe(0);
    expect(chapterIndexAt(chapters, 6)).toBe(1);
    expect(chapterIndexAt(chapters, 40)).toBe(2);
  });

  it('counts time before the first chapter as the first chapter', () => {
    expect(chapterIndexAt([{ startSec: 2 }, { startSec: 8 }], 0.5)).toBe(0);
  });

  it('copes with no chapters', () => {
    expect(chapterIndexAt([], 3)).toBe(0);
  });
});

describe('captions', () => {
  const cues = [
    { startSec: 1, endSec: 3, text: 'one' },
    { startSec: 3, endSec: 5, text: 'two' },
    { startSec: 8, endSec: 9, text: 'three' },
  ];

  it('picks the cue showing at a time', () => {
    expect(activeCueIndex(cues, 0.5)).toBe(-1);
    expect(activeCueIndex(cues, 1)).toBe(0);
    expect(activeCueIndex(cues, 2.99)).toBe(0);
    expect(activeCueIndex(cues, 3)).toBe(1);
    expect(activeCueIndex(cues, 6)).toBe(-1);
    expect(activeCueIndex(cues, 8.5)).toBe(2);
  });

  it('prefers the latest cue when two overlap', () => {
    expect(
      activeCueIndex(
        [
          { startSec: 0, endSec: 5, text: 'a' },
          { startSec: 2, endSec: 4, text: 'b' },
        ],
        3,
      ),
    ).toBe(1);
  });

  it('fades over 0.15 s at both ends and is solid in between', () => {
    const cue = cues[0]!;
    expect(CAPTION_FADE_SEC).toBe(0.15);
    expect(captionAlpha(cue, 1)).toBe(0);
    expect(captionAlpha(cue, 1.075)).toBeCloseTo(0.5, 5);
    expect(captionAlpha(cue, 2)).toBe(1);
    expect(captionAlpha(cue, 2.925)).toBeCloseTo(0.5, 5);
    expect(captionAlpha(cue, 3)).toBe(0);
  });
});

describe('progress bar', () => {
  it('splits the video into chapter segments that cover it', () => {
    const segments = progressSegments(chapters, 20);
    expect(segments).toHaveLength(3);
    expect(segments[0]!.startSec).toBe(0);
    expect(segments[1]!.startSec).toBe(6);
    expect(segments[2]!.endSec).toBe(20);
    for (let i = 1; i < segments.length; i++) expect(segments[i]!.startSec).toBe(segments[i - 1]!.endSec);
  });

  it('starts the first segment at 0 even when the first chapter starts later', () => {
    expect(progressSegments([{ startSec: 1.5 }, { startSec: 9 }], 20)[0]!.startSec).toBe(0);
  });

  it('uses one segment when there are no chapters', () => {
    expect(progressSegments([], 30)).toEqual([{ startSec: 0, endSec: 30, steps: 20 }]);
  });

  it('keeps steps between 4 and 20', () => {
    for (const segment of progressSegments([{ startSec: 0 }, { startSec: 1 }, { startSec: 100 }], 300)) {
      expect(segment.steps).toBeGreaterThanOrEqual(4);
      expect(segment.steps).toBeLessThanOrEqual(20);
    }
  });

  it('fills in whole steps, so only a few distinct values occur', () => {
    const segment = { startSec: 0, endSec: 10, steps: 20 };
    const values = new Set<number>();
    for (let t = -1; t <= 11; t += 1 / 30) values.add(steppedFill(t, segment));
    expect(values.size).toBeLessThanOrEqual(21);
    expect(steppedFill(-1, segment)).toBe(0);
    expect(steppedFill(10, segment)).toBe(1);
    expect(steppedFill(11, segment)).toBe(1);
    expect(steppedFill(4.99, segment)).toBe(0.45);
  });

  it('never goes backwards', () => {
    const segment = { startSec: 2, endSec: 9, steps: 17 };
    let last = 0;
    for (let t = 0; t <= 10; t += 0.01) {
      const fill = steppedFill(t, segment);
      expect(fill).toBeGreaterThanOrEqual(last);
      last = fill;
    }
  });
});

describe('badgeText', () => {
  it('uses the plan text, or a default for the kind', () => {
    expect(badgeText({ kind: 'reported', text: 'Reported by caller' })).toBe('Reported by caller');
    expect(badgeText({ kind: 'simulated', text: '  ' })).toBe('Simulated UI');
    expect(badgeText({ kind: 'actual', text: '' })).toBe('Actual screenshot');
    expect(badgeText({ kind: 'masked', text: '' })).toBe('Secrets masked');
    expect(badgeText({ kind: 'reported', text: '' })).toBe('Reported by caller');
  });
});

describe('chipBudgets', () => {
  it('keeps every character when the chips fit together', () => {
    expect(chipBudgets([20, 30, 40], 120)).toEqual([20, 30, 40]);
  });

  it('gives the room short chips do not need to the long ones', () => {
    expect(chipBudgets([12, 60, 60], 100)).toEqual([12, 44, 44]);
    expect(chipBudgets([10, 10, 100], 80)).toEqual([10, 10, 60]);
  });

  it('shares equally when all chips are long', () => {
    expect(chipBudgets([80, 80, 80], 90)).toEqual([30, 30, 30]);
  });

  it('copes with no chips and no room', () => {
    expect(chipBudgets([], 50)).toEqual([]);
    expect(chipBudgets([10, 20], 0)).toEqual([0, 0]);
  });
});
