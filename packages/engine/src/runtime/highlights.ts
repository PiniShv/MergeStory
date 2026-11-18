/**
 * Highlights on a picture: a rounded box in the accent colour, between a black line and a white line,
 * and an optional label. Each one fades in on its beat. The layer fills the picture and sits inside the
 * camera, so the lines grow with the picture; a label keeps its size on the screen.
 */
import {
  HIGHLIGHT_INNER,
  HIGHLIGHT_OUTER,
  INSIDE_OFFSET,
  LABEL_GAP,
  type PictureRect,
  placeLabels,
} from '../core/picture-view.ts';
import type { PlannedHighlight } from '../core/render-plan.ts';
import { enter, q } from './anim.ts';
import { css, h } from './dom.ts';
import type { SceneContext } from './types.ts';

/**
 * How long a highlight takes to fade in. It only fades: a box that also changed its size while its
 * label kept an offset of its own was drawn a little differently from one run to the next.
 */
export const HIGHLIGHT_IN_SEC = 0.35;

const HIGHLIGHT_CSS = `
.ms-hl-layer { position: absolute; inset: 0; pointer-events: none; }
.ms-hl { position: absolute; opacity: 0; }
.ms-hl__line {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  border: 4px solid var(--accent);
  border-radius: 10px;
  box-shadow: 0 0 0 2px ${HIGHLIGHT_OUTER}, inset 0 0 0 2px ${HIGHLIGHT_INNER};
}
.ms-hl__label {
  position: absolute;
  left: 0;
  bottom: 100%;
  transform-origin: 0 100%;
  box-sizing: border-box;
  white-space: nowrap;
  padding: 8px 14px;
  border: 2px solid var(--accent);
  border-radius: 999px;
  background: #0b0d14;
  color: #fff;
  font: 600 22px/1.15 var(--font-ui);
}
`;

export interface HighlightLayer {
  /** Null when there is nothing to draw. */
  el: HTMLElement | null;
  /** Measure the labels once the fonts are ready. `rest` is the view that the camera rests on. */
  layout(rest: PictureRect): void;
  /** `scale` is how many times larger than the whole picture the camera shows it. */
  update(t: number, scale: number): void;
}

const pct = (n: number): string => `${q(n * 100, 4)}%`;

export function createHighlights(ctx: SceneContext, highlights: readonly PlannedHighlight[]): HighlightLayer {
  if (highlights.length === 0) return { el: null, layout: () => undefined, update: () => undefined };
  css('highlights', HIGHLIGHT_CSS);
  const { sw } = ctx;
  const items = ctx.withStarts(highlights, 0).map((item) => {
    const label = item.label ? h('div', { class: 'ms-hl__label', text: item.label }) : null;
    const box = h(
      'div',
      {
        class: 'ms-hl',
        style: { left: pct(item.x), top: pct(item.y), width: pct(item.w), height: pct(item.h) },
      },
      h('div', { class: 'ms-hl__line' }),
      label,
    );
    return { item, box, label, place: { origin: '0 100%', dx: 0, dy: -LABEL_GAP } };
  });
  const el = h('div', { class: 'ms-hl-layer' }, ...items.map((i) => i.box));
  return {
    el,
    layout(rest) {
      const picture = { w: el.offsetWidth, h: el.offsetHeight };
      const labelled = items.filter((entry) => entry.label);
      const spots = placeLabels(
        labelled.map(({ item, label }) => ({
          box: item,
          label: { w: label?.offsetWidth ?? 0, h: label?.offsetHeight ?? 0 },
        })),
        picture,
        rest,
      );
      labelled.forEach((entry, index) => {
        const { label, item } = entry;
        const at = spots[index];
        if (!label || !at) return;
        const { side, dx } = at;
        const above = side === 'above';
        entry.place = {
          origin: above ? '0 100%' : '0 0',
          dx: side === 'inside' ? dx + INSIDE_OFFSET : dx,
          dy: above ? -LABEL_GAP : side === 'below' ? LABEL_GAP : INSIDE_OFFSET,
        };
        label.style.transformOrigin = entry.place.origin;
        label.style.top = above ? 'auto' : side === 'inside' ? '0' : '100%';
        label.style.bottom = above ? '100%' : 'auto';
        label.style.left = `${q(((at.x - item.x) / item.w) * 100, 4)}%`;
      });
    },
    update(t, scale) {
      for (const { item, box, label, place } of items) {
        const p = enter(t, item.start, HIGHLIGHT_IN_SEC);
        sw.opacity(box, p);
        if (label) {
          sw.transform(
            label,
            `scale(${q(1 / scale, 4)}) translate(${q(place.dx, 2)}px, ${q(place.dy, 2)}px)`,
          );
        }
      }
    },
  };
}
