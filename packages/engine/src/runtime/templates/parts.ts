/** Building blocks shared by templates: captions, window frames, window entrance and image fitting. */
import { enter, lerp, q, type StyleWriter } from '../anim.ts';
import { h } from '../dom.ts';
import { fitLines } from '../fit.ts';

/** Space under a framed visual for its caption (gap plus two lines). */
export const CAPTION_RESERVE = 100;

/** Type of a caption; each template adds its own box rules around it. */
export const CAPTION_TEXT_CSS = `
  font-size: 26px;
  font-weight: 500;
  line-height: 1.38;
  color: var(--text-1);
  overflow: hidden;`;

export interface CaptionBlock {
  el: HTMLElement;
  /** Shrink the type step by step until the text fits in two lines; call once the scene is laid out. */
  fit(): void;
  /** Fade the caption up, starting `at` seconds after the scene started. */
  reveal(sw: StyleWriter, t: number, at: number): void;
}

/** A caption under a visual: `className` carries the template's own box rules, `style` its position. */
export function captionBlock(className: string, text: string, style: Record<string, string>): CaptionBlock {
  const el = h('div', { class: className, text, style });
  return {
    el,
    fit() {
      fitLines(el, { max: 26, min: 22, maxLines: 2, lineHeight: 1.38 });
    },
    reveal(sw, t, at) {
      const p = enter(t, at, 0.6);
      sw.opacity(el, p);
      sw.transform(el, `translate(0px, ${q((1 - p) * 14, 2)}px)`);
    },
  };
}

/** Height of the title bar on framed screenshots. */
export const WINDOW_BAR_H = 56;

export interface WindowFrameOptions {
  /** Classes added after `ms-window`. */
  class?: string;
  style?: Record<string, string>;
  /** Height of the title bar in px; omit to use the stylesheet's. */
  barHeight?: number;
  /** Elements after the traffic lights in the title bar. */
  barItems?: readonly (Node | null)[];
  /** The body, an element with the `ms-window__body` class. */
  body: HTMLElement;
}

/** A window: a title bar with traffic lights, then the body. */
export function windowFrame(options: WindowFrameOptions): HTMLElement {
  const barStyle = options.barHeight === undefined ? undefined : { height: `${options.barHeight}px` };
  return h(
    'div',
    { class: options.class ? `ms-window ${options.class}` : 'ms-window', style: options.style },
    h(
      'div',
      { class: 'ms-window__bar', style: barStyle },
      h('div', { class: 'ms-window__lights' }, h('i'), h('i'), h('i')),
      ...(options.barItems ?? []),
    ),
    options.body,
  );
}

/** The window rises into place and fades in over its first 0.55 s. */
export function enterWindow(sw: StyleWriter, el: HTMLElement, t: number): void {
  const p = enter(t, 0, 0.55);
  sw.opacity(el, p);
  sw.transform(el, `translate(0px, ${q((1 - p) * 20, 2)}px) scale(${q(lerp(0.985, 1, p), 4)})`);
}

/** Small images are enlarged at most this much, so they stay sharp. */
const MAX_UPSCALE = 1.6;

/** Plans carry images as data URLs; anything else would make the page fetch something, so it is refused. */
export function isDataImage(src: string): boolean {
  return /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(src);
}

/** Size of an image inside a box: scaled to fit, never distorted, enlarged at most `maxScale` times. */
export function fitImage(
  imageW: number,
  imageH: number,
  boxW: number,
  boxH: number,
  maxScale = MAX_UPSCALE,
): { width: number; height: number; scale: number } {
  const w = imageW > 0 && Number.isFinite(imageW) ? imageW : 1600;
  const hgt = imageH > 0 && Number.isFinite(imageH) ? imageH : 1000;
  const scale = Math.max(0.01, Math.min(boxW / w, boxH / hgt, maxScale));
  return { width: Math.round(w * scale), height: Math.round(hgt * scale), scale };
}
