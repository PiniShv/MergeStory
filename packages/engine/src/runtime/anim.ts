/**
 * Deterministic animation helpers. Every visual value is a pure function of time,
 * so the same plan always renders the same frames.
 */

export const clamp01 = (x: number): number => (x < 0 ? 0 : Math.min(x, 1));
export const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;

/** Linear progress of `t` through [start, start + duration], clamped to 0..1. */
export function progress(t: number, start: number, duration: number): number {
  if (duration <= 0) return t >= start ? 1 : 0;
  return clamp01((t - start) / duration);
}

export const ease = {
  linear: (p: number) => p,
  outCubic: (p: number) => 1 - (1 - p) ** 3,
  inOutCubic: (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  outQuint: (p: number) => 1 - (1 - p) ** 5,
  outExpo: (p: number) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
  inOutSine: (p: number) => -(Math.cos(Math.PI * p) - 1) / 2,
  /** Slight overshoot, for things that "land". */
  outBack: (p: number) => {
    const c1 = 1.4;
    const c3 = c1 + 1;
    return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
  },
} as const;

export type Easing = (p: number) => number;

/** Eased progress: enter(t, start, 0.6) goes 0 -> 1 over 0.6 s starting at `start`. */
export function enter(t: number, start: number, duration = 0.6, easing: Easing = ease.outCubic): number {
  return easing(progress(t, start, duration));
}

/** Round to a fixed precision so tiny float noise never marks a frame as changed. */
export function q(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * A transform that moves nothing becomes "none". An element at rest then has no transform at all,
 * so it is painted with the page and looks the same however it got there; a leftover
 * "translate(0px, 0px)" would keep it in a layer of its own, with slightly different edges.
 */
export function restTransform(value: string): string {
  const rest = value
    .replace(/translate3?d?\(\s*-?0(?:px)?\s*,\s*-?0(?:px)?\s*(?:,\s*-?0(?:px)?\s*)?\)/g, '')
    .replace(/scale\(\s*1(?:\.0+)?\s*(?:,\s*1(?:\.0+)?\s*)?\)/g, '')
    .trim();
  return rest === '' ? 'none' : value;
}

/**
 * Writes DOM styles only when the value changes and remembers whether anything changed.
 * The runtime asks it after each seek: if nothing changed, the renderer reuses the last frame.
 */
export class StyleWriter {
  private readonly cache = new WeakMap<Element, Map<string, string>>();
  private dirty = true;

  private remember(el: Element, key: string, value: string): boolean {
    let map = this.cache.get(el);
    if (!map) {
      map = new Map();
      this.cache.set(el, map);
    }
    if (map.get(key) === value) return false;
    map.set(key, value);
    this.dirty = true;
    return true;
  }

  /** Set a CSS property (kebab-case or custom property). */
  style(el: HTMLElement | SVGElement, prop: string, value: string): void {
    if (this.remember(el, `s:${prop}`, value)) el.style.setProperty(prop, value);
  }

  opacity(el: HTMLElement | SVGElement, value: number): void {
    this.style(el, 'opacity', String(q(value)));
  }

  transform(el: HTMLElement | SVGElement, value: string): void {
    this.style(el, 'transform', restTransform(value));
  }

  attr(el: Element, name: string, value: string): void {
    if (this.remember(el, `a:${name}`, value)) el.setAttribute(name, value);
  }

  text(el: Element, value: string): void {
    if (this.remember(el, 't', value)) el.textContent = value;
  }

  toggle(el: Element, className: string, on: boolean): void {
    if (this.remember(el, `c:${className}`, on ? '1' : '0')) el.classList.toggle(className, on);
  }

  /** Show or hide with `display`. Hidden scenes cost nothing to lay out. */
  visible(el: HTMLElement, on: boolean, display = ''): void {
    this.style(el, 'display', on ? display || 'block' : 'none');
  }

  /** Returns whether anything changed since the last call, then resets the flag. */
  consumeDirty(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  markDirty(): void {
    this.dirty = true;
  }
}

/** Number that counts up from 0 to `value` with progress p. */
export function countUp(value: number, p: number): number {
  return Math.round(value * ease.outCubic(clamp01(p)));
}
