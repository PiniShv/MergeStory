import { describe, expect, it } from 'vitest';
import type { Scene, Storyboard } from '../core/storyboard-schema.ts';
import { createSilentProvider, synthesizeNarration } from '../narration/index.ts';
import { testContext } from '../testing/context.ts';
import { sampleStoryboard } from '../testing/sample-change.ts';
import { buildTimeline } from '../visuals/timeline.ts';
import { describeFit, estimateVideoSeconds, fitToMaxDuration } from './fit-duration.ts';

const OPTIONS = { language: 'en', maskEmails: true };
const BACKING = new Set(['F1', 'F2', 'F2.H1', 'S1']);

function trimTo(storyboard: Storyboard, maxSec: number, backingEvidence: ReadonlySet<string> = BACKING) {
  return fitToMaxDuration(storyboard, { ...OPTIONS, maxSec, backingEvidence });
}

const line = (text: string, evidence: string[] = ['PR']) => ({ text, evidence });
const SENTENCE =
  'The retry module wraps the existing HTTP layer and sends one more request after a short delay.';

/** A scene with the given number of lines and a summary visual whose points sit on the last line. */
function scene(id: string, role: Scene['role'], lines: number, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    role,
    title: `Scene ${id}`,
    narration: Array.from({ length: lines }, () => line(SENTENCE)),
    visual: {
      type: 'summary',
      points: [
        { text: 'first point', beat: 0 },
        { text: 'last point', beat: lines - 1 },
      ],
      closing: null,
    },
    visualDescription: 'A summary',
    transition: 'fade',
    targetSeconds: null,
    ...overrides,
  };
}

function board(scenes: Scene[]): Storyboard {
  return { ...sampleStoryboard(), scenes };
}

const roles = (storyboard: Storyboard) => storyboard.scenes.map((s) => s.role);

describe('estimateVideoSeconds', () => {
  it('is the length that --tts none produces, so the guarantee is exact for it', async () => {
    const storyboard = sampleStoryboard();
    const ctx = testContext({
      config: { tts: { provider: 'none' } },
      home: '/nonexistent/run',
      runDir: '/nonexistent/run',
    }).ctx;
    const narration = await synthesizeNarration(storyboard, createSilentProvider(), ctx);
    expect(estimateVideoSeconds(storyboard, OPTIONS)).toBe(buildTimeline(storyboard, narration).durationSec);
  });

  it('counts the title, the pauses and the end card, not only the words', () => {
    const storyboard = board([scene('a', 'mission', 1), scene('b', 'review', 1)]);
    const words = storyboard.scenes.reduce(
      (n, s) => n + s.narration.reduce((m, l) => m + l.text.split(' ').length, 0),
      0,
    );
    expect(estimateVideoSeconds(storyboard, OPTIONS)).toBeGreaterThan(words / 2.5 + 3.5);
  });
});

