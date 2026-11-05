/** "The problem" and "The goal" cards, then supporting points that appear beat by beat. */
import type { MissionResolved } from '../../core/render-plan.ts';
import { ease, enter } from '../anim.ts';
import { css, h, s } from '../dom.ts';
import { fitLines, fitText, pad2 } from '../fit.ts';
import { pop, rise } from '../motion.ts';
import type { SceneInstance, TemplateFactory } from '../types.ts';

const MISSION_CSS = String.raw`
.ms-mission { display: flex; flex-direction: column; justify-content: center; }
.ms-mission__cards { position: relative; display: grid; gap: 56px; align-items: stretch; }
.ms-mission__card {
  position: relative;
  padding: 36px 44px 42px;
  border-radius: 28px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 24px;
  background: linear-gradient(160deg, color-mix(in srgb, var(--tone) 12%, var(--surface-1)), var(--surface-1) 62%);
}
.ms-mission__card::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 4px;
  background: linear-gradient(90deg, var(--tone), transparent 85%);
}
.ms-mission__card--problem { --tone: var(--accent); --tone-soft: var(--accent-soft); }
.ms-mission__card--goal { --tone: var(--accent-2); --tone-soft: var(--accent-2-soft); }
.ms-mission__head { display: flex; align-items: center; gap: 18px; }
.ms-mission__icon {
  display: grid;
  place-items: center;
  width: 60px;
  height: 60px;
  border-radius: 18px;
  background: var(--tone-soft);
  color: var(--tone);
  flex: none;
}
.ms-mission__icon svg { width: 32px; height: 32px; fill: none; stroke: currentColor; stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; }
.ms-mission__icon svg .dot { fill: currentColor; stroke: none; }
.ms-mission__label { font-size: 24px; font-weight: 750; letter-spacing: 0.14em; text-transform: uppercase; color: var(--tone); }
.ms-mission__text {
  font-size: 40px;
  font-weight: 550;
  line-height: 1.36;
  letter-spacing: -0.012em;
  color: var(--text-0);
  text-wrap: pretty;
  overflow-wrap: anywhere;
  max-height: 5.5em;
  overflow: hidden;
}
.ms-mission__link-pos { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.ms-mission__link {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  margin: -32px 0 0 -32px;
  border-radius: 50%;
  background: var(--surface-2);
  box-shadow: 0 0 0 1px var(--border-2), 0 14px 30px -12px rgba(0, 0, 0, 0.6);
  color: var(--accent-2);
}
.ms-mission__link svg { width: 30px; height: 30px; fill: none; stroke: currentColor; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }

.ms-mission__points { display: grid; grid-template-columns: 1fr 1fr; gap: 0.56em 56px; margin-top: 48px; font-size: 32px; }
.ms-mission__point {
  display: flex;
  align-items: center;
  gap: 0.7em;
  min-height: 2.5em;
  padding: 0.4em 0.9em 0.4em 0.5em;
  border-radius: 0.7em;
  background: var(--surface-inset);
  box-shadow: inset 0 0 0 1px var(--border-1);
  font-weight: 500;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--text-0);
}
.ms-mission__point--wide { grid-column: 1 / -1; }
.ms-mission__num {
  display: grid;
  place-items: center;
  flex: none;
  width: 1.7em;
  height: 1.7em;
  border-radius: 0.5em;
  background: var(--accent-2-soft);
  color: var(--accent-2);
  font-family: var(--font-code);
  font-size: 0.72em;
  font-weight: 700;
}
`;

const ICON_PROBLEM = () =>
  s(
    'svg',
    { viewBox: '0 0 24 24' },
    s('circle', { cx: 12, cy: 12, r: 9 }),
    s('path', { d: 'M12 7.4 V13' }),
    s('circle', { class: 'dot', cx: 12, cy: 16.6, r: 1.15 }),
  );

const ICON_GOAL = () =>
  s(
    'svg',
    { viewBox: '0 0 24 24' },
    s('circle', { cx: 12, cy: 12, r: 9 }),
    s('circle', { cx: 12, cy: 12, r: 4.6 }),
    s('circle', { class: 'dot', cx: 12, cy: 12, r: 1.4 }),
  );

