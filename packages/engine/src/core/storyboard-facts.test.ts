import { describe, expect, it } from 'vitest';
import { sampleStoryboard } from '../testing/sample-change.ts';
import {
  BACKING_EVIDENCE_KINDS,
  beatHolders,
  groundedLines,
  isSimulated,
  narrationWords,
  speechSeconds,
  wordBudget,
} from './storyboard-facts.ts';
import { STORYBOARD_LIMITS, type Visual } from './storyboard-schema.ts';

const visualOf = (id: string) => {
  const scene = sampleStoryboard().scenes.find((s) => s.id === id);
  if (!scene) throw new Error(`no scene ${id}`);
  return scene.visual;
};

describe('isSimulated', () => {
  it('is true for terminals, browsers and before-after panels that show a terminal', () => {
    expect(isSimulated(visualOf('s7'))).toBe(true);
    expect(isSimulated(visualOf('s6'))).toBe(true);
  });

  it('is false for visuals that show repository content', () => {
    expect(isSimulated(visualOf('s1'))).toBe(false);
    expect(isSimulated(visualOf('s2'))).toBe(false);
  });
});

describe('beatHolders', () => {
  it('returns the elements that carry a beat', () => {
    expect(beatHolders(visualOf('s7')).map((h) => h.beat)).toEqual([0, 0]);
    expect(beatHolders(visualOf('s6')).length).toBe(3);
  });

  it('gives the boxes of a screenshot, a recording and both panels of a before-after a beat', () => {
    const box = (beat: number) => ({ x: 0, y: 0, w: 0.5, h: 0.5, label: null, beat });
    const picture = { caption: null, highlights: [box(0), box(1)], focus: null };
    expect(beatHolders({ type: 'screenshot', screenshotId: 'SS1', ...picture })).toEqual([box(0), box(1)]);
    expect(
      beatHolders({
        type: 'recording',
        recordingId: 'RC1',
        trim: null,
        speed: null,
        zoom: null,
        ...picture,
      }),
    ).toEqual([box(0), box(1)]);
    const base = visualOf('s6');
    if (base.type !== 'before-after') throw new Error('fixture changed');
    const both = {
      ...base,
      before: { ...base.before, highlights: [box(2)] },
      after: { ...base.after, highlights: [box(3), box(4)] },
    };
    // The three terminal lines of the fixture come first, then the boxes of the before and the after panel.
    expect(beatHolders(both).map((h) => h.beat)).toEqual([0, 0, 0, 2, 3, 4]);
  });

  it('gives a recording no beats and does not call it simulated', () => {
    const clip = {
      type: 'recording' as const,
      recordingId: 'RC1',
      caption: null,
      trim: null,
      speed: null,
      zoom: null,
      highlights: [],
      focus: null,
    };
    expect(beatHolders(clip)).toEqual([]);
    expect(isSimulated(clip)).toBe(false);
  });

  it('gives the steps of a reproduction as the elements that carry a beat, and it is not simulated', () => {
    const visual: Visual = {
      type: 'repro',
      steps: [
        { step: 1, beat: 0 },
        { step: 2, beat: 1 },
      ],
    };
    expect(beatHolders(visual).map((h) => h.beat)).toEqual([0, 1]);
    expect(isSimulated(visual)).toBe(false);
  });

  it('gives the focus of a log a beat each, and does not call a log simulated', () => {
    const log: Visual = {
      type: 'log',
      logId: 'L1',
      startLine: 1,
      endLine: 5,
      focus: [
        { startLine: 2, endLine: 2, note: null, beat: 0 },
        { startLine: 4, endLine: 5, note: 'x', beat: 1 },
      ],
      caption: null,
    };
    expect(beatHolders(log).map((h) => h.beat)).toEqual([0, 1]);
    expect(isSimulated(log)).toBe(false);
  });

  it('returns nothing for visuals without beats', () => {
    expect(beatHolders(visualOf('s1'))).toEqual([]);
  });

  it('lets the caller move a beat in place', () => {
    const visual = visualOf('s7');
    for (const holder of beatHolders(visual)) holder.beat = 3;
    expect(beatHolders(visual).map((h) => h.beat)).toEqual([3, 3]);
  });
});

describe('evidence and narration counts', () => {
  it('counts lines that cite evidence', () => {
    const storyboard = sampleStoryboard();
    const total = storyboard.scenes.reduce((n, s) => n + s.narration.length, 0);
    expect(groundedLines(storyboard)).toBe(total);
    const first = storyboard.scenes[0]!;
    first.narration[0]!.evidence = [];
    expect(groundedLines(storyboard)).toBe(total - 1);
  });

  it('counts the words of all narration, not bare punctuation', () => {
    const storyboard = sampleStoryboard();
    storyboard.scenes = storyboard.scenes.slice(0, 1);
    storyboard.scenes[0]!.narration = [
      { text: 'One two three.', evidence: ['F1'] },
      { text: '— four —', evidence: ['F1'] },
    ];
    expect(narrationWords(storyboard)).toBe(4);
  });

  it('treats a changed file, hunk or symbol as backing evidence', () => {
    expect([...BACKING_EVIDENCE_KINDS]).toEqual(['file', 'hunk', 'symbol']);
  });
});

describe('speaking time', () => {
  it('gives the word budget of a target length at the speaking rate', () => {
    expect(wordBudget(90)).toBe(225);
    expect(wordBudget(90)).toBe(Math.round(90 * STORYBOARD_LIMITS.wordsPerSecond));
  });

  it('is words divided by the speaking rate plus a quarter of a second', () => {
    expect(speechSeconds('one two three four five')).toBeCloseTo(5 / 2.5 + 0.25, 6);
    expect(speechSeconds('')).toBeCloseTo(0.25, 6);
    expect(speechSeconds('  spaced   out  ')).toBeCloseTo(2 / 2.5 + 0.25, 6);
    expect(speechSeconds('... ,')).toBeCloseTo(0.25, 6);
  });
});
