import { describe, expect, it } from 'vitest';
import {
  type Scene,
  STORYBOARD_VERSION,
  type Storyboard,
  type TransitionType,
  VISUAL_TYPES,
  type Visual,
  type VisualType,
} from '../core/storyboard-schema.ts';
import type { NarrationResult } from '../core/types.ts';
import { buildTimeline, MIN_SCENE_SECONDS, TIMELINE_RULES, TRANSITION_SECONDS } from './timeline.ts';

/** Times are rounded to milliseconds, so differences carry floating point noise. */
const EPSILON = 1e-9;

const VISUALS: Record<VisualType, Visual> = {
  title: { type: 'title', kicker: null, heading: 'Heading', subheading: null, chips: [] },
  mission: { type: 'mission', problem: 'p', goal: 'g', points: [] },
  files: { type: 'files', highlightPaths: [], caption: null },
  architecture: { type: 'architecture', direction: 'LR', nodes: [], edges: [] },
  flow: { type: 'flow', actors: [], steps: [] },
  code: {
    type: 'code',
    ref: { path: 'a.ts', side: 'head', startLine: 1, endLine: 2 },
    mode: 'snippet',
    focus: [],
    caption: null,
  },
  'before-after': {
    type: 'before-after',
    before: {
      label: 'Before',
      kind: 'bullets',
      codeRef: null,
      bullets: ['a'],
      terminal: [],
      screenshotId: null,
    },
    after: {
      label: 'After',
      kind: 'bullets',
      codeRef: null,
      bullets: ['b'],
      terminal: [],
      screenshotId: null,
    },
    caption: null,
  },
  terminal: { type: 'terminal', title: 't', lines: [] },
  browser: { type: 'browser', url: '/x', pageTitle: 'x', blocks: [] },
  checklist: { type: 'checklist', items: [] },
  bullets: { type: 'bullets', heading: null, items: [] },
  screenshot: { type: 'screenshot', screenshotId: 'SS1', caption: null },
  summary: { type: 'summary', points: [], closing: null },
};

function scene(
  id: string,
  type: VisualType,
  lines: number,
  transition: TransitionType = 'fade',
  targetSeconds: number | null = null,
): Scene {
  return {
    id,
    role: 'mission',
    title: id,
    narration: Array.from({ length: lines }, (_, i) => ({ text: `Line ${i} of scene ${id}`, evidence: [] })),
    visual: VISUALS[type],
    visualDescription: '',
    transition,
    targetSeconds,
  };
}

function storyboard(scenes: Scene[]): Storyboard {
  return {
    version: STORYBOARD_VERSION,
    title: 't',
    summary: 's',
    style: 'hybrid',
    language: 'en',
    scenes,
    reviewChecklist: [],
    uncertainties: [],
  };
}

/** Every beat lasts `seconds`, except where `overrides` ("scene#beat") say otherwise. */
function narrationFor(
  board: Storyboard,
  seconds: number,
  overrides: Record<string, number> = {},
): NarrationResult {
  return {
    provider: 'none',
    voice: null,
    clips: board.scenes.flatMap((s) =>
      s.narration.map((line, beatIndex) => ({
        sceneId: s.id,
        beatIndex,
        text: line.text,
        spokenText: line.text,
        audioPath: null,
        durationSec: overrides[`${s.id}#${beatIndex}`] ?? seconds,
        cached: false,
      })),
    ),
  };
}

