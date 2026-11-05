/** Code window with a focus bar that moves between line ranges, dimmed context and note callouts. */
import { CONTENT_H, CONTENT_W, type CodeResolved, type ResolvedCode } from '../../core/render-plan.ts';
import { ease, enter, lerp, q } from '../anim.ts';
import { type Box, type Placement, placeCallout } from '../callout.ts';
import { focusIndexRange, planCodeView, renderCodeView } from '../code-view.ts';
import { css, h, s } from '../dom.ts';
import type { SceneInstance, TemplateFactory } from '../types.ts';
import { CAPTION_RESERVE, CAPTION_TEXT_CSS, captionBlock, enterWindow } from './parts.ts';

/** Width of a note card in a column beside the window. */
const NOTE_W = 460;
/** Widths a note card may take when it sits on the window, widest first. */
const NOTE_WIDTHS = [520, 460, 400, 340, 300] as const;
/** Space between the window and a note beside it, and the length of the arrow that crosses it. */
const NOTE_GAP = 64;

/** Start times for focus ranges: never before `earliest`, and at least `gap` seconds apart. */
export function focusStarts(times: readonly number[], earliest = 0.5, gap = 0.8): number[] {
  const out: number[] = [];
  for (const time of times) {
    const previous = out.length > 0 ? (out[out.length - 1] as number) + gap : earliest;
    out.push(Math.max(time, earliest, previous));
  }
  return out;
}

export interface CodeScenePlan {
  /** 'side': the window leaves a column for note cards. 'wide': the window may use the whole width. */
  mode: 'side' | 'wide';
  /** The widest the window may be. */
  maxWidth: number;
  /** The tallest the window may be. */
  maxHeight: number;
}

/**
 * Decide how wide the window may be. With notes, a column beside the window is kept free when that
 * costs nothing: same rows, and a font at most 3 px smaller than the widest window would use.
 * Otherwise the window takes the whole width, so the code is read in full, and the notes go on its
 * empty right-hand side.
 */
export function planCodeScene(
  code: ResolvedCode,
  options: { hasNotes: boolean; hasCaption: boolean },
): CodeScenePlan {
  const maxHeight = CONTENT_H - (options.hasCaption ? CAPTION_RESERVE : 0);
  const wide = { mode: 'wide', maxWidth: CONTENT_W, maxHeight } as const;
  if (!options.hasNotes) return wide;
  const sideWidth = CONTENT_W - NOTE_GAP - NOTE_W;
  const plan = (maxWidth: number) => planCodeView(code, { width: 'fit', minWidth: 760, maxWidth, maxHeight });
  const narrow = plan(sideWidth);
  const full = plan(CONTENT_W);
  const free =
    narrow.rows === full.rows && narrow.hidden <= full.hidden && narrow.fontSize >= full.fontSize - 3;
  return free ? { mode: 'side', maxWidth: sideWidth, maxHeight } : wide;
}

const CODE_CSS = `
.ms-code__stage { position: absolute; }
.ms-code__win { position: absolute; left: 0; top: 0; transform-origin: 50% 30%; }
.ms-code__bar {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 0;
  height: 0;
  border-radius: 10px;
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 70%, transparent), 0 0 40px var(--accent-soft);
}
.ms-code__note { position: absolute; pointer-events: none; }
.ms-code__card {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  padding: 22px 28px 24px 34px;
  border-radius: 22px;
  box-shadow: var(--shadow-card), inset 6px 0 0 var(--accent);
}
.ms-code__text {
  font-size: 26px;
  font-weight: 500;
  line-height: 1.38;
  letter-spacing: -0.005em;
  color: var(--text-0);
  text-wrap: pretty;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  overflow: hidden;
}
.ms-code__pointer { position: absolute; overflow: visible; color: var(--accent); display: none; }
.ms-code__shaft { fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; }
.ms-code__head { fill: currentColor; }
.ms-code__caption {
  position: absolute;
  padding-left: 22px;
  border-left: 4px solid color-mix(in srgb, var(--accent-2) 70%, transparent);${CAPTION_TEXT_CSS}
}
`;

