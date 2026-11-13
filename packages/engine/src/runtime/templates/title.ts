/** Opening card: kicker, big heading, subheading, tags and a change summary that counts up. */
import type { TitleResolved } from '../../core/render-plan.ts';
import { countUp, enter, progress } from '../anim.ts';
import { css, h, s } from '../dom.ts';
import { clampLines, fitStages, formatInt } from '../fit.ts';
import { rise } from '../motion.ts';
import type { SceneInstance, TemplateFactory } from '../types.ts';

const TITLE_CSS = String.raw`
.ms-title__orb {
  position: absolute;
  right: -260px;
  top: -230px;
  width: 1060px;
  height: 1060px;
  background: radial-gradient(closest-side in srgb, color-mix(in srgb, var(--accent) 34%, transparent), color-mix(in srgb, var(--accent-2) 11%, transparent) 54%, transparent 100%);
}
:root[data-theme='light'] .ms-title__orb {
  background: radial-gradient(closest-side in srgb, color-mix(in srgb, var(--accent) 20%, transparent), color-mix(in srgb, var(--accent-2) 8%, transparent) 54%, transparent 100%);
}
.ms-title__art { position: absolute; right: 30px; top: 30px; width: 480px; height: 660px; overflow: visible; }
.ms-title__art .rail { fill: none; stroke: var(--accent); stroke-width: 3; opacity: 0.3; stroke-linecap: round; }
.ms-title__art .branch { fill: none; stroke: var(--accent-2); stroke-width: 3; opacity: 0.55; stroke-linecap: round; }
.ms-title__art .node { fill: var(--bg-1); stroke: var(--accent); stroke-width: 3; }
.ms-title__art .node.alt { stroke: var(--accent-2); }
.ms-title__art .tick { fill: none; stroke: var(--text-3); stroke-width: 4; stroke-linecap: round; opacity: 0.45; }
.ms-title__art .halo { fill: none; stroke: var(--accent); stroke-width: 2; stroke-dasharray: 3 9; stroke-linecap: round; }

.ms-title__body {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 1210px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: 30px;
}
.ms-title__kicker {
  display: flex;
  align-items: center;
  gap: 18px;
  font-size: 24px;
  letter-spacing: 0.18em;
}
.ms-title__kicker::before {
  content: '';
  width: 44px;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}
.ms-title__h1 {
  width: 100%;
  font-size: 92px;
  font-weight: 800;
  letter-spacing: -0.035em;
  line-height: 1.06;
  padding-bottom: 0.1em;
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.ms-title__sub {
  max-width: 1120px;
  font-size: 38px;
  font-weight: 450;
  line-height: 1.34;
  color: var(--text-1);
  text-wrap: balance;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.ms-title__chips { display: flex; flex-wrap: wrap; gap: 14px; }
.ms-title__chip { height: 54px; padding: 0 26px; font-size: 24px; font-weight: 600; }
.ms-title__stats {
  display: flex;
  align-items: baseline;
  gap: 30px;
  margin-top: 10px;
  padding-top: 30px;
  border-top: 1px solid var(--border-1);
  font-size: 44px;
  font-weight: 650;
  letter-spacing: -0.015em;
  font-feature-settings: 'cv11', 'ss01', 'tnum';
}
.ms-title__add { color: var(--add); }
.ms-title__del { color: var(--del); }
.ms-title__across { color: var(--text-2); font-weight: 500; }
.ms-title__across b { color: var(--text-0); font-weight: 650; }
`;

/** A small commit-graph illustration: a main line, a branch that merges back, and label ticks. */
function buildArt(): SVGSVGElement {
  const circle = (cx: number, cy: number, r: number, cls: string) => s('circle', { cx, cy, r, class: cls });
  return s(
    'svg',
    { class: 'ms-title__art', viewBox: '0 0 480 660', 'aria-hidden': 'true' },
    s('path', { class: 'rail', d: 'M110 0 V660' }),
    s('path', { class: 'branch', d: 'M110 200 C110 270 310 240 310 320 V430 C310 510 110 470 110 540' }),
    s('path', { class: 'tick', d: 'M146 78 H270' }),
    s('path', { class: 'tick', d: 'M146 200 H236' }),
    s('path', { class: 'tick', d: 'M348 320 H440' }),
    s('path', { class: 'tick', d: 'M348 430 H414' }),
    s('path', { class: 'tick', d: 'M146 612 H228' }),
    circle(110, 540, 34, 'halo'),
    circle(110, 540, 58, 'halo'),
    circle(110, 78, 11, 'node'),
    circle(110, 200, 11, 'node'),
    circle(310, 320, 11, 'node alt'),
    circle(310, 430, 11, 'node alt'),
    circle(110, 540, 13, 'node'),
    circle(110, 612, 11, 'node'),
  );
}

export const titleTemplate: TemplateFactory<TitleResolved> = (visual, ctx) => {
  css('title', TITLE_CSS);
  const { sw } = ctx;
  const stats = ctx.plan.meta.stats;

  const kicker = visual.kicker
    ? h('div', { class: 'ms-kicker ms-title__kicker', text: visual.kicker })
    : null;
  const heading = h('h1', { class: 'ms-title__h1 ms-gradient-text', text: visual.heading });
  const sub = visual.subheading ? h('p', { class: 'ms-title__sub', text: visual.subheading }) : null;
  const chips = visual.chips.map((text) => h('span', { class: 'ms-chip ms-title__chip', text }));
  const chipRow = chips.length > 0 ? h('div', { class: 'ms-title__chips' }, ...chips) : null;

  const addNum = h('span', { text: '0' });
  const delNum = h('span', { text: '0' });
  const fileNum = h('b', { text: '0' });
  const showStats = stats.files > 0 || stats.additions > 0 || stats.deletions > 0;
  const statsRow = showStats
    ? h(
        'div',
        { class: 'ms-title__stats' },
        h('span', { class: 'ms-title__add' }, '+', addNum),
        h('span', { class: 'ms-title__del' }, '−', delNum),
        h('span', { class: 'ms-title__across' }, 'across ', fileNum, stats.files === 1 ? ' file' : ' files'),
      )
    : null;

  const body = h('div', { class: 'ms-title__body' }, kicker, heading, sub, chipRow, statsRow);
  const root = h('div', { class: 'ms-content' }, h('div', { class: 'ms-title__orb' }), buildArt(), body);

  const instance: SceneInstance = {
    root,
    layout() {
      // Two lines from 92 to 56 px; a very long heading may use three smaller lines before it is cut.
      const { maxLines } = fitStages(
        heading,
        [
          { max: 92, min: 56, maxLines: 2 },
          { max: 52, min: 44, maxLines: 3 },
        ],
        { lineHeight: 1.06 },
      );
      clampLines(heading, maxLines);
    },
    update(t) {
      if (kicker) rise(sw, kicker, enter(t, 0.2, 0.6), 16);
      rise(sw, heading, enter(t, 0.35, 0.9), 30);
      if (sub) rise(sw, sub, enter(t, 0.75, 0.7), 20);
      chips.forEach((chip, i) => rise(sw, chip, enter(t, 1.05 + i * 0.09, 0.5), 14));
      if (statsRow) {
        rise(sw, statsRow, enter(t, 1.5, 0.6), 14);
        const p = progress(t, 1.6, 1.3);
        sw.text(addNum, formatInt(countUp(stats.additions, p)));
        sw.text(delNum, formatInt(countUp(stats.deletions, p)));
        sw.text(fileNum, formatInt(countUp(stats.files, p)));
      }
    },
  };
  return instance;
};