const ICON_ARROW = () =>
  s('svg', { viewBox: '0 0 24 24' }, s('path', { d: 'M4.5 12 H19 M13 6 L19 12 L13 18' }));

function card(kind: 'problem' | 'goal', label: string, text: string, icon: SVGSVGElement) {
  const textEl = h('div', { class: 'ms-mission__text', text });
  const el = h(
    'div',
    { class: `ms-card ms-mission__card ms-mission__card--${kind}` },
    h(
      'div',
      { class: 'ms-mission__head' },
      h('div', { class: 'ms-mission__icon' }, icon),
      h('div', { class: 'ms-mission__label', text: label }),
    ),
    textEl,
  );
  return { el, textEl };
}

export const missionTemplate: TemplateFactory<MissionResolved> = (visual, ctx) => {
  css('mission', MISSION_CSS);
  const { sw } = ctx;

  const problem = visual.problem.trim()
    ? card('problem', 'The problem', visual.problem, ICON_PROBLEM())
    : null;
  const goal = visual.goal.trim() ? card('goal', 'The goal', visual.goal, ICON_GOAL()) : null;
  const cardList = [problem, goal].filter((c): c is NonNullable<typeof c> => c !== null);
  const cards = h(
    'div',
    {
      class: 'ms-mission__cards',
      style: { 'grid-template-columns': `repeat(${Math.max(1, cardList.length)}, 1fr)` },
    },
    ...cardList.map((c) => c.el),
  );

  const link = problem && goal ? h('div', { class: 'ms-mission__link' }, ICON_ARROW()) : null;
  if (link) cards.append(h('div', { class: 'ms-mission__link-pos' }, link));

  const points = ctx.withStarts(visual.points).map((p, i) => {
    const wide = visual.points.length % 2 === 1 && i === visual.points.length - 1;
    const el = h(
      'div',
      { class: `ms-mission__point${wide ? ' ms-mission__point--wide' : ''}` },
      h('div', { class: 'ms-mission__num', text: pad2(i + 1) }),
      h('div', { text: p.text }),
    );
    return { el, start: p.start };
  });
  const pointsEl = h('div', { class: 'ms-mission__points' }, ...points.map((p) => p.el));
  const root = h('div', { class: 'ms-content ms-mission' }, cards, points.length > 0 ? pointsEl : null);

  // Narration usually covers the problem, then the goal, then the points: tie the cards to the beats before the first point.
  const firstPointBeat =
    visual.points.length > 0 ? Math.min(...visual.points.map((p) => p.beat)) : ctx.scene.beats.length;
  const problemStart = ctx.withStarts([{ beat: 0 }])[0]!.start;
  // On the same beat as the problem, the goal follows 0.18 s later.
  const goalStart = ctx.withStarts([{ beat: 0 }, { beat: firstPointBeat >= 2 ? 1 : 0 }], 0.18)[1]!.start;

  const instance: SceneInstance = {
    root,
    layout() {
      // Shrink the card text step by step until the cards and the points fit the content area together.
      for (const cardMax of [40, 36, 32, 28]) {
        for (const c of cardList)
          fitLines(c.textEl, { max: cardMax, min: 28, maxLines: 4, lineHeight: 1.36 });
        if (points.length === 0) break;
        fitText(pointsEl, { max: 32, min: 28, maxHeight: root.clientHeight - cards.offsetHeight - 52 });
        if (cards.offsetHeight + 48 + pointsEl.offsetHeight <= root.clientHeight) break;
      }
    },
    update(t) {
      if (problem) rise(sw, problem.el, enter(t, problemStart, 0.7), 28);
      if (goal) rise(sw, goal.el, enter(t, goalStart, 0.7), 28);
      if (link) pop(sw, link, enter(t, goalStart + 0.2, 0.6, ease.linear), 0.7);
      for (const point of points) rise(sw, point.el, enter(t, point.start, 0.55), 22);
    },
  };
  return instance;
};