/** Size of the arrow that joins a card to the focus bar, in px. */
const ARROW_H = 18;
const HEAD_LEN = 16;
const NOTCH_W = 26;
const NOTCH_H = 16;

export const codeTemplate: TemplateFactory<CodeResolved> = (visual, ctx) => {
  css('code', CODE_CSS);
  const { sw } = ctx;
  const { code } = visual;
  const hasNotes = visual.focus.some((f) => (f.note ?? '').trim() !== '');
  const caption = (visual.caption ?? '').trim() || null;

  const scene = planCodeScene(code, { hasNotes, hasCaption: caption !== null });
  const tagText = visual.mode === 'diff' ? 'Diff' : code.side === 'base' ? 'Snippet · before' : 'Snippet';
  const view = renderCodeView(code, {
    width: 'fit',
    minWidth: 760,
    maxWidth: scene.maxWidth,
    maxHeight: scene.maxHeight,
    barExtras: [h('span', { class: 'ms-codeview__tag', text: tagText })],
    barExtrasWidth: Math.ceil(tagText.length * 12.5) + 40,
  });
  const { width: winW, height: winH, barHeight } = view.metrics;
  const side = scene.mode === 'side';
  const groupW = side ? winW + NOTE_GAP + NOTE_W : winW;
  const groupH = winH + (caption ? CAPTION_RESERVE : 0);
  const stageLeft = Math.round((CONTENT_W - groupW) / 2);
  const stageTop = Math.max(0, Math.round((CONTENT_H - groupH) / 2));

  const winWrap = h(
    'div',
    { class: 'ms-code__win', style: { width: `${winW}px`, height: `${winH}px` } },
    view.root,
  );
  const stage = h(
    'div',
    {
      class: 'ms-code__stage',
      style: {
        left: `${stageLeft}px`,
        top: `${stageTop}px`,
        width: `${groupW}px`,
        height: `${groupH}px`,
      },
    },
    winWrap,
  );
  const root = h('div', { class: 'ms-content ms-code' }, stage);

  // Focus ranges in time order, resolved to rendered lines once.
  const lineCount = view.lines.length;
  const focus = visual.focus
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.beat - b.f.beat || a.i - b.i)
    .map((x) => x.f);
  const bars = focus.map((f) => {
    const range = focusIndexRange(code, f.startLine, f.endLine);
    if (!range || range.first >= lineCount) return null;
    const last = Math.min(range.last, lineCount - 1);
    const top = view.lineTop(range.first) - 4;
    return { first: range.first, last, top, height: view.lineTop(last) + view.lineSpan(last) + 4 - top };
  });
  const starts = focusStarts(ctx.withStarts(focus, 0).map((f) => f.start));

  const bar = h('div', { class: 'ms-code__bar' });
  view.overlay.append(bar);

  const notes = focus.map((f, k) => {
    const text = (f.note ?? '').trim();
    if (text === '') return null;
    const pointer = s(
      'svg',
      { class: 'ms-code__pointer', width: 0, height: 0 },
      s('path', { class: 'ms-code__shaft', d: '' }),
      s('path', { class: 'ms-code__head', d: '' }),
    );
    const card = h(
      'div',
      { class: 'ms-card ms-card--raised ms-code__card' },
      h('div', { class: 'ms-code__text', text }),
    );
    const wrap = h('div', { class: 'ms-code__note' }, card, pointer);
    stage.append(wrap);
    return { wrap, card, pointer, k, chars: text.length, dx: 0, dy: 0 };
  });

  /** Measure each card, then put it where it covers no code (see placeCallout). */
  const place = () => {
    const area: Box = { x: -stageLeft, y: -stageTop, w: CONTENT_W, h: CONTENT_H };
    const window: Box = { x: 0, y: 0, w: winW, h: winH };
    const inner: Box = { x: 0, y: barHeight, w: winW, h: winH - barHeight - view.metrics.footer };
    for (const n of notes) {
      if (!n) continue;
      const b = bars[n.k];
      const sizeFor = (width: number) => {
        n.card.style.height = '';
        n.card.style.width = `${width}px`;
        n.wrap.style.width = `${width}px`;
        const measured = n.card.offsetHeight;
        return { w: width, h: measured > 0 ? measured : 56 + Math.ceil(n.chars / 22) * 36 };
      };
      const placement = placeCallout({
        area,
        window,
        inner,
        focus: b ? { top: b.top, bottom: b.top + b.height } : null,
        ink: view.ink,
        sizeFor,
        widths: side ? [NOTE_W] : NOTE_WIDTHS,
        gap: NOTE_GAP,
        underLimit: caption ? undefined : area.y + area.h,
      });
      sizeFor(placement.w);
      n.wrap.style.left = `${Math.round(placement.x)}px`;
      n.wrap.style.top = `${Math.round(placement.y)}px`;
      n.wrap.style.height = `${Math.round(placement.h)}px`;
      n.card.style.height = `${Math.round(placement.h)}px`;
      n.dx = placement.kind === 'side' ? -18 : 0;
      n.dy =
        placement.kind === 'above' || placement.kind === 'top' ? 14 : placement.kind === 'side' ? 0 : -14;
      aim(n.pointer, placement, b ? { top: b.top, bottom: b.top + b.height } : null, winW);
    }
  };

  const captionEl = caption
    ? captionBlock('ms-code__caption', caption, {
        left: '0px',
        top: `${winH + 24}px`,
        width: `${groupW}px`,
        'max-height': '76px',
      })
    : null;
  if (captionEl) stage.append(captionEl.el);

  const rowStart = (i: number) => 0.12 + i * Math.min(0.045, 0.45 / Math.max(1, lineCount));

  const instance: SceneInstance = {
    root,
    layout() {
      place();
      captionEl?.fit();
    },
    update(t) {
      enterWindow(sw, winWrap, t);
      captionEl?.reveal(sw, t, 0.4);

      // Which focus range is active, and how far its slide has progressed.
      let k = -1;
      for (let i = 0; i < starts.length; i++) if (t >= (starts[i] as number)) k = i;
      const e = k >= 0 ? enter(t, starts[k] as number, 0.6, ease.inOutCubic) : 0;
      const dim = k < 0 ? 0 : k === 0 ? e : 1;
      // A range that matched no row dims nothing.
      const weight = (index: number, row: number) => {
        const b = bars[index];
        return !b ? 1 : row >= b.first && row <= b.last ? 1 : 0;
      };
      for (let i = 0; i < lineCount; i++) {
        const current = k >= 0 ? weight(k, i) : 1;
        const previous = k >= 1 ? weight(k - 1, i) : current;
        const amount = k >= 1 ? lerp(previous, current, e) : current;
        view.setEmphasis(sw, i, lerp(1, amount, dim), enter(t, rowStart(i), 0.35));
      }

      const curBar = k >= 0 ? (bars[k] ?? null) : null;
      const prevBar = k >= 1 ? (bars[k - 1] ?? null) : null;
      if (!curBar && !prevBar) {
        sw.opacity(bar, 0);
      } else {
        const to = (curBar ?? prevBar)!;
        const from = (prevBar ?? curBar)!;
        const slide = curBar && prevBar ? e : curBar ? 1 : 0;
        sw.style(bar, 'top', `${q(lerp(from.top, to.top, slide), 1)}px`);
        sw.style(bar, 'height', `${q(lerp(from.height, to.height, slide), 1)}px`);
        sw.opacity(bar, curBar && prevBar ? 1 : curBar ? e : 1 - e);
      }

      for (const n of notes) {
        if (!n) continue;
        const appear = enter(t, (starts[n.k] as number) + 0.12, 0.5);
        const leave = n.k < starts.length - 1 ? enter(t, starts[n.k + 1] as number, 0.3) : 0;
        sw.opacity(n.wrap, appear * (1 - leave));
        const dx = lerp(n.dx, 0, appear) + lerp(0, -n.dx * 0.75, leave);
        const dy = lerp(n.dy, 0, appear) + lerp(0, -n.dy * 0.75, leave);
        sw.transform(n.wrap, `translate(${q(dx, 2)}px, ${q(dy, 2)}px)`);
      }
    },
  };
  return instance;
};

