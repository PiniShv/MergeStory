/**
 * Which frame of a recording shows at which time. Node (the renderer chooses what each page gets) and
 * the browser runtime (the template shows it) both use these functions, so they always agree.
 * This file must stay dependency-free: the browser runtime imports it too.
 */
import type { FrameSet, PlannedScene } from './render-plan.ts';

/** The folder in the run folder that holds every frame folder. It is MergeStory's own name. */
export const FRAMES_DIR = 'recording-frames';

/** Frames kept per second of the recording. */
export const RECORDING_FPS = 12;

/** The shortest clip, and the shortest part of one, that can be shown: it still gives two frames. */
export const MIN_CLIP_SECONDS = 0.2;

/** How long before a beat's audio starts its visual element begins to appear. */
export const BEAT_LEAD_SEC = 0.15;

/** The largest box (logical pixels) that a frame is shown in, for a recording scene and for one panel. */
export const RECORDING_BOX = { scene: { width: 1680, height: 624 }, panel: { width: 780, height: 584 } };

/** The clip starts this long after the scene (or the panel) appears, when its entrance is under way. */
export const SCENE_CLIP_START_SEC = 0.5;
export const PANEL_CLIP_DELAY_SEC = 0.6;

/** Start of narration beat `index` in seconds since the scene started; out-of-range indexes clamp. */
export function beatAt(scene: Pick<PlannedScene, 'startSec' | 'beats'>, index: number): number {
  const { beats } = scene;
  const beat = beats[Math.max(0, Math.min(beats.length - 1, index))];
  return beat ? beat.startSec - scene.startSec : 0;
}

/** When the "before" and "after" panels start, in scene seconds, given when the first two beats appear. */
export function panelStarts(beatStarts: readonly number[]): { before: number; after: number } {
  const before = Math.max(0.1, beatStarts[0] ?? 0);
  const second = beatStarts[1];
  const after = second === undefined ? before + 1.4 : Math.max(second, before + 0.9);
  return { before, after };
}

/** `panelStarts` for a planned scene: the panels appear just before the audio of the first two beats. */
export function scenePanelStarts(scene: Pick<PlannedScene, 'startSec' | 'beats'>): {
  before: number;
  after: number;
} {
  return panelStarts(scene.beats.map((_, i) => beatAt(scene, i) - BEAT_LEAD_SEC));
}

/** The index of the frame that shows at scene time `t`: the clip plays from `startSec` at `speed`, and rests on its first and last frame. */
export function frameIndexAt(set: Pick<FrameSet, 'startSec' | 'speed' | 'fps' | 'count'>, t: number): number {
  // The small step keeps a time that lies exactly on a frame on that frame, whatever the rounding of the product.
  const raw = Math.floor((t - set.startSec) * set.speed * set.fps + 1e-9);
  return Math.max(0, Math.min(set.count - 1, Number.isFinite(raw) ? raw : 0));
}

/** The indexes a page needs to show the scene times from `from` to `to` (inclusive), in order. */
export function frameIndexesFor(
  set: Pick<FrameSet, 'startSec' | 'speed' | 'fps' | 'count'>,
  from: number,
  to: number,
): number[] {
  const first = frameIndexAt(set, from);
  const last = frameIndexAt(set, Math.max(from, to));
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** The wanted index if the page has it, else the closest one it has (the lower one on a tie). Null when it has none. */
export function nearestFrame(available: readonly number[], wanted: number): number | null {
  let best: number | null = null;
  for (const index of available) {
    if (best === null || Math.abs(index - wanted) < Math.abs(best - wanted)) best = index;
  }
  return best;
}

/** Name of a frame file inside a frame folder; `index` counts from 0, the file names from 1. */
export function frameFileName(index: number): string {
  return `f-${String(index + 1).padStart(5, '0')}.jpg`;
}

/**
 * Folder of the frames of one use of a recording, relative to the run folder: the scene's own, or one
 * side of a before-after scene. It is named by the scene's place in the storyboard (the first scene
 * is 1) and never by its id: an id can be long, and two ids can differ only by upper and lower case,
 * which many disks treat as one name.
 */
export function frameDirFor(sceneNumber: number, side: 'before' | 'after' | null): string {
  return `${FRAMES_DIR}/s-${sceneNumber}${side ? `.${side}` : ''}`;
}
