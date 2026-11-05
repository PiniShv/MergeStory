/**
 * Scene transitions as pure functions of time.
 *
 * Scene i+1 starts before scene i ends, so for `transitionIn.durationSec` seconds both are on
 * screen: the incoming scene plays its transition while the outgoing scene is taken away in a
 * matching way. Nothing here touches the DOM; the runtime applies the numbers it returns.
 */
import type { PlannedScene } from '../core/render-plan.ts';
import { STAGE_WIDTH } from '../core/render-plan.ts';
import type { TransitionType } from '../core/storyboard-schema.ts';
import { clamp01, ease, lerp, progress, q } from './anim.ts';

/** How long the end card takes to replace the last scene. */
export const OUTRO_FADE_SEC = 0.6;

/** When a scene is on screen and how it enters and leaves. Times are absolute seconds. */
export interface SceneSlot {
  /** Start of the scene; its incoming transition begins here. */
  start: number;
  inType: TransitionType;
  inSec: number;
  /** When the next scene (or the end card) starts replacing this one. Infinity if nothing does. */
  outStart: number;
  outType: TransitionType;
  outSec: number;
  /** First time the scene is no longer needed on screen. Infinity for a last scene without an end card. */
  end: number;
}

/** How a scene wrapper is drawn at one moment. Clip values are percentages of the stage width. */
export interface TransitionFrame {
  opacity: number;
  x: number;
  y: number;
  scale: number;
  clipLeft: number;
  clipRight: number;
}

export interface SceneFrame extends TransitionFrame {
  visible: boolean;
}

const REST: TransitionFrame = { opacity: 1, x: 0, y: 0, scale: 1, clipLeft: 0, clipRight: 0 };
const GONE: TransitionFrame = { opacity: 0, x: 0, y: 0, scale: 1, clipLeft: 0, clipRight: 0 };

/** Smoothstep of p between a and b. */
function smooth(p: number, a: number, b: number): number {
  const x = clamp01((p - a) / (b - a));
  return x * x * (3 - 2 * x);
}

function effectiveSec(type: TransitionType, sec: number): number {
  return type === 'none' ? 0 : Math.max(0, sec);
}

/**
 * Slots for every scene. A scene stays on screen until its replacement has finished entering, so
 * a plan with no overlap still cross-fades instead of cutting to the bare background.
 */
export function buildSlots(
  scenes: readonly PlannedScene[],
  outro: { startSec: number; durationSec: number } | null,
): SceneSlot[] {
  return scenes.map((scene, i) => {
    const next = scenes[i + 1];
    let outStart = Number.POSITIVE_INFINITY;
    let outType: TransitionType = 'fade';
    let outSec = 0;
    if (next) {
      outStart = next.startSec;
      outType = next.transitionIn.type;
      outSec = effectiveSec(outType, next.transitionIn.durationSec);
    } else if (outro) {
      outStart = outro.startSec;
      outSec = OUTRO_FADE_SEC;
    }
    const naturalEnd = scene.startSec + scene.durationSec;
    return {
      start: scene.startSec,
      inType: scene.transitionIn.type,
      inSec: effectiveSec(scene.transitionIn.type, scene.transitionIn.durationSec),
      outStart,
      outType,
      outSec,
      end: Number.isFinite(outStart) ? Math.max(naturalEnd, outStart + outSec) : Number.POSITIVE_INFINITY,
    };
  });
}

/** Incoming scene at transition progress p (0 = just started, 1 = settled). */
export function incomingFrame(type: TransitionType, p: number): TransitionFrame {
  if (p >= 1) return REST;
  switch (type) {
    case 'none':
      return p > 0 ? REST : GONE;
    case 'fade':
      return { ...REST, opacity: smooth(p, 0.3, 1) };
    case 'slide':
      return { ...REST, opacity: smooth(p, 0.05, 0.7), x: (1 - ease.outQuint(p)) * 140 };
    case 'zoom':
      return { ...REST, opacity: smooth(p, 0.2, 0.85), scale: lerp(0.94, 1, ease.outCubic(p)) };
    case 'wipe':
      return { ...REST, clipRight: (1 - ease.inOutCubic(p)) * 100 };
  }
}

/** Outgoing scene at the progress of the transition that replaces it. */
export function outgoingFrame(type: TransitionType, p: number): TransitionFrame {
  if (p <= 0) return REST;
  switch (type) {
    case 'none':
      return GONE;
    case 'fade':
      return { ...REST, opacity: 1 - smooth(p, 0, 0.7) };
    case 'slide':
      return { ...REST, opacity: 1 - smooth(p, 0, 0.65), x: -smooth(p, 0, 1) * 100 };
    case 'zoom':
      return { ...REST, opacity: 1 - smooth(p, 0, 0.65), scale: lerp(1, 1.05, ease.inOutCubic(p)) };
    case 'wipe':
      return { ...REST, clipLeft: ease.inOutCubic(p) * 100 };
  }
}

/** Frame of one scene wrapper at absolute time t. */
export function sceneFrame(slot: SceneSlot, t: number): SceneFrame {
  if (t < slot.start || t >= slot.end) return { ...GONE, visible: false };
  const a = incomingFrame(slot.inType, progress(t, slot.start, slot.inSec));
  const b = outgoingFrame(slot.outType, progress(t, slot.outStart, slot.outSec));
  const opacity = a.opacity * b.opacity;
  return {
    visible: opacity > 0.002,
    opacity,
    x: a.x + b.x,
    y: a.y + b.y,
    scale: a.scale * b.scale,
    clipLeft: Math.max(a.clipLeft, b.clipLeft),
    clipRight: Math.max(a.clipRight, b.clipRight),
  };
}

/** CSS transform for a frame; "none" at rest so settled scenes carry no transform. */
export function frameTransform(frame: TransitionFrame): string {
  if (frame.x === 0 && frame.y === 0 && frame.scale === 1) return 'none';
  return `translate3d(${q(frame.x, 2)}px, ${q(frame.y, 2)}px, 0) scale(${q(frame.scale, 4)})`;
}

/** CSS clip-path for a frame ("none" unless a wipe is running). */
export function frameClip(frame: TransitionFrame): string {
  if (frame.clipLeft <= 0 && frame.clipRight <= 0) return 'none';
  return `inset(0 ${q(frame.clipRight, 2)}% 0 ${q(frame.clipLeft, 2)}%)`;
}

/** Position and strength of the glowing edge drawn while a wipe is running, or null. */
export function wipeEdge(slots: readonly SceneSlot[], t: number): { x: number; opacity: number } | null {
  for (const slot of slots) {
    if (slot.inType !== 'wipe' || slot.inSec <= 0) continue;
    const p = progress(t, slot.start, slot.inSec);
    if (p > 0 && p < 1) return { x: ease.inOutCubic(p) * STAGE_WIDTH, opacity: Math.sin(Math.PI * p) };
  }
  return null;
}
