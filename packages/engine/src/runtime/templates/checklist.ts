/** "What to review": one card per item with a severity stripe, title, detail and evidence label. */
import type { ChecklistResolved } from '../../core/render-plan.ts';
import { ease, enter } from '../anim.ts';
import { css, h } from '../dom.ts';
import { truncatePath } from '../fit.ts';
import { grow, rise } from '../motion.ts';
import type { SceneInstance, TemplateFactory } from '../types.ts';

type Item = ChecklistResolved['items'][number];

const CHECKLIST_CSS = String.raw`
.ms-chk__head { display: flex; align-items: flex-end; justify-content: space-between; height: 76px; padding-bottom: 4px; }
.ms-chk__title { font-size: 52px; font-weight: 750; letter-spacing: -0.025em; line-height: 1.1; }
.ms-chk__legend { display: flex; align-items: center; gap: 28px; font-size: 24px; font-weight: 600; color: var(--text-2); padding-bottom: 8px; }
.ms-chk__legend span { display: inline-flex; align-items: center; gap: 10px; }
.ms-chk__legend i { width: 14px; height: 14px; border-radius: 50%; background: var(--sev); }

.ms-chk__grid { display: grid; gap: 16px; margin-top: 16px; align-content: start; }

.ms-chk__card {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--chk-gap, 12px);
  min-width: 0;
  padding: var(--chk-pad, 22px) 30px var(--chk-pad, 22px) 44px;
  border-radius: 22px;
  overflow: hidden;
  background: var(--surface-1);
}
.ms-chk__card--row { flex-direction: row; align-items: center; gap: 28px; }
.ms-chk__stripe {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 10px;
  background: linear-gradient(180deg, var(--sev), color-mix(in srgb, var(--sev) 35%, transparent));
  transform-origin: 50% 0;
}
.ms-chk__main { display: flex; flex-direction: column; gap: var(--chk-gap, 12px); min-width: 0; }
.ms-chk__card--row .ms-chk__main { flex: 1; }
.ms-chk__top { display: flex; align-items: center; gap: 16px; min-width: 0; }
.ms-chk__sev {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  flex: none;
  height: var(--chk-chip, 38px);
  padding: 0 16px 0 14px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--sev) 16%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sev) 45%, transparent);
  color: var(--sev);
  font-size: 22px;
  font-weight: 750;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.ms-chk__sev::before { content: ''; width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
.ms-chk__name {
  min-width: 0;
  font-size: var(--chk-title, 38px);
  font-weight: 650;
  letter-spacing: -0.015em;
  line-height: 1.2;
  color: var(--text-0);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--chk-title-lines, 2);
  overflow: hidden;
  overflow-wrap: anywhere;
}
.ms-chk__detail {
  font-size: var(--chk-detail, 30px);
  font-weight: 450;
  line-height: 1.34;
  color: var(--text-1);
  text-wrap: pretty;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--chk-detail-lines, 2);
  overflow: hidden;
  overflow-wrap: anywhere;
}
.ms-chk__ref {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  flex: none;
  height: var(--chk-ref, 42px);
  padding: 0 18px;
  border-radius: var(--radius-pill);
  background: var(--surface-inset);
  box-shadow: 0 0 0 1px var(--border-2);
  font-family: var(--font-code);
  font-size: 22px;
  color: var(--accent-2);
  white-space: nowrap;
}
.ms-chk__card--row .ms-chk__ref { align-self: center; }
`;

const SEVERITY_ORDER: Item['severity'][] = ['high', 'medium', 'low', 'info'];

/** One set of sizes. The first level that fits the content area is used. */
interface Level {
  title: number;
  detail: number;
  pad: number;
  gap: number;
  titleLines: number;
  detailLines: number;
  chip: number;
  ref: number;
}

/** One column of up to three cards: roomy first, then tighter. */
const LIST_LEVELS: Level[] = [
  { title: 38, detail: 30, pad: 26, gap: 8, titleLines: 2, detailLines: 2, chip: 38, ref: 42 },
  { title: 36, detail: 30, pad: 22, gap: 8, titleLines: 2, detailLines: 2, chip: 38, ref: 42 },
  { title: 34, detail: 29, pad: 18, gap: 6, titleLines: 2, detailLines: 2, chip: 36, ref: 40 },
  { title: 32, detail: 28, pad: 14, gap: 6, titleLines: 1, detailLines: 2, chip: 36, ref: 40 },
];

/** Two columns, two rows (four items). */
const GRID_LEVELS: Level[] = [
  { title: 36, detail: 30, pad: 22, gap: 14, titleLines: 2, detailLines: 3, chip: 38, ref: 42 },
  { title: 34, detail: 29, pad: 18, gap: 10, titleLines: 2, detailLines: 3, chip: 38, ref: 42 },
  { title: 32, detail: 28, pad: 14, gap: 8, titleLines: 1, detailLines: 2, chip: 36, ref: 40 },
];

