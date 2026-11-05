import { describe, expect, it } from 'vitest';
import type { PlannedScene, RenderPlan } from '../core/render-plan.ts';
import { StyleWriter } from './anim.ts';
import { makeContext } from './context.ts';

function contextWith(beatStarts: number[]) {
  const scene = {
    startSec: 10,
    durationSec: 20,
    beats: beatStarts.map((startSec, index) => ({
      index,
      startSec: 10 + startSec,
      durationSec: 1,
      text: '',
    })),
  } as unknown as PlannedScene;
  return makeContext({} as RenderPlan, scene, new StyleWriter());
}

describe('SceneContext.withStarts', () => {
  it('starts each item a little before its beat and spaces items on one beat apart', () => {
    const ctx = contextWith([0, 2, 4]);
    const items = ctx.withStarts([{ beat: 0 }, { beat: 0 }, { beat: 1 }, { beat: 0 }], 0.1);
    expect(items.map((i) => i.start)).toEqual([0 - 0.15, 0 - 0.15 + 0.1, 2 - 0.15, 0 - 0.15 + 0.2]);
  });

  it('keeps the other fields of each item and defaults the step to 0.1 s', () => {
    const ctx = contextWith([1]);
    const [a, b] = ctx.withStarts([
      { beat: 0, text: 'a' },
      { beat: 0, text: 'b' },
    ]);
    expect(a).toEqual({ beat: 0, text: 'a', start: 1 - 0.15 });
    expect(b?.start).toBe(1 - 0.15 + 0.1);
  });

  it('clamps beats outside the scene and treats a scene without beats as starting at 0', () => {
    const ctx = contextWith([0, 3]);
    expect(ctx.withStarts([{ beat: 9 }, { beat: -2 }], 0).map((i) => i.start)).toEqual([3 - 0.15, 0 - 0.15]);
    expect(contextWith([]).withStarts([{ beat: 0 }], 0)[0]?.start).toBe(-0.15);
  });

  it('adds no spacing with a step of 0', () => {
    const ctx = contextWith([0]);
    expect(ctx.withStarts([{ beat: 0 }, { beat: 0 }], 0).map((i) => i.start)).toEqual([-0.15, -0.15]);
  });
});
