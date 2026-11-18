/** The scene context the runtime hands to every template. */
import { BEAT_LEAD_SEC, beatAt as sceneBeatAt } from '../core/recording-frames.ts';
import type { PlannedScene, RenderPlan } from '../core/render-plan.ts';
import type { StyleWriter } from './anim.ts';
import type { SceneContext } from './types.ts';

export function makeContext(plan: RenderPlan, scene: PlannedScene, sw: StyleWriter): SceneContext {
  /** Start of narration beat `index` in seconds since the scene started; out-of-range indexes clamp. */
  const beatAt = (index: number) => sceneBeatAt(scene, index);
  return {
    plan,
    scene,
    sw,
    withStarts(items, step = 0.1) {
      const seen = new Map<number, number>();
      return items.map((item) => {
        const before = seen.get(item.beat) ?? 0;
        seen.set(item.beat, before + 1);
        return { ...item, start: beatAt(item.beat) - BEAT_LEAD_SEC + before * step };
      });
    },
    duration: scene.durationSec,
  };
}