/** Two columns, three rows (five or six items). */
const DENSE_LEVELS: Level[] = [
  { title: 32, detail: 28, pad: 14, gap: 8, titleLines: 1, detailLines: 2, chip: 36, ref: 40 },
];

/** Height of the card area in grid mode, in pixels. */
const GRID_HEIGHT = 612;

function checklistLevels(count: number): Level[] {
  if (count <= 3) return LIST_LEVELS;
  return count === 4 ? GRID_LEVELS : DENSE_LEVELS;
}

export const checklistTemplate: TemplateFactory<ChecklistResolved> = (visual, ctx) => {
  css('checklist', CHECKLIST_CSS);
  const { sw } = ctx;
  const items = visual.items.slice(0, 6);
  const grid = items.length > 3;
  const refChars = grid ? 34 : 56;

  const legend = SEVERITY_ORDER.map((sev) => ({
    sev,
    count: items.filter((i) => i.severity === sev).length,
  })).filter((l) => l.count > 0);
  const head = h(
    'div',
    { class: 'ms-chk__head' },
    h('div', { class: 'ms-chk__title', text: 'What to review' }),
    h(
      'div',
      { class: 'ms-chk__legend' },
      ...legend.map((l) => h('span', { class: `ms-sev-${l.sev}` }, h('i'), `${l.count} ${l.sev}`)),
    ),
  );

  const cards = ctx.withStarts(items).map((item, i) => {
    // The last card of an odd grid spans both columns and reads like a list row.
    const wide = !grid || (items.length % 2 === 1 && i === items.length - 1);
    const stripe = h('div', { class: 'ms-chk__stripe' });
    const sev = h('div', { class: 'ms-chk__sev', text: item.severity });
    const ref = item.refLabel
      ? h('div', {
          class: 'ms-chk__ref',
          text: truncatePath(item.refLabel, wide ? 56 : refChars),
        })
      : null;
    const main = h(
      'div',
      { class: 'ms-chk__main' },
      h('div', { class: 'ms-chk__top' }, sev, h('div', { class: 'ms-chk__name', text: item.title })),
      item.detail ? h('div', { class: 'ms-chk__detail', text: item.detail }) : null,
    );
    const el = h(
      'div',
      {
        class: `ms-card ms-chk__card ms-sev-${item.severity}${wide ? ' ms-chk__card--row' : ''}`,
        style: wide && grid ? { 'grid-column': '1 / -1' } : {},
      },
      stripe,
      main,
      ref,
    );
    return { el, stripe, sev, start: item.start };
  });

  const gridEl = h(
    'div',
    {
      class: 'ms-chk__grid',
      style: grid
        ? {
            'grid-template-columns': '1fr 1fr',
            'grid-template-rows': `repeat(${Math.ceil(items.length / 2)}, minmax(0, 1fr))`,
            height: `${GRID_HEIGHT}px`,
          }
        : { 'grid-template-columns': '1fr', 'grid-auto-rows': 'min-content' },
    },
    ...cards.map((c) => c.el),
  );
  const root = h('div', { class: 'ms-content' }, head, gridEl);

  const apply = (level: Level) => {
    const set = (name: string, value: string) => root.style.setProperty(name, value);
    set('--chk-title', `${level.title}px`);
    set('--chk-detail', `${level.detail}px`);
    set('--chk-pad', `${level.pad}px`);
    set('--chk-gap', `${level.gap}px`);
    set('--chk-title-lines', String(level.titleLines));
    set('--chk-detail-lines', String(level.detailLines));
    set('--chk-chip', `${level.chip}px`);
    set('--chk-ref', `${level.ref}px`);
  };
  // Grid rows have a fixed height, so a card overflows its box; list rows grow, so the whole list overflows.
  const fits = () =>
    grid
      ? cards.every((c) => c.el.scrollHeight <= c.el.clientHeight + 1)
      : gridEl.offsetHeight <= root.clientHeight - head.offsetHeight - 16 - 2;

  const instance: SceneInstance = {
    root,
    layout() {
      const levels = checklistLevels(items.length);
      for (const level of levels) {
        apply(level);
        if (fits()) return;
      }
    },
    update(t) {
      rise(sw, head, enter(t, 0.15, 0.6), 16);
      cards.forEach((card) => {
        rise(sw, card.el, enter(t, card.start, 0.65), 26);
        grow(sw, card.stripe, 'y', enter(t, card.start + 0.1, 0.55, ease.outQuint));
        sw.opacity(card.sev, enter(t, card.start + 0.25, 0.4));
      });
    },
  };
  return instance;
};
