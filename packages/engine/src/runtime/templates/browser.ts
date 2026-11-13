/**
 * A browser window with a generic app page drawn from blocks. It is a simulation: the address
 * bar shows only a path, never a real host, and nothing on the page is a real product.
 *
 * Block conventions: `text` is the main string; `items` hold extra rows. A table's items are rows
 * with cells separated by "|" (the first row is the header); an input's first item is its value.
 */
import { type BrowserResolved, CONTENT_H, CONTENT_W } from '../../core/render-plan.ts';
import { ease, enter, lerp, q } from '../anim.ts';
import { css, h } from '../dom.ts';
import { middleTruncate } from '../fit.ts';
import { icon } from '../icons.ts';
import type { SceneInstance, TemplateFactory } from '../types.ts';
import { enterWindow } from './parts.ts';

const WIN_W = 1500;
const WIN_H = 700;
const TABS_H = 56;
const TOOLBAR_H = 64;
const PAGE_PAD_X = 56;
const PAGE_PAD_Y = 28;
const CURSOR_SIZE = 40;

type Block = BrowserResolved['blocks'][number];

/** The address shown in the bar: "app" plus the path. Scheme, host, query and fragment are dropped. */
export function displayUrl(url: string): string {
  let path = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  path = path.replace(/[?#].*$/, '');
  if (!path.startsWith('/')) path = path.replace(/^[a-z0-9-]+(\.[a-z0-9-]+)+(?=\/|$)/i, '');
  path = path.replace(/^\/+/, '').replace(/\/+$/, '');
  return path === '' ? 'app' : middleTruncate(`app/${path}`, 56, 0.7);
}

/** Cells of a table block: rows split on "|", first row is the header. Without "|" it is one column. */
export function parseTable(
  text: string,
  items: readonly string[],
): { header: string[] | null; rows: string[][] } {
  const split = items.some((i) => i.includes('|'));
  if (!split) {
    return { header: text.trim() === '' ? null : [text.trim()], rows: items.map((i) => [i.trim()]) };
  }
  const all = items.map((i) => i.split('|').map((c) => c.trim()));
  const cols = all.reduce((m, r) => Math.max(m, r.length), 1);
  const padded = all.map((r) => [...r, ...Array.from({ length: cols - r.length }, () => '')]);
  return { header: padded[0] ?? null, rows: padded.slice(1) };
}

const isInline = (kind: Block['kind']) => kind === 'button' || kind === 'badge';

const BROWSER_CSS = `
.ms-browser__win { position: absolute; transform-origin: 50% 40%; }
.ms-browser {
  --app-bg: #0d1429;
  --app-surface: #151f40;
  --app-input: #0a1127;
  --app-line: rgba(150, 165, 215, 0.2);
  --app-text: #f1f3ff;
  --app-text-2: #b2bbdc;
  --app-muted: #7783aa;
  --app-tabs: rgba(0, 0, 0, 0.26);
}
:root[data-theme='light'] .ms-browser {
  --app-bg: #f6f7fc;
  --app-surface: #ffffff;
  --app-input: #ffffff;
  --app-line: rgba(30, 41, 80, 0.14);
  --app-text: #0d1330;
  --app-text-2: #4a5578;
  --app-muted: #8089a8;
  --app-tabs: rgba(30, 41, 80, 0.06);
}
.ms-browser__tabs {
  display: flex;
  align-items: flex-end;
  gap: 18px;
  height: ${TABS_H}px;
  padding: 0 24px;
  flex: none;
  background: var(--app-tabs);
}
.ms-browser__lights { display: flex; gap: 10px; align-self: center; margin-right: 22px; }
.ms-browser__lights i { width: 14px; height: 14px; border-radius: 50%; background: var(--text-3); opacity: 0.55; }
.ms-browser__lights i:nth-child(1) { background: #ff6b81; }
.ms-browser__lights i:nth-child(2) { background: #ffc861; }
.ms-browser__lights i:nth-child(3) { background: #3ddc97; }
.ms-browser__tab {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
  max-width: 340px;
  padding: 0 24px 0 18px;
  border-radius: 16px 16px 0 0;
  background: var(--surface-code);
  font-size: 22px;
  font-weight: 600;
  color: var(--text-0);
  white-space: nowrap;
}
.ms-browser__tab span:last-child { overflow: hidden; text-overflow: ellipsis; }
.ms-browser__fav { flex: none; width: 20px; height: 20px; border-radius: 6px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
.ms-browser__plus { align-self: center; color: var(--text-3); display: flex; }
.ms-browser__bar {
  display: flex;
  align-items: center;
  gap: 18px;
  height: ${TOOLBAR_H}px;
  padding: 0 24px;
  flex: none;
  background: var(--surface-code);
  border-bottom: 1px solid var(--border-1);
  color: var(--text-3);
}
.ms-browser__nav { display: flex; align-items: center; gap: 20px; }
.ms-browser__fwd { transform: rotate(180deg); display: flex; }
.ms-browser__url {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 44px;
  padding: 0 20px;
  border-radius: var(--radius-pill);
  background: var(--surface-inset);
  box-shadow: 0 0 0 1px var(--border-1);
  font-size: 22px;
  font-weight: 500;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
}
.ms-browser__page { position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--app-bg); color: var(--app-text); }
.ms-browser__col {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 20px;
  width: 1120px;
  max-width: 100%;
  padding: ${PAGE_PAD_Y}px ${PAGE_PAD_X}px;
  transform-origin: 0 0;
}
.ms-browser__col--two { display: block; column-count: 2; column-gap: 64px; width: 100%; max-width: none; }
.ms-browser__col--two > * { break-inside: avoid; margin-bottom: 20px; }
.ms-browser__col--two .ms-browser__table { min-width: 0; }
.ms-browser__col--two .ms-browser__card { min-width: 0; }
.ms-browser__col--two .ms-browser__image { width: 100%; }
.ms-browser__row { display: flex; align-items: center; flex-wrap: wrap; gap: 18px; }
.ms-browser__block { position: relative; }
.ms-browser__ring {
  position: absolute;
  inset: -10px;
  border-radius: 22px;
  border: 3px solid var(--accent);
  box-shadow: 0 0 0 7px var(--accent-soft), 0 0 44px var(--accent-soft);
  pointer-events: none;
}
.ms-browser__h { font-size: 46px; font-weight: 750; letter-spacing: -0.025em; line-height: 1.1; color: var(--app-text); }
.ms-browser__p { max-width: 980px; font-size: 26px; font-weight: 450; line-height: 1.42; color: var(--app-text-2); }
.ms-browser__btn {
  display: inline-flex;
  align-items: center;
  height: 62px;
  padding: 0 34px;
  border-radius: 16px;
  font-size: 25px;
  font-weight: 650;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #1d4ed8));
  box-shadow: 0 12px 26px -12px var(--accent);
}
.ms-browser__badge {
  display: inline-flex;
  align-items: center;
  height: 42px;
  padding: 0 18px;
  border-radius: var(--radius-pill);
  font-size: 22px;
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
}
.ms-browser__field { display: flex; flex-direction: column; gap: 10px; width: 640px; max-width: 100%; }
.ms-browser__label { font-size: 22px; font-weight: 600; color: var(--app-text-2); }
.ms-browser__input {
  display: flex;
  align-items: center;
  height: 60px;
  padding: 0 20px;
  border-radius: 14px;
  background: var(--app-input);
  box-shadow: inset 0 0 0 2px var(--app-line);
  font-size: 25px;
  color: var(--app-text);
}
.ms-browser__input--empty { color: var(--app-muted); }
.ms-browser__list { display: flex; flex-direction: column; gap: 12px; }
.ms-browser__list-title { font-size: 22px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--app-muted); }
.ms-browser__item { display: flex; align-items: center; gap: 14px; font-size: 25px; color: var(--app-text); }
.ms-browser__tick {
  display: grid;
  place-items: center;
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--accent-2);
  background: var(--accent-2-soft);
}
.ms-browser__table { width: 100%; min-width: 760px; border-radius: 18px; overflow: hidden; background: var(--app-surface); box-shadow: inset 0 0 0 1px var(--app-line); }
.ms-browser__tr { display: grid; align-items: center; height: 54px; padding: 0 24px; font-size: 24px; color: var(--app-text); border-top: 1px solid var(--app-line); }
.ms-browser__tr:first-child { border-top: none; }
.ms-browser__tr--head { height: 48px; font-size: 22px; font-weight: 650; color: var(--app-muted); background: rgba(127, 140, 190, 0.08); }
.ms-browser__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 520px;
  padding: 26px 30px;
  border-radius: 22px;
  background: var(--app-surface);
  box-shadow: inset 0 0 0 1px var(--app-line);
}
.ms-browser__card-title { font-size: 28px; font-weight: 700; letter-spacing: -0.01em; color: var(--app-text); }
.ms-browser__card-line { font-size: 24px; color: var(--app-text-2); }
.ms-browser__image {
  display: grid;
  place-items: center;
  width: 520px;
  max-width: 100%;
  height: 190px;
  border-radius: 20px;
  color: var(--app-muted);
  background: linear-gradient(135deg, var(--accent-soft), var(--accent-2-soft));
  box-shadow: inset 0 0 0 1px var(--app-line);
}
.ms-browser__alt { margin-top: 8px; font-size: 22px; color: var(--app-muted); }
.ms-browser__toast {
  position: absolute;
  right: 40px;
  bottom: 34px;
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 440px;
  max-width: 680px;
  padding: 20px 26px;
  border-radius: 18px;
  background: var(--app-surface);
  box-shadow: inset 0 0 0 1px var(--app-line), 0 24px 50px -18px rgba(0, 0, 0, 0.55);
}
.ms-browser__toast-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  color: #071022;
  background: var(--add);
}
.ms-browser__toast-text { font-size: 25px; font-weight: 600; color: var(--app-text); }
.ms-browser__toast-sub { margin-top: 2px; font-size: 22px; font-weight: 450; color: var(--app-text-2); }
.ms-browser__cursor {
  position: absolute;
  left: 0;
  top: 0;
  width: ${CURSOR_SIZE}px;
  height: ${CURSOR_SIZE}px;
  color: #fff;
  pointer-events: none;
  filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.45));
}
.ms-browser__cursor svg path { stroke: #0b1020; stroke-width: 1.4; }
`;

interface Anchor {
  x: number;
  y: number;
  /** True for elements that do not scroll with the page (toasts). */
  fixed: boolean;
}

export interface ScrollStop {
  start: number;
  /** Scroll offset (px) that brings this block fully into view. */
  need: number;
}

/**
 * Scroll targets for a page taller than its window: each block, once it appears, scrolls into view.
 * Offsets only grow, so the page never jumps back up.
 */
export function scrollTimeline(
  blocks: readonly { start: number; bottom: number }[],
  room: number,
  pad: number,
): ScrollStop[] {
  const sorted = blocks.slice().sort((a, b) => a.start - b.start);
  let need = 0;
  return sorted.map((b) => {
    need = Math.max(need, b.bottom + pad - room);
    return { start: b.start, need };
  });
}

/** Scroll offset at time `t`: eases from the previous target to the newest one. */
export function scrollOffsetAt(timeline: readonly ScrollStop[], t: number): number {
  let latest = -1;
  for (let i = 0; i < timeline.length; i++) if (t >= (timeline[i] as ScrollStop).start) latest = i;
  if (latest < 0) return 0;
  const from = latest > 0 ? (timeline[latest - 1] as ScrollStop).need : 0;
  const stop = timeline[latest] as ScrollStop;
  return lerp(from, stop.need, enter(t, stop.start, 0.7, ease.inOutCubic));
}

interface BuiltBlock {
  block: Block;
  el: HTMLElement;
  ring: HTMLElement | null;
  start: number;
  /** Where the pointer rests on this block (px in the page), measured once. */
  anchor: Anchor | null;
  toast: boolean;
}

function blockBody(block: Block): HTMLElement {
  switch (block.kind) {
    case 'heading':
      return h('div', { class: 'ms-browser__h', text: block.text });
    case 'text':
      return h('div', { class: 'ms-browser__p', text: block.text });
    case 'button':
      return h('div', { class: 'ms-browser__btn', text: block.text });
    case 'badge':
      return h('div', { class: 'ms-browser__badge', text: block.text });
    case 'input': {
      const value = (block.items[0] ?? '').trim();
      return h(
        'div',
        { class: 'ms-browser__field' },
        h('div', { class: 'ms-browser__label', text: block.text }),
        h('div', {
          class: `ms-browser__input${value === '' ? ' ms-browser__input--empty' : ''}`,
          text: value === '' ? 'Type here' : value,
        }),
      );
    }
    case 'list':
      return h(
        'div',
        { class: 'ms-browser__list' },
        block.text.trim() === '' ? null : h('div', { class: 'ms-browser__list-title', text: block.text }),
        ...block.items.map((item) =>
          h(
            'div',
            { class: 'ms-browser__item' },
            h('span', { class: 'ms-browser__tick' }, icon('check', { size: 18, stroke: 3 })),
            h('span', { text: item }),
          ),
        ),
      );
    case 'table': {
      const { header, rows } = parseTable(block.text, block.items);
      const cols = Math.max(1, header?.length ?? rows[0]?.length ?? 1);
      const template = `repeat(${cols}, minmax(0, 1fr))`;
      const row = (cells: string[], head: boolean) =>
        h(
          'div',
          {
            class: `ms-browser__tr${head ? ' ms-browser__tr--head' : ''}`,
            style: { 'grid-template-columns': template },
          },
          ...cells.map((c) => h('span', { text: c })),
        );
      return h(
        'div',
        { class: 'ms-browser__table' },
        header ? row(header, true) : null,
        ...rows.map((r) => row(r, false)),
      );
    }
    case 'card':
      return h(
        'div',
        { class: 'ms-browser__card' },
        h('div', { class: 'ms-browser__card-title', text: block.text }),
        ...block.items.map((line) => h('div', { class: 'ms-browser__card-line', text: line })),
      );
    case 'toast':
      return h(
        'div',
        { class: 'ms-browser__toast' },
        h('span', { class: 'ms-browser__toast-icon' }, icon('check', { size: 24, stroke: 3.2 })),
        h(
          'div',
          {},
          h('div', { class: 'ms-browser__toast-text', text: block.text }),
          block.items[0] ? h('div', { class: 'ms-browser__toast-sub', text: block.items[0] }) : null,
        ),
      );
    case 'image':
      return h(
        'div',
        {},
        h('div', { class: 'ms-browser__image' }, icon('image', { size: 72, stroke: 1.5 })),
        block.text.trim() === '' ? null : h('div', { class: 'ms-browser__alt', text: block.text }),
      );
  }
}

export const browserTemplate: TemplateFactory<BrowserResolved> = (visual, ctx) => {
  css('browser', BROWSER_CSS);
  const { sw } = ctx;

  const built: BuiltBlock[] = ctx.withStarts(visual.blocks, 0.14).map((block) => {
    const toast = block.kind === 'toast';
    const body = blockBody(block);
    const ring = block.emphasis ? h('div', { class: 'ms-browser__ring' }) : null;
    // Toasts float over the page, so the ring wraps the toast itself.
    if (toast) {
      if (ring) {
        ring.style.borderRadius = '26px';
        body.append(ring);
      }
      return { block, el: body, ring, start: block.start, anchor: null, toast };
    }
    const el = h('div', { class: 'ms-browser__block' }, body, ring);
    return { block, el, ring, start: block.start, anchor: null, toast };
  });

  // Page: a column of blocks (consecutive buttons and badges share a row), toasts on top.
  const column = h('div', { class: 'ms-browser__col' });
  let row: HTMLElement | null = null;
  for (const b of built) {
    if (b.toast) continue;
    if (isInline(b.block.kind)) {
      if (!row) {
        row = h('div', { class: 'ms-browser__row' });
        column.append(row);
      }
      row.append(b.el);
    } else {
      row = null;
      column.append(b.el);
    }
  }
  const cursor = h('div', { class: 'ms-browser__cursor' }, icon('cursor', { size: CURSOR_SIZE, stroke: 1 }));
  const page = h(
    'div',
    { class: 'ms-browser__page' },
    column,
    ...built.filter((b) => b.toast).map((b) => b.el),
    cursor,
  );

  const win = h(
    'div',
    { class: 'ms-window ms-browser__shell', style: { width: `${WIN_W}px`, height: `${WIN_H}px` } },
    h(
      'div',
      { class: 'ms-browser__tabs' },
      h('div', { class: 'ms-browser__lights' }, h('i'), h('i'), h('i')),
      h(
        'div',
        { class: 'ms-browser__tab' },
        h('span', { class: 'ms-browser__fav' }),
        h('span', { text: visual.pageTitle }),
      ),
      h('span', { class: 'ms-browser__plus' }, icon('plus', { size: 24, stroke: 2 })),
    ),
    h(
      'div',
      { class: 'ms-browser__bar' },
      h(
        'div',
        { class: 'ms-browser__nav' },
        icon('back', { size: 28, stroke: 2 }),
        h('span', { class: 'ms-browser__fwd' }, icon('back', { size: 28, stroke: 2 })),
        icon('reload', { size: 28, stroke: 2 }),
      ),
      h(
        'div',
        { class: 'ms-browser__url' },
        icon('lock', { size: 22, stroke: 2 }),
        h('span', { text: displayUrl(visual.url) }),
      ),
    ),
    page,
  );
  const wrap = h(
    'div',
    {
      class: 'ms-browser__win',
      style: {
        left: `${Math.round((CONTENT_W - WIN_W) / 2)}px`,
        top: `${Math.round((CONTENT_H - WIN_H) / 2)}px`,
        width: `${WIN_W}px`,
        height: `${WIN_H}px`,
      },
    },
    win,
  );
  const root = h('div', { class: 'ms-content ms-browser' }, wrap);

  // Pointer path: one stop per emphasised block, in time order.
  const stops = built.filter((b) => b.block.emphasis).sort((a, b) => a.start - b.start);
  const tip = { x: (5 / 24) * CURSOR_SIZE, y: (3 / 24) * CURSOR_SIZE };

  let scrolls = false;
  let timeline: ScrollStop[] = [];

  const instance: SceneInstance = {
    root,
    layout() {
      // A page taller than its window flows into two columns; if that is still too tall it scrolls
      // down as blocks appear, so text never shrinks.
      const room = page.clientHeight;
      if (column.scrollHeight > room) {
        column.classList.add('ms-browser__col--two');
        if (column.scrollHeight > room) {
          column.classList.remove('ms-browser__col--two');
          scrolls = true;
        }
      }
      if (scrolls) {
        timeline = scrollTimeline(
          built
            .filter((b) => !b.toast)
            .map((b) => ({ start: b.start, bottom: column.offsetTop + b.el.offsetTop + b.el.offsetHeight })),
          room,
          PAGE_PAD_Y,
        );
      }
      for (const b of stops) {
        if (b.toast) {
          b.anchor = {
            x: b.el.offsetLeft + b.el.offsetWidth * 0.96,
            y: b.el.offsetTop + b.el.offsetHeight * 0.86,
            fixed: true,
          };
          continue;
        }
        const kind = b.block.kind;
        const fx = kind === 'button' ? 0.8 : kind === 'badge' ? 0.5 : kind === 'input' ? 0.35 : 0.7;
        const fy = kind === 'button' ? 0.62 : 0.5;
        b.anchor = {
          x: column.offsetLeft + b.el.offsetLeft + b.el.offsetWidth * fx,
          y: column.offsetTop + b.el.offsetTop + b.el.offsetHeight * fy,
          fixed: false,
        };
      }
    },
    update(t) {
      enterWindow(sw, wrap, t);

      const scroll = scrolls ? scrollOffsetAt(timeline, t) : 0;
      if (scrolls) sw.transform(column, `translate(0px, ${q(-scroll, 2)}px)`);

      for (const b of built) {
        const p = enter(t, b.start, 0.55);
        if (b.toast) {
          sw.opacity(b.el, p);
          sw.transform(b.el, `translate(${q((1 - ease.outCubic(p)) * 60, 2)}px, 0px)`);
        } else {
          sw.opacity(b.el, p);
          sw.transform(b.el, `translate(0px, ${q((1 - p) * 20, 2)}px)`);
        }
      }

      // Rings: the newest emphasised block is lit, earlier ones settle back.
      let latest = -1;
      stops.forEach((b, k) => {
        if (t >= b.start) latest = k;
      });
      stops.forEach((b, k) => {
        if (!b.ring) return;
        const appear = enter(t, b.start + 0.25, 0.45);
        const settled = k < latest ? enter(t, (stops[k + 1] as BuiltBlock).start, 0.4) : 0;
        sw.opacity(b.ring, appear * lerp(1, 0.3, settled));
      });

      // Pointer: travels from stop to stop, resting after each arrival.
      let k = -1;
      stops.forEach((b, i) => {
        if (b.anchor && t >= b.start + 0.3) k = i;
      });
      const current = k >= 0 ? (stops[k] as BuiltBlock) : null;
      if (!current?.anchor) {
        sw.opacity(cursor, 0);
        return;
      }
      const onPage = (a: Anchor) => ({ x: a.x, y: a.fixed ? a.y : a.y - scroll });
      const to = onPage(current.anchor);
      const prev = k > 0 ? (stops[k - 1] as BuiltBlock).anchor : null;
      const from = prev ? onPage(prev) : { x: to.x + 150, y: to.y + 120 };
      const move = enter(t, current.start + 0.3, 0.8, ease.inOutCubic);
      const x = lerp(from.x, to.x, move) - tip.x;
      const y = lerp(from.y, to.y, move) - tip.y;
      sw.opacity(cursor, k === 0 ? enter(t, current.start + 0.3, 0.3) : 1);
      sw.transform(cursor, `translate(${q(x, 1)}px, ${q(y, 1)}px)`);
    },
  };
  return instance;
};
