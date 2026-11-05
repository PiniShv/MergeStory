/**
 * Entrance helpers for templates and chrome.
 *
 * Unlike a plain translate, they write `transform: none` once an element has settled. A settled
 * element is then painted with the page instead of in its own layer, so a resting frame looks the
 * same whatever time was shown before it (this matters when frames are rendered out of order).
 */
import { clamp01, ease, lerp, q, type StyleWriter } from './anim.ts';

type Target = HTMLElement | SVGElement;

/** Fade in and rise by `distance` px as p goes 0 -> 1. `maxOpacity` caps the final opacity (dimmed items). */
export function rise(sw: StyleWriter, el: Target, p: number, distance = 24, maxOpacity = 1): void {
  const dy = q((1 - p) * distance, 2);
  sw.opacity(el, p * maxOpacity);
  sw.transform(el, dy === 0 ? 'none' : `translate3d(0, ${dy}px, 0)`);
}

/** Fade in while scaling up from `from` with a slight overshoot as p goes 0 -> 1 (give it a linear p). */
export function pop(sw: StyleWriter, el: Target, p: number, from = 0.9): void {
  const scale = q(lerp(from, 1, ease.outBack(p)), 4);
  sw.opacity(el, clamp01(p * 1.6));
  sw.transform(el, scale === 1 ? 'none' : `scale(${scale})`);
}

/** Scale along one axis from 0 to 1 (rules, stripes, connecting lines). */
export function grow(sw: StyleWriter, el: Target, axis: 'x' | 'y', p: number): void {
  const scale = q(p, 4);
  sw.transform(el, scale === 1 ? 'none' : `scale${axis === 'x' ? 'X' : 'Y'}(${scale})`);
}

/** Vertical offset in px, or "none" at zero. For labels that move by a few pixels while fading. */
export function shift(sw: StyleWriter, el: Target, dy: number): void {
  const y = q(dy, 2);
  sw.transform(el, y === 0 ? 'none' : `translate3d(0, ${y}px, 0)`);
}
