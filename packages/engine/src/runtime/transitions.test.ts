import { describe, expect, it } from 'vitest';
import type { PlannedScene } from '../core/render-plan.ts';
import type { TransitionType } from '../core/storyboard-schema.ts';
import {
  buildSlots,
  frameClip,
  frameTransform,
  incomingFrame,
  OUTRO_FADE_SEC,
  outgoingFrame,
  sceneFrame,
  wipeEdge,
} from './transitions.ts';

function scene(start: number, duration: number, type: TransitionType = 'fade', sec = 0.5): PlannedScene {
  return {
    id: `s${start}`,
    role: 'mission',
    title: 'Scene',
    startSec: start,
    durationSec: duration,
    transitionIn: { type, durationSec: sec },
    beats: [],
    visual: { type: 'bullets', heading: null, items: [] },
    refs: [],
    badges: [],
  };
}

describe('buildSlots', () => {
  it('links each scene to the next one', () => {
    const slots = buildSlots([scene(0, 5), scene(4.5, 5, 'slide', 0.6)], null);
    expect(slots[0]).toMatchObject({ start: 0, outStart: 4.5, outType: 'slide', outSec: 0.6 });
    expect(slots[1]).toMatchObject({ start: 4.5, inType: 'slide', inSec: 0.6 });
  });

  it('keeps the outgoing scene until the incoming transition ends, even without overlap', () => {
    const [first] = buildSlots([scene(0, 5), scene(5, 5, 'fade', 0.5)], null);
    expect(first!.end).toBe(5.5);
  });

  it('never ends a last scene that has no end card', () => {
    const slots = buildSlots([scene(0, 5)], null);
    expect(slots[0]!.outStart).toBe(Number.POSITIVE_INFINITY);
    expect(slots[0]!.end).toBe(Number.POSITIVE_INFINITY);
  });

  it('hands the last scene over to the end card with a fade', () => {
    const [slot] = buildSlots([scene(0, 5)], { startSec: 4.4, durationSec: 3 });
    expect(slot).toMatchObject({ outStart: 4.4, outType: 'fade', outSec: OUTRO_FADE_SEC });
    expect(slot!.end).toBeCloseTo(5, 5);
  });

  it('treats "none" as an instant change', () => {
    const slots = buildSlots([scene(0, 5), scene(5, 5, 'none', 0.5)], null);
    expect(slots[1]!.inSec).toBe(0);
    expect(slots[0]!.outSec).toBe(0);
  });
});

describe('sceneFrame', () => {
  const slots = buildSlots([scene(0, 5, 'fade', 0.5), scene(4.5, 5, 'fade', 0.5)], null);

  it('hides a scene before it starts', () => {
    expect(sceneFrame(slots[1]!, 4.4).visible).toBe(false);
    expect(sceneFrame(slots[1]!, -3).visible).toBe(false);
  });

  it('fades the incoming scene in and rests at full opacity with no transform', () => {
    const early = sceneFrame(slots[1]!, 4.55);
    const late = sceneFrame(slots[1]!, 4.95);
    const settled = sceneFrame(slots[1]!, 6);
    expect(early.opacity).toBeLessThan(late.opacity);
    expect(settled).toMatchObject({ visible: true, opacity: 1 });
    expect(frameTransform(settled)).toBe('none');
    expect(frameClip(settled)).toBe('none');
  });

  it('removes the outgoing scene once the transition is over', () => {
    expect(sceneFrame(slots[0]!, 4.4).opacity).toBe(1);
    expect(sceneFrame(slots[0]!, 4.75).opacity).toBeLessThan(1);
    expect(sceneFrame(slots[0]!, 5.0).visible).toBe(false);
  });

  it('never shows both scenes at full strength', () => {
    for (let t = 4.5; t <= 5; t += 0.02) {
      const a = sceneFrame(slots[0]!, t).opacity;
      const b = sceneFrame(slots[1]!, t).opacity;
      expect(a + b).toBeLessThan(1.4);
    }
  });

  it('is a pure function of time', () => {
    expect(sceneFrame(slots[1]!, 4.7)).toEqual(sceneFrame(slots[1]!, 4.7));
  });
});

describe('transition shapes', () => {
  it('slides the incoming scene in from the right and the outgoing one out to the left', () => {
    expect(incomingFrame('slide', 0.1).x).toBeGreaterThan(0);
    expect(outgoingFrame('slide', 0.5).x).toBeLessThan(0);
    expect(incomingFrame('slide', 1).x).toBe(0);
  });

  it('zooms the incoming scene up from below 1 and the outgoing one past 1', () => {
    expect(incomingFrame('zoom', 0.1).scale).toBeLessThan(1);
    expect(outgoingFrame('zoom', 0.9).scale).toBeGreaterThan(1);
  });

  it('wipes with complementary clips that never overlap', () => {
    for (const p of [0.1, 0.4, 0.5, 0.8]) {
      const incoming = incomingFrame('wipe', p);
      const outgoing = outgoingFrame('wipe', p);
      expect(incoming.clipRight + outgoing.clipLeft).toBeCloseTo(100, 6);
      expect(incoming.opacity).toBe(1);
    }
  });

  it('cuts instantly for "none"', () => {
    expect(incomingFrame('none', 0).opacity).toBe(0);
    expect(incomingFrame('none', 1).opacity).toBe(1);
    expect(outgoingFrame('none', 0.0001).opacity).toBe(0);
  });

  it('formats transforms and clips for CSS', () => {
    expect(frameTransform(incomingFrame('slide', 0.5))).toMatch(/^translate3d\(.+px, 0px, 0\) scale\(1\)$/);
    expect(frameClip(incomingFrame('wipe', 0.5))).toBe('inset(0 50% 0 0%)');
  });
});

describe('wipeEdge', () => {
  const slots = buildSlots([scene(0, 5), scene(4.4, 5, 'wipe', 1)], null);

  it('is absent outside a wipe', () => {
    expect(wipeEdge(slots, 2)).toBeNull();
    expect(wipeEdge(slots, 6)).toBeNull();
  });

  it('moves left to right and glows most in the middle', () => {
    const early = wipeEdge(slots, 4.6)!;
    const middle = wipeEdge(slots, 4.9)!;
    const late = wipeEdge(slots, 5.3)!;
    expect(early.x).toBeLessThan(middle.x);
    expect(middle.x).toBeLessThan(late.x);
    expect(middle.opacity).toBeGreaterThan(early.opacity);
    expect(middle.x).toBeCloseTo(960, 0);
  });
});
