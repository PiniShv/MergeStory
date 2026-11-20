/** "What to review": one card per item with a severity stripe, title, detail and evidence label. */
import type { ChecklistResolved } from '../../core/render-plan.ts';
import { ease, enter } from '../anim.ts';
import { css, h } from '../dom.ts';
import { reportFit, truncatePath } from '../fit.ts';
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
export interface Level {
  title: number;
  detail: number;
  pad: number;
  gap: number;
  titleLines: number;
  detailLines: number;
  chip: number;
  ref: number;
}

/**
 * Roomy first, then tighter. A level is used only if no title or detail is cut, so the last levels
 * trade size for lines; the smallest sizes are still easy to read on the 1920 px canvas.
 * One column of up to three cards.
 */
export const LIST_LEVELS: Level[] = [
  { title: 38, detail: 30, pad: 26, gap: 8, titleLines: 2, detailLines: 2, chip: 38, ref: 42 },
  { title: 36, detail: 30, pad: 22, gap: 8, titleLines: 2, detailLines: 2, chip: 38, ref: 42 },
  { title: 34, detail: 29, pad: 18, gap: 6, titleLines: 2, detailLines: 2, chip: 36, ref: 40 },
  { title: 32, detail: 28, pad: 14, gap: 6, titleLines: 2, detailLines: 2, chip: 36, ref: 40 },
  { title: 30, detail: 26, pad: 12, gap: 6, titleLines: 2, detailLines: 3, chip: 34, ref: 38 },
  { title: 28, detail: 24, pad: 12, gap: 4, titleLines: 3, detailLines: 4, chip: 34, ref: 38 },
];

/** Two columns, two rows (four items). */
export const GRID_LEVELS: Level[] = [
  { title: 36, detail: 30, pad: 22, gap: 14, titleLines: 2, detailLines: 3, chip: 38, ref: 42 },
  { title: 34, detail: 29, pad: 18, gap: 10, titleLines: 2, detailLines: 3, chip: 38, ref: 42 },
  { title: 32, detail: 28, pad: 14, gap: 8, titleLines: 2, detailLines: 3, chip: 36, ref: 40 },
  { title: 30, detail: 26, pad: 14, gap: 8, titleLines: 2, detailLines: 4, chip: 34, ref: 38 },
  { title: 28, detail: 24, pad: 12, gap: 6, titleLines: 3, detailLines: 5, chip: 34, ref: 38 },
];

/** Two columns, three rows (five or six items). */
export const DENSE_LEVELS: Level[] = [
  { title: 32, detail: 28, pad: 14, gap: 8, titleLines: 1, detailLines: 2, chip: 36, ref: 40 },
  { title: 30, detail: 26, pad: 12, gap: 6, titleLines: 2, detailLines: 2, chip: 34, ref: 38 },
  { title: 28, detail: 24, pad: 10, gap: 4, titleLines: 2, detailLines: 3, chip: 34, ref: 38 },
];

/** Height of the card area in grid mode, in pixels. */
const GRID_HEIGHT = 612;

export function checklistLevels(count: number): Level[] {
  if (count <= 3) return LIST_LEVELS;
  return count === 4 ? GRID_LEVELS : DENSE_LEVELS;
}

/** What the browser reports for a block of text: its full height and the height it shows. */
export interface Box {
  scrollHeight: number;
  clientHeight: number;
}

/** What was measured for one card at one level. `content` and `inner` are heights in pixels. */
export interface CardMeasure {
  title: string;
  /** The title and detail blocks, which cut text after their line limit. */
  clamps: Box[];
  /** Height from the top of the first part to the bottom of the last part of the card. */
  content: number;
  /** Height of the card inside its padding. */
  inner: number;
}

export interface Measure {
  cards: CardMeasure[];
  /** The list is taller than the space under the heading (only a list can grow). */
  listOverflow: boolean;
}

const cutBox = (b: Box) => b.scrollHeight > b.clientHeight + 1;
/** A clamped block hides text, or the card's content is taller than the card (clipped at both ends, as it is centred). */
const cardCut = (c: CardMeasure) => c.clamps.some(cutBox) || c.content > c.inner + 1;

/** Titles of the items whose text is cut. A list that is too tall loses the end of the list: name every item. */
export function cutTitles(m: Measure): string[] {
  return m.listOverflow ? m.cards.map((c) => c.title) : m.cards.filter(cardCut).map((c) => c.title);
}

/**
 * Settle on the first level where nothing is cut. If none fits, the last level stays applied
 * and the items it cuts are returned. `measure` applies the level, then measures.
 */
export function pickLevel<L>(
  levels: readonly L[],
  measure: (level: L) => Measure,
): { level: L; cut: string[] } {
  let result: { level: L; cut: string[] } | undefined;
  for (const level of levels) {
    result = { level, cut: cutTitles(measure(level)) };
    if (result.cut.length === 0) break;
  }
  if (!result) throw new Error('A checklist needs at least one level.');
  return result;
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
      // Nobody rated these: the storyboard's author proposes them.
      h('span', { text: 'Suggested priority' }),
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
    const name = h('div', { class: 'ms-chk__name', text: item.title });
    const detail = item.detail ? h('div', { class: 'ms-chk__detail', text: item.detail }) : null;
    const main = h('div', { class: 'ms-chk__main' }, h('div', { class: 'ms-chk__top' }, sev, name), detail);
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
    return { el, stripe, sev, name, detail, start: item.start };
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
  // Text that the line limit hides still counts in scrollHeight. Grid rows have a fixed height and centre
  // their content, so overflow there is clipped at both ends and scrollHeight misses it: compare offsets.
  const measure = (level: Level): Measure => {
    apply(level);
    return {
      cards: cards.map((c, i) => {
        const parts = Array.from(c.el.children).filter((el) => el !== c.stripe) as HTMLElement[];
        const top = Math.min(...parts.map((el) => el.offsetTop));
        const bottom = Math.max(...parts.map((el) => el.offsetTop + el.offsetHeight));
        return {
          title: items[i]!.title,
          clamps: [c.name, c.detail].filter((el): el is HTMLDivElement => el !== null),
          content: bottom - top,
          inner: c.el.clientHeight - 2 * level.pad,
        };
      }),
      listOverflow: !grid && gridEl.offsetHeight > root.clientHeight - head.offsetHeight - 16 - 2,
    };
  };

  const instance: SceneInstance = {
    root,
    layout() {
      // Even the smallest level may cut some text: say so, because a reviewer would miss that part.
      const lost = pickLevel(checklistLevels(items.length), measure).cut;
      if (lost.length > 0) {
        reportFit(
          `The review checklist cuts text that does not fit, even at the smallest size: ${lost.map((t) => `"${t}"`).join(', ')}. Shorten these items.`,
        );
      }
      // One or two cards used to sit at the top with the lower half empty: center a short list.
      if (!grid) {
        const spare = root.clientHeight - head.offsetHeight - 16 - gridEl.offsetHeight;
        gridEl.style.marginTop = `${16 + Math.max(0, spare / 2)}px`;
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
