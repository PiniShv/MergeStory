/** The scene context the runtime hands to every template. */
import type { PlannedScene, RenderPlan } from '../core/render-plan.ts';
import type { StyleWriter } from './anim.ts';
import type { SceneContext } from './types.ts';

/** How long before a beat's audio starts its visual element begins to appear. */
const BEAT_LEAD_SEC = 0.15;

export function makeContext(plan: RenderPlan, scene: PlannedScene, sw: StyleWriter): SceneContext {
  const beats = scene.beats;
  /** Start of narration beat `index` in seconds since the scene started; out-of-range indexes clamp. */
  const beatAt = (index: number) => {
    if (beats.length === 0) return 0;
    const beat = beats[Math.max(0, Math.min(beats.length - 1, index))]!;
    return beat.startSec - scene.startSec;
  };
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