/** A card closer to the focus bar than this gets an arrowhead on its edge; a farther one a leader line. */
const NEAR_BAR = 48;
/** Distance of a leader line from the window's right edge, in px. */
const LEADER_INSET = 13;

/**
 * Draw what joins a card to the focus bar. A card beside the window gets a long arrow across the
 * gap, pointing at the bar's end. A card on the window next to the bar gets a short arrowhead on
 * the edge that faces it. A card on the window but farther away gets a leader line that runs down
 * the empty strip at the window's right edge to the bar, so the line never crosses code. A card
 * above or under the window gets the arrowhead too, pointing at the window.
 */
function aim(
  pointer: SVGSVGElement,
  placement: Placement,
  focus: { top: number; bottom: number } | null,
  winW: number,
): void {
  const shaft = pointer.children[0] as SVGElement;
  const head = pointer.children[1] as SVGElement;
  const set = (left: number, top: number, w: number, hh: number, shaftD: string, headD: string) => {
    pointer.style.display = 'block';
    pointer.style.left = `${left}px`;
    pointer.style.top = `${top}px`;
    pointer.setAttribute('width', String(w));
    pointer.setAttribute('height', String(hh));
    pointer.setAttribute('viewBox', `0 0 ${w} ${hh}`);
    shaft.setAttribute('d', shaftD);
    head.setAttribute('d', headD);
  };
  if (!focus) {
    pointer.style.display = 'none';
    return;
  }
  if (placement.kind === 'side') {
    // From the card's left edge to a little inside the window, level with the middle of the bar.
    const length = Math.max(40, placement.x - (winW - 10));
    const mid = (focus.top + focus.bottom) / 2;
    const y = Math.max(placement.y + 30, Math.min(placement.y + placement.h - 30, mid)) - placement.y;
    set(
      -length,
      y - ARROW_H / 2,
      length,
      ARROW_H,
      `M${length - 2} ${ARROW_H / 2}H${HEAD_LEN - 2}`,
      `M${HEAD_LEN + 2} 2.5L4 ${ARROW_H / 2}l${HEAD_LEN - 2} 6.5z`,
    );
    return;
  }
  const up = placement.kind !== 'above' && placement.kind !== 'top';
  const outside = placement.kind === 'top' || placement.kind === 'under';
  const gap = up ? placement.y - focus.bottom : focus.top - (placement.y + placement.h);
  if (gap <= NEAR_BAR || outside) {
    // An arrowhead on the card edge that faces the bar.
    const x = Math.max(24, placement.w - 64);
    if (up) set(x, -NOTCH_H + 1, NOTCH_W, NOTCH_H, '', `M0 ${NOTCH_H}H${NOTCH_W}L${NOTCH_W / 2} 0z`);
    else set(x, placement.h - 1, NOTCH_W, NOTCH_H, '', `M0 0H${NOTCH_W}L${NOTCH_W / 2} ${NOTCH_H}z`);
    return;
  }
  // A leader line: out of the card's right edge, along the window's edge, to the bar.
  const lineX = winW - LEADER_INSET - placement.x;
  const startY = placement.h / 2;
  const targetY = up ? focus.bottom + 1 - placement.y : focus.top - 1 - placement.y;
  const pad = 14;
  const top = Math.min(startY, targetY) - pad;
  const boxH = Math.abs(targetY - startY) + 2 * pad;
  const left = placement.w - 2;
  const boxW = lineX - left + 12;
  const sy = startY - top;
  const ty = targetY - top;
  const dir = up ? 1 : -1;
  set(
    left,
    top,
    boxW,
    boxH,
    `M2 ${sy}H${lineX - left}V${ty + dir * (HEAD_LEN - 4)}`,
    `M${lineX - left} ${ty}l-9 ${dir * HEAD_LEN}h18z`,
  );
}