describe('buildTimeline', () => {
  it('starts the first scene at 0 with a 1.5 s lead-in and no transition', () => {
    const board = storyboard([scene('a', 'title', 1, 'zoom'), scene('b', 'bullets', 1)]);
    const timeline = buildTimeline(board, narrationFor(board, 3));
    expect(timeline.scenes[0]?.startSec).toBe(0);
    expect(timeline.scenes[0]?.transitionSec).toBe(0);
    expect(timeline.scenes[0]?.beats[0]?.startSec).toBe(1.5);
  });

  it('uses a 0.6 s lead-in for later scenes, and never less than their transition', () => {
    const board = storyboard([
      scene('a', 'title', 1),
      scene('fade', 'bullets', 1, 'fade'),
      scene('slide', 'bullets', 1, 'slide'),
      scene('zoom', 'bullets', 1, 'zoom'),
      scene('wipe', 'bullets', 1, 'wipe'),
      scene('none', 'bullets', 1, 'none'),
    ]);
    const timeline = buildTimeline(board, narrationFor(board, 3));
    for (const s of timeline.scenes.slice(1)) {
      const transition = s.transitionSec;
      const leadIn = (s.beats[0]?.startSec ?? 0) - s.startSec;
      expect(leadIn).toBeCloseTo(Math.max(TIMELINE_RULES.leadInSec, transition), 5);
      expect(leadIn).toBeGreaterThanOrEqual(transition - EPSILON);
    }
    expect(timeline.scenes.map((s) => s.transitionSec)).toEqual([0, 0.5, 0.6, 0.6, 0.7, 0]);
  });

  it('puts 0.35 s between beats and keeps a 0.9 s tail after the last one', () => {
    const board = storyboard([scene('a', 'bullets', 3)]);
    const timeline = buildTimeline(board, narrationFor(board, 4, { 'a#1': 5 }));
    const beats = timeline.scenes[0]!.beats;
    expect(beats.map((b) => b.durationSec)).toEqual([4, 5, 4]);
    expect(beats[1]!.startSec - (beats[0]!.startSec + beats[0]!.durationSec)).toBeCloseTo(0.35, 5);
    expect(beats[2]!.startSec - (beats[1]!.startSec + beats[1]!.durationSec)).toBeCloseTo(0.35, 5);
    const last = beats[2]!;
    expect(timeline.scenes[0]!.durationSec).toBeCloseTo(last.startSec + last.durationSec + 0.9, 5);
  });

  it('never makes a scene shorter than its visual type needs', () => {
    for (const type of VISUAL_TYPES) {
      const board = storyboard([scene('a', type, 1)]);
      const timeline = buildTimeline(board, narrationFor(board, 0.5));
      expect(timeline.scenes[0]?.durationSec, type).toBe(MIN_SCENE_SECONDS[type]);
    }
    expect(MIN_SCENE_SECONDS).toMatchObject({
      title: 4,
      code: 6,
      architecture: 7,
      flow: 7,
      files: 5,
      mission: 4.5,
      bullets: 4.5,
      summary: 4.5,
    });
  });

  it('lets long narration set the scene length', () => {
    const board = storyboard([scene('a', 'title', 2)]);
    const timeline = buildTimeline(board, narrationFor(board, 6));
    expect(timeline.scenes[0]?.durationSec).toBeCloseTo(1.5 + 6 + 0.35 + 6 + 0.9, 5);
  });

  it('starts each scene as many seconds before the previous one ends as its transition lasts', () => {
    const transitions: TransitionType[] = ['fade', 'slide', 'zoom', 'wipe', 'none'];
    const board = storyboard(transitions.map((t, i) => scene(`s${i}`, 'bullets', 1, t)));
    const timeline = buildTimeline(board, narrationFor(board, 2));
    for (let i = 1; i < timeline.scenes.length; i++) {
      const previous = timeline.scenes[i - 1]!;
      const current = timeline.scenes[i]!;
      expect(current.transitionSec).toBe(TRANSITION_SECONDS[transitions[i]!]);
      expect(current.startSec).toBeCloseTo(
        previous.startSec + previous.durationSec - current.transitionSec,
        5,
      );
    }
  });

  it('never lets the voice of one scene run into the next scene', () => {
    const board = storyboard([
      scene('a', 'bullets', 2),
      scene('b', 'bullets', 2, 'wipe'),
      scene('c', 'code', 3, 'zoom'),
    ]);
    const timeline = buildTimeline(board, narrationFor(board, 3.3));
    for (let i = 1; i < timeline.scenes.length; i++) {
      const previousBeats = timeline.scenes[i - 1]!.beats;
      const lastBeat = previousBeats[previousBeats.length - 1]!;
      const next = timeline.scenes[i]!;
      expect(next.beats[0]!.startSec).toBeGreaterThanOrEqual(lastBeat.startSec + lastBeat.durationSec);
      // The incoming scene is fully visible before its first beat is spoken.
      expect(next.beats[0]!.startSec - next.startSec).toBeGreaterThanOrEqual(next.transitionSec - EPSILON);
    }
  });

  it('honours targetSeconds when longer, by at most 50%', () => {
    const board = storyboard([
      scene('shorter', 'bullets', 1, 'fade', 2),
      scene('longer', 'bullets', 1, 'fade', 6),
      scene('too-long', 'bullets', 1, 'fade', 60),
    ]);
    const timeline = buildTimeline(board, narrationFor(board, 1));
    const natural = 4.5; // the minimum for a bullets scene dominates one short beat
    expect(timeline.scenes[0]?.durationSec).toBe(natural);
    expect(timeline.scenes[1]?.durationSec).toBe(6);
    expect(timeline.scenes[2]?.durationSec).toBeCloseTo(natural * 1.5, 5);
  });

  it('adds a 3.5 s end card that overlaps the last scene by 0.5 s', () => {
    const board = storyboard([scene('a', 'title', 1), scene('b', 'summary', 1)]);
    const timeline = buildTimeline(board, narrationFor(board, 3));
    const last = timeline.scenes[1]!;
    expect(timeline.outro.durationSec).toBe(3.5);
    expect(timeline.outro.startSec).toBeCloseTo(last.startSec + last.durationSec - 0.5, 5);
    expect(timeline.durationSec).toBeCloseTo(timeline.outro.startSec + 3.5, 5);
  });

  it('estimates the length of a beat that has no narration clip', () => {
    const board = storyboard([scene('a', 'bullets', 1)]);
    const timeline = buildTimeline(board, { provider: 'none', voice: null, clips: [] });
    const beat = timeline.scenes[0]!.beats[0]!;
    expect(beat.durationSec).toBeGreaterThanOrEqual(1.2);
    expect(Number.isFinite(timeline.durationSec)).toBe(true);
  });

  it('handles a scene without narration and an empty storyboard', () => {
    const board = storyboard([scene('a', 'title', 0)]);
    const timeline = buildTimeline(board, narrationFor(board, 3));
    expect(timeline.scenes[0]?.beats).toEqual([]);
    expect(timeline.scenes[0]?.durationSec).toBe(4);
    const empty = buildTimeline(storyboard([]), { provider: 'none', voice: null, clips: [] });
    expect(empty.scenes).toEqual([]);
    expect(empty.durationSec).toBe(3.5);
  });
});
