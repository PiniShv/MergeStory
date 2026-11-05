/** Closing scene: takeaways appear on their beats with check marks, then one closing line. */
import type { SummaryResolved } from '../../core/render-plan.ts';
import { ease, enter, q } from '../anim.ts';
import { css, h, s } from '../dom.ts';
import { clampLines, fitLines, fitText } from '../fit.ts';
import { grow, pop, rise } from '../motion.ts';
import type { SceneInstance, TemplateFactory } from '../types.ts';

const SUMMARY_CSS = String.raw`
.ms-sum__orb {
  position: absolute;
  right: -240px;
  bottom: -300px;
  width: 1000px;
  height: 1000px;
  background: radial-gradient(closest-side, rgba(57, 210, 242, 0.2), rgba(140, 123, 255, 0.1) 55%, transparent 100%);
}
:root[data-theme='light'] .ms-sum__orb {
  background: radial-gradient(closest-side, rgba(8, 145, 178, 0.14), rgba(103, 80, 240, 0.07) 55%, transparent 100%);
}
.ms-sum__art { position: absolute; right: 60px; top: 150px; width: 420px; height: 420px; overflow: visible; }
.ms-sum__art circle { fill: none; stroke-linecap: round; }
.ms-sum__art .ring { stroke: var(--accent); stroke-width: 3; opacity: 0.3; }
.ms-sum__art .dash { stroke: var(--accent-2); stroke-width: 2; stroke-dasharray: 3 11; opacity: 0.45; }
.ms-sum__art .tick { fill: none; stroke: var(--accent-2); stroke-width: 14; stroke-linecap: round; stroke-linejoin: round; opacity: 0.4; }

.ms-sum__wrap { position: absolute; left: 0; top: 0; bottom: 0; width: 1180px; display: flex; flex-direction: column; justify-content: center; gap: 40px; }
.ms-sum__kicker { display: flex; align-items: center; gap: 18px; font-size: 24px; letter-spacing: 0.18em; }
.ms-sum__kicker::before { content: ''; width: 44px; height: 4px; border-radius: 2px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
.ms-sum__list { display: flex; flex-direction: column; gap: 0.42em; font-size: 40px; }
.ms-sum__item { display: flex; align-items: flex-start; gap: 0.6em; }
.ms-sum__check {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 1.3em;
  height: 1.3em;
  border-radius: 50%;
  background: var(--accent-2-soft);
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent-2) 55%, transparent);
  color: var(--accent-2);
}
.ms-sum__check svg { width: 62%; height: 62%; fill: none; stroke: currentColor; stroke-width: 2.8; stroke-linecap: round; stroke-linejoin: round; }
.ms-sum__text { flex: 1; min-width: 0; padding-top: 0.14em; font-weight: 500; line-height: 1.26; letter-spacing: -0.012em; color: var(--text-0); text-wrap: pretty; }
.ms-sum__closing { display: flex; flex-direction: column; gap: 24px; align-items: flex-start; }
.ms-sum__rule { width: 140px; height: 4px; border-radius: 2px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transform-origin: 0 50%; }
.ms-sum__line {
  font-size: 58px;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.1;
  padding-bottom: 0.1em;
  overflow-wrap: anywhere;
  text-wrap: balance;
}
`;

const CHECK_LENGTH = 18;

function buildArt(): SVGSVGElement {
  return s(
    'svg',
    { class: 'ms-sum__art', viewBox: '0 0 420 420', 'aria-hidden': 'true' },
    s('circle', { class: 'ring', cx: 210, cy: 210, r: 190 }),
    s('circle', { class: 'dash', cx: 210, cy: 210, r: 150 }),
    s('circle', { class: 'ring', cx: 210, cy: 210, r: 108 }),
    s('path', { class: 'tick', d: 'M150 214 L192 256 L272 168' }),
  );
}

export const summaryTemplate: TemplateFactory<SummaryResolved> = (visual, ctx) => {
  css('summary', SUMMARY_CSS);
  const { sw } = ctx;
  const points = visual.points;

  const kicker = h('div', { class: 'ms-kicker ms-sum__kicker', text: 'Summary' });
  const rows = ctx.withStarts(points).map((p) => {
    const mark = s('path', { d: 'M5.5 12.6 L10 17 L18.5 7.6' });
    mark.setAttribute('stroke-dasharray', String(CHECK_LENGTH));
    const check = h('div', { class: 'ms-sum__check' }, s('svg', { viewBox: '0 0 24 24' }, mark));
    const el = h('div', { class: 'ms-sum__item' }, check, h('div', { class: 'ms-sum__text', text: p.text }));
    return { el, check, mark, start: p.start };
  });
  const list = h('div', { class: 'ms-sum__list' }, ...rows.map((r) => r.el));

  const rule = h('div', { class: 'ms-sum__rule' });
  const line = visual.closing
    ? h('div', { class: 'ms-sum__line ms-gradient-text', text: visual.closing })
    : null;
  const closing = line ? h('div', { class: 'ms-sum__closing' }, rule, line) : null;

  const wrap = h('div', { class: 'ms-sum__wrap' }, kicker, list, closing);
  const root = h('div', { class: 'ms-content' }, h('div', { class: 'ms-sum__orb' }), buildArt(), wrap);

  // The closing line follows the last point: on the next narration beat if there is one, else shortly after.
  const lastBeat = points.length > 0 ? Math.max(...points.map((p) => p.beat)) : -1;
  const lastStart = rows.length > 0 ? Math.max(...rows.map((r) => r.start)) : 0.4;
  const closingStart =
    lastBeat + 1 < ctx.scene.beats.length
      ? ctx.withStarts([{ beat: lastBeat + 1 }])[0]!.start
      : lastStart + 0.9;

  const instance: SceneInstance = {
    root,
    layout() {
      if (line) {
        fitLines(line, { max: 58, min: 40, maxLines: 2, lineHeight: 1.1 });
        clampLines(line, 2);
      }
      const blocks = [kicker, list, closing].filter((b): b is HTMLDivElement => b !== null);
      const used =
        blocks.reduce((sum, b) => sum + (b === list ? 0 : b.offsetHeight), 0) + 40 * (blocks.length - 1);
      fitText(list, { max: 40, min: 28, maxHeight: root.clientHeight - used });
    },
    update(t) {
      rise(sw, kicker, enter(t, 0.15, 0.6), 14);
      rows.forEach((row) => {
        const { start } = row;
        rise(sw, row.el, enter(t, start, 0.6), 22);
        pop(sw, row.check, enter(t, start + 0.05, 0.5, ease.linear), 0.6);
        sw.style(
          row.mark,
          'stroke-dashoffset',
          String(q(CHECK_LENGTH * (1 - enter(t, start + 0.25, 0.45, ease.inOutCubic)), 3)),
        );
      });
      if (closing) {
        rise(sw, closing, enter(t, closingStart, 0.8), 24);
        grow(sw, rule, 'x', enter(t, closingStart + 0.1, 0.7, ease.outQuint));
      }
    },
  };
  return instance;
};
