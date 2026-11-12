/**
 * Timeline: scene and beat timings from the narration clip lengths.
 *
 * Each scene starts with a short lead-in, speaks its beats with a small gap between them and keeps
 * a quiet tail. A scene is never shorter than its visual needs, and a scene's transition overlaps
 * the end of the previous scene. The branded end card overlaps the last scene by half a second.
 */
import {
  STORYBOARD_LIMITS,
  type Storyboard,
  type TransitionType,
  type VisualType,
} from '../core/storyboard-schema.ts';
import type { NarrationClip, NarrationResult, Timeline, TimelineBeat, TimelineScene } from '../core/types.ts';

export const TIMELINE_RULES = {
  /** Silence before the first beat of the first scene: the title animates in and settles first. */
  firstLeadInSec: 1.5,
  /** Silence before the first beat of every other scene; never shorter than the scene's transition. */
  leadInSec: 0.6,
  /** Pause between two narration beats of one scene. */
  beatGapSec: 0.35,
  /** Quiet time after the last beat of a scene. */
  tailSec: 0.9,
  /** Length of the branded end card. */
  outroSec: 3.5,
  /** How long the end card overlaps the last scene. */
  outroOverlapSec: 0.5,
  /** A scene may be stretched to its target length by at most this factor. */
  maxStretch: 1.5,
} as const;

/** Length of the transition into a scene, by type. */
export const TRANSITION_SECONDS: Record<TransitionType, number> = {
  fade: 0.5,
  slide: 0.6,
  zoom: 0.6,
  wipe: 0.7,
  none: 0,
};

/** Shortest a scene may be, by visual type. Visuals that need time to read are longer. */
export const MIN_SCENE_SECONDS: Record<VisualType, number> = {
  title: 4,
  code: 6,
  architecture: 7,
  flow: 7,
  files: 5,
  mission: 4.5,
  'before-after': 4.5,
  terminal: 4.5,
  browser: 4.5,
  checklist: 4.5,
  bullets: 4.5,
  screenshot: 4.5,
  summary: 4.5,
};

/** Round to milliseconds so floating point noise never reaches the plan. */
const ms = (value: number): number => Math.round(value * 1000) / 1000;

/** Length of a beat when the narration has no clip for it: estimated from the word count. */
function estimatedSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.2, words / STORYBOARD_LIMITS.wordsPerSecond);
}

function clipSeconds(clip: NarrationClip | undefined, text: string): number {
  if (clip && Number.isFinite(clip.durationSec) && clip.durationSec > 0) return clip.durationSec;
  return estimatedSeconds(text);
}

/** Scene and beat timings from narration clip durations (lead-in, gaps, minimum scene length, transitions, outro). */
export function buildTimeline(storyboard: Storyboard, narration: NarrationResult): Timeline {
  const clips = new Map<string, NarrationClip>();
  for (const clip of narration.clips) clips.set(`${clip.sceneId}#${clip.beatIndex}`, clip);

  const scenes: TimelineScene[] = [];
  let previousEnd = 0;
  storyboard.scenes.forEach((scene, sceneIndex) => {
    const transitionSec = sceneIndex === 0 ? 0 : (TRANSITION_SECONDS[scene.transition] ?? 0);
    const leadIn =
      sceneIndex === 0 ? TIMELINE_RULES.firstLeadInSec : Math.max(TIMELINE_RULES.leadInSec, transitionSec);
    const startSec = sceneIndex === 0 ? 0 : ms(previousEnd - transitionSec);

    const beats: TimelineBeat[] = [];
    let cursor = leadIn;
    scene.narration.forEach((line, index) => {
      const durationSec = ms(clipSeconds(clips.get(`${scene.id}#${index}`), line.text));
      beats.push({ index, startSec: ms(startSec + cursor), durationSec });
      cursor += durationSec + TIMELINE_RULES.beatGapSec;
    });
    // `cursor` is one gap past the last beat; a scene without narration just holds its lead-in.
    const narrationEnd = beats.length > 0 ? cursor - TIMELINE_RULES.beatGapSec : leadIn;

    const natural = Math.max(
      narrationEnd + TIMELINE_RULES.tailSec,
      MIN_SCENE_SECONDS[scene.visual.type] ?? 4.5,
    );
    const target = scene.targetSeconds;
    const durationSec = ms(
      target !== null && Number.isFinite(target) && target > natural
        ? Math.min(target, natural * TIMELINE_RULES.maxStretch)
        : natural,
    );

    scenes.push({ sceneId: scene.id, startSec, durationSec, transitionSec, beats });
    previousEnd = ms(startSec + durationSec);
  });

  const outroStart = ms(Math.max(0, previousEnd - TIMELINE_RULES.outroOverlapSec));
  return {
    durationSec: ms(outroStart + TIMELINE_RULES.outroSec),
    scenes,
    outro: { startSec: outroStart, durationSec: TIMELINE_RULES.outroSec },
  };
}
