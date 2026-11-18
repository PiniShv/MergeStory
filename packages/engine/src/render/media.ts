/**
 * The frames of recordings that one page needs. A page draws a window of the video, so it gets only the
 * frames that window can show, as data URLs on a copy of the plan. The plan on disk never holds them.
 */
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MergeStoryError } from '../core/errors.ts';
import { isInside } from '../core/posix.ts';
import { frameFileName, frameIndexesFor } from '../core/recording-frames.ts';
import type { FrameSet, RenderPlan } from '../core/render-plan.ts';

/** Every frame set of a plan, with the scene second at which the scene starts. */
function frameSets(plan: RenderPlan): { set: FrameSet; sceneStart: number }[] {
  return plan.scenes.flatMap((scene) => {
    const { visual } = scene;
    const sets: FrameSet[] = [];
    if (visual.type === 'recording') sets.push(visual.frames);
    if (visual.type === 'repro') {
      for (const step of visual.steps) if (step.thumb?.kind === 'recording') sets.push(step.thumb.frames);
    }
    if (visual.type === 'before-after') {
      for (const panel of [visual.before, visual.after])
        if (panel.kind === 'recording') sets.push(panel.frames);
    }
    return sets.map((set) => ({ set, sceneStart: scene.startSec }));
  });
}

/**
 * A copy of the plan with the frames that the times `fromSec` to `toSec` (video seconds) can show.
 * A plan without recordings is returned as it is. A missing frame file is a RENDER_FAILED error.
 */
export async function planWithMedia(
  plan: RenderPlan,
  runDir: string,
  fromSec: number,
  toSec: number,
): Promise<RenderPlan> {
  const sets = frameSets(plan);
  if (sets.length === 0) return plan;
  const root = await realpath(resolve(runDir)).catch(() => resolve(runDir));
  const media: NonNullable<RenderPlan['media']> = {};
  for (const { set, sceneStart } of sets) {
    const folder = resolve(root, set.dir);
    if (!isInside(root, folder) || folder === root) {
      throw new MergeStoryError(
        'RENDER_FAILED',
        `The frames of a recording are outside the run folder (${set.dir}).`,
      );
    }
    const frames: Record<number, string> = media[set.dir] ?? {};
    for (const index of frameIndexesFor(set, fromSec - sceneStart, toSec - sceneStart)) {
      if (frames[index] !== undefined) continue;
      const file = join(folder, frameFileName(index));
      const bytes = await readFile(file).catch((err: unknown) => {
        throw new MergeStoryError(
          'RENDER_FAILED',
          `A frame of a recording is missing: ${set.dir}/${frameFileName(index)}.`,
          {
            hint: 'Run the whole command again, so that the frames are extracted again.',
            cause: err,
          },
        );
      });
      frames[index] = `data:image/jpeg;base64,${bytes.toString('base64')}`;
    }
    media[set.dir] = frames;
  }
  return { ...plan, media };
}