describe('fitToMaxDuration', () => {
  it('returns the storyboard it was given when it already fits', () => {
    const storyboard = sampleStoryboard();
    const result = trimTo(storyboard, 600);
    expect(result.storyboard).toBe(storyboard);
    expect(result).toMatchObject({ droppedScenes: [], droppedLines: 0, fits: true });
    expect(result.afterSec).toBe(result.beforeSec);
    expect(describeFit(result, 600)).toEqual([]);
  });

  it('never changes the storyboard it was given', () => {
    const storyboard = sampleStoryboard();
    const copy = structuredClone(storyboard);
    trimTo(storyboard, 20);
    expect(storyboard).toEqual(copy);
  });

  it('drops the wrap-up first, whole, when its single line cannot be shortened', () => {
    const storyboard = sampleStoryboard();
    const whole = estimateVideoSeconds(storyboard, OPTIONS);
    const result = trimTo(storyboard, whole - 1);
    expect(result.droppedScenes.map((s) => s.id)).toEqual(['s8']);
    expect(result.storyboard.scenes).toHaveLength(storyboard.scenes.length - 1);
    expect(result.afterSec).toBeLessThanOrEqual(whole - 1);
    expect(result.fits).toBe(true);
  });

  it('then drops the overview, then the code scenes from the last to the first', () => {
    const storyboard = board([
      scene('m', 'mission', 1),
      scene('a', 'big-picture', 1),
      scene('c1', 'under-the-hood', 1),
      scene('c2', 'under-the-hood', 1),
      scene('c3', 'before-after', 1),
      scene('r', 'review', 1),
      scene('w', 'conclusion', 1),
    ]);
    const result = trimTo(storyboard, 1);
    expect(result.droppedScenes.map((s) => s.id)).toEqual(['w', 'a', 'c3', 'c2', 'c1']);
    expect(roles(result.storyboard)).toEqual(['mission', 'review']);
  });

  it('never drops the mission or the review scene, and says so when the limit cannot be reached', () => {
    const storyboard = sampleStoryboard();
    const result = trimTo(storyboard, 1);
    expect(result.fits).toBe(false);
    expect(new Set(roles(result.storyboard))).toEqual(new Set(['mission', 'review']));
    for (const s of result.storyboard.scenes) expect(s.narration.length).toBe(1);
    const [message] = describeFit(result, 1);
    expect(message).toContain('over the maximum of 1 s (--max-duration)');
    expect(message).toContain('never dropped');
    expect(message).toContain('cannot be reached');
    // The result still says what the shortest storyboard is estimated at.
    expect(result.afterSec).toBeCloseTo(estimateVideoSeconds(result.storyboard, OPTIONS), 5);
  });

  it('shortens a scene instead of dropping it when that is enough', () => {
    const storyboard = board([
      scene('m', 'mission', 1),
      scene('c', 'under-the-hood', 3),
      scene('r', 'review', 1),
      scene('w', 'conclusion', 4),
    ]);
    const whole = estimateVideoSeconds(storyboard, OPTIONS);
    const oneLine = estimateVideoSeconds(
      board([
        scene('m', 'mission', 1),
        scene('c', 'under-the-hood', 3),
        scene('r', 'review', 1),
        scene('w', 'conclusion', 1),
      ]),
      OPTIONS,
    );
    // Dropping three lines of the wrap-up is enough, so the wrap-up stays.
    const result = trimTo(storyboard, oneLine + 0.1);
    expect(whole).toBeGreaterThan(oneLine + 0.1);
    expect(result.droppedScenes).toEqual([]);
    expect(result.droppedLines).toBeGreaterThan(0);
    expect(result.storyboard.scenes.map((s) => s.id)).toEqual(['m', 'c', 'r', 'w']);
    expect(result.storyboard.scenes[3]?.narration.length).toBeLessThan(4);
    expect(result.storyboard.scenes[2]?.narration.length).toBe(1);
    expect(result.fits).toBe(true);
  });

  it('moves the elements that sat on a dropped line to the last line that is left', () => {
    const storyboard = board([
      scene('m', 'mission', 1),
      scene('w', 'conclusion', 4),
      scene('r', 'review', 1),
    ]);
    const result = trimTo(storyboard, estimateVideoSeconds(storyboard, OPTIONS) - 8);
    const wrap = result.storyboard.scenes.find((s) => s.id === 'w');
    expect(wrap).toBeDefined();
    if (wrap?.visual.type !== 'summary') throw new Error('expected a summary');
    const last = (wrap.narration.length ?? 1) - 1;
    expect(wrap.narration.length).toBeLessThan(4);
    for (const point of wrap.visual.points) expect(point.beat).toBeLessThanOrEqual(last);
    expect(wrap.visual.points[1]?.beat).toBe(last);
  });

  it('keeps a simulated scene backed by a changed file, hunk or symbol', () => {
    const terminal = (id: string, first: string, second: string): Scene =>
      scene(id, 'under-the-hood', 2, {
        narration: [line(SENTENCE, [first]), line(SENTENCE, [second])],
        visual: {
          type: 'terminal',
          title: 'npm test',
          lines: [{ kind: 'command', text: 'npm test', beat: 1 }],
        },
      });
    const wrapped = (shown: Scene) => board([scene('m', 'mission', 1), shown, scene('r', 'review', 1)]);

    // The first line only cites a test result: the line that cites the file must stay, so the scene goes whole.
    const unbacked = trimTo(wrapped(terminal('t', 'T1', 'F2.H1')), 1);
    expect(unbacked.droppedScenes.map((s) => s.id)).toEqual(['t']);

    // The first line cites the file: the second line can go, and the scene stays while that is enough.
    const backed = wrapped(terminal('t', 'F2.H1', 'T1'));
    const oneLine = estimateVideoSeconds(
      wrapped({ ...terminal('t', 'F2.H1', 'T1'), narration: [line(SENTENCE, ['F2.H1'])] }),
      OPTIONS,
    );
    const shortened = trimTo(backed, oneLine + 0.05);
    expect(shortened.droppedScenes).toEqual([]);
    expect(shortened.storyboard.scenes[1]?.narration).toHaveLength(1);
  });

  it('keeps the two scenes that every storyboard needs, even when neither is protected', () => {
    const storyboard = board([scene('a', 'conclusion', 3), scene('b', 'big-picture', 3)]);
    const result = trimTo(storyboard, 1);
    expect(result.storyboard.scenes).toHaveLength(2);
    expect(result.storyboard.scenes.map((s) => s.narration.length)).toEqual([1, 1]);
    expect(result.fits).toBe(false);
  });

  it('gives up the scene length hints before it gives up any content', () => {
    const stretched = board([
      scene('m', 'mission', 1, { targetSeconds: 40 }),
      scene('c', 'under-the-hood', 1, { targetSeconds: 40 }),
      scene('r', 'review', 1),
    ]);
    const natural = estimateVideoSeconds(
      board([scene('m', 'mission', 1), scene('c', 'under-the-hood', 1), scene('r', 'review', 1)]),
      OPTIONS,
    );
    expect(estimateVideoSeconds(stretched, OPTIONS)).toBeGreaterThan(natural);
    const result = trimTo(stretched, natural + 0.01);
    expect(result.droppedScenes).toEqual([]);
    expect(result.droppedLines).toBe(0);
    expect(result.storyboard.scenes.every((s) => s.targetSeconds === null)).toBe(true);
    expect(result.fits).toBe(true);
  });

  it('accounts for every scene and line once, whatever the limit is', () => {
    const storyboard = board([
      scene('m', 'mission', 3),
      scene('a', 'big-picture', 2),
      scene('c1', 'under-the-hood', 4),
      scene('c2', 'before-after', 2),
      scene('r', 'review', 3),
      scene('w', 'conclusion', 3),
    ]);
    const whole = estimateVideoSeconds(storyboard, OPTIONS);
    const total = (b: Storyboard) => b.scenes.reduce((n, s) => n + s.narration.length, 0);
    for (let limit = 1; limit < whole; limit += 3) {
      const result = trimTo(storyboard, limit);
      const kept = new Set(result.storyboard.scenes.map((s) => s.id));
      // The scenes that were dropped and the scenes that were kept are the scenes there were.
      expect(
        result.droppedScenes.map((s) => s.id).filter((id) => kept.has(id)),
        String(limit),
      ).toEqual([]);
      expect(result.droppedScenes.length + kept.size).toBe(storyboard.scenes.length);
      // Lines that went with a dropped scene are not counted again as dropped lines.
      const keptBefore = storyboard.scenes
        .filter((s) => kept.has(s.id))
        .reduce((n, s) => n + s.narration.length, 0);
      expect(result.droppedLines, String(limit)).toBe(keptBefore - total(result.storyboard));
      for (const s of result.storyboard.scenes) expect(s.narration.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('stops as soon as the estimate fits', () => {
    const storyboard = sampleStoryboard();
    const whole = estimateVideoSeconds(storyboard, OPTIONS);
    for (const cut of [2, 6, 12, 20]) {
      const result = trimTo(storyboard, whole - cut);
      expect(result.afterSec).toBeLessThanOrEqual(whole - cut);
      expect(result.fits).toBe(true);
    }
  });
});

describe('describeFit', () => {
  const storyboard = board([scene('m', 'mission', 2), scene('w', 'conclusion', 1), scene('r', 'review', 1)]);

  it('names what was left out, for rendering', () => {
    const [message] = describeFit(trimTo(storyboard, 20), 20);
    expect(message).toMatch(
      /^The storyboard is estimated at \d+ s, over the maximum of 20 s \(--max-duration\)\./,
    );
    expect(message).toContain('Left out to shorten it: the scene "Scene w"');
    expect(message).toMatch(/It is now estimated at \d+ s\./);
  });

  it('says what rendering would leave out, for validate', () => {
    const [message] = describeFit(trimTo(storyboard, 20), 20, 'would');
    expect(message).toContain('Rendering would leave out the scene "Scene w"');
    expect(message).not.toContain('Left out');
  });

  it('lists several scenes and lines in plain words', () => {
    const many = board([
      scene('m', 'mission', 1),
      scene('a', 'big-picture', 1),
      scene('c', 'under-the-hood', 2),
      scene('w', 'conclusion', 1),
      scene('r', 'review', 1),
    ]);
    const [message] = describeFit(trimTo(many, 1), 1);
    expect(message).toContain('the scenes "Scene w", "Scene a" and "Scene c"');
  });
});
