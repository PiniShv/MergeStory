/** An optional heading and a list of points. Each appears on its beat; the newest is emphasised. */
import type { BulletsResolved } from '../../core/render-plan.ts';
import { enter, lerp } from '../anim.ts';
import { css, h, s } from '../dom.ts';
import { clampLines, fitLines, fitText } from '../fit.ts';
import { grow, rise } from '../motion.ts';
import type { SceneInstance, TemplateFactory } from '../types.ts';

const BULLETS_CSS = String.raw`
.ms-bul__orb {
  position: absolute;
  right: -300px;
  top: 40px;
  width: 900px;
  height: 900px;
  background: radial-gradient(closest-side, rgba(140, 123, 255, 0.2), rgba(57, 210, 242, 0.06) 56%, transparent 100%);
}
:root[data-theme='light'] .ms-bul__orb {
  background: radial-gradient(closest-side, rgba(103, 80, 240, 0.12), rgba(8, 145, 178, 0.05) 56%, transparent 100%);
}
.ms-bul__art { position: absolute; right: 0; top: 0; width: 560px; height: 720px; overflow: visible; }
.ms-bul__art circle { fill: none; }
.ms-bul__art .arc { stroke: var(--accent); stroke-width: 2; opacity: 0.22; }
.ms-bul__art .arc.alt { stroke: var(--accent-2); stroke-dasharray: 3 11; stroke-linecap: round; opacity: 0.4; }
.ms-bul__art .dot { fill: var(--bg-1); stroke: var(--accent-2); stroke-width: 3; opacity: 0.7; }
.ms-bul__wrap { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 48px; }
.ms-bul__heading {
  font-size: 62px;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.1;
  padding-bottom: 0.08em;
  max-width: 1480px;
  flex: none;
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.ms-bul__list { display: flex; flex-direction: column; max-width: 1330px; font-size: 44px; }
.ms-bul__item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 0.75em;
  padding-bottom: 0.72em;
}
.ms-bul__item:last-child { padding-bottom: 0; }
.ms-bul__mark { position: relative; flex: none; width: 1em; height: 1.28em; }
.ms-bul__ring {
  position: absolute;
  left: 50%;
  top: 0.64em;
  width: 0.9em;
  height: 0.9em;
  margin: -0.45em 0 0 -0.45em;
  border-radius: 50%;
  background: radial-gradient(closest-side, rgba(140, 123, 255, 0.5), transparent);
  opacity: 0;
}
.ms-bul__dot {
  position: absolute;
  left: 50%;
  top: 0.64em;
  width: 0.34em;
  height: 0.34em;
  margin: -0.17em 0 0 -0.17em;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 0 0 0.08em var(--bg-1);
}
.ms-bul__line {
  position: absolute;
  left: 0.5em;
  top: 0.94em;
  bottom: -0.35em;
  width: 2px;
  margin-left: -1px;
  background: linear-gradient(180deg, var(--accent), var(--accent-2));
  transform-origin: 50% 0;
}
.ms-bul__text { flex: 1; min-width: 0; font-weight: 500; line-height: 1.28; letter-spacing: -0.012em; color: var(--text-0); text-wrap: pretty; }
`;

/** Concentric arcs with a few nodes, partly off the right edge. Static. */
function buildArt(): SVGSVGElement {
  const arc = (r: number, cls: string) => s('circle', { class: cls, cx: 560, cy: 360, r });
  const dot = (cx: number, cy: number) => s('circle', { class: 'dot', cx, cy, r: 9 });
  return s(
    'svg',
    { class: 'ms-bul__art', viewBox: '0 0 560 720', 'aria-hidden': 'true' },
    arc(150, 'arc'),
    arc(250, 'arc alt'),
    arc(350, 'arc'),
    dot(419, 309),
    dot(464, 475),
    dot(333, 466),
    dot(273, 159),
  );
}

export const bulletsTemplate: TemplateFactory<BulletsResolved> = (visual, ctx) => {
  css('bullets', BULLETS_CSS);
  const { sw } = ctx;
  const items = visual.items;

  const heading = visual.heading
    ? h('h2', { class: 'ms-bul__heading ms-gradient-text', text: visual.heading })
    : null;
  const parts = ctx.withStarts(items).map((item, i) => {
    const ring = h('div', { class: 'ms-bul__ring' });
    const line = i < items.length - 1 ? h('div', { class: 'ms-bul__line' }) : null;
    const el = h(
      'div',
      { class: 'ms-bul__item' },
      line,
      h('div', { class: 'ms-bul__mark' }, ring, h('div', { class: 'ms-bul__dot' })),
      h('div', { class: 'ms-bul__text', text: item.text }),
    );
    return { el, ring, line, start: item.start };
  });
  const list = h('div', { class: 'ms-bul__list' }, ...parts.map((p) => p.el));
  const root = h(
    'div',
    { class: 'ms-content' },
    h('div', { class: 'ms-bul__orb' }),
    buildArt(),
    h('div', { class: 'ms-bul__wrap' }, heading, list),
  );

  const instance: SceneInstance = {
    root,
    layout() {
      if (heading) {
        fitLines(heading, { max: 62, min: 44, maxLines: 2, lineHeight: 1.1 });
        clampLines(heading, 2);
      }
      const used = heading ? heading.offsetHeight + 48 : 0;
      fitText(list, { max: 44, min: 24, maxHeight: root.clientHeight - used - 8 });
    },
    update(t) {
      if (heading) rise(sw, heading, enter(t, 0.15, 0.7), 22);
      parts.forEach((part, i) => {
        const appear = enter(t, part.start, 0.6);
        const following = parts[i + 1];
        const next = following ? enter(t, following.start, 0.5) : 0;
        rise(sw, part.el, appear, 20, lerp(1, 0.58, next));
        sw.opacity(part.ring, appear * (1 - next));
        if (part.line) {
          sw.opacity(part.line, next * 0.6);
          grow(sw, part.line, 'y', next);
        }
      });
    },
  };
  return instance;
};
