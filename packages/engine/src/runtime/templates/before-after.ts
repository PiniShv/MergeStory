/** Two panels side by side: "before" appears first, then "after" wipes in beside it. */
import {
  type BeforeAfterResolved,
  CONTENT_H,
  CONTENT_W,
  type ResolvedPanel,
} from '../../core/render-plan.ts';
import { ease, enter, lerp, q } from '../anim.ts';
import { planCodeView, renderCodeView } from '../code-view.ts';
import { css, h } from '../dom.ts';
import { fitText } from '../fit.ts';
import { icon } from '../icons.ts';
import { pop } from '../motion.ts';
import type { SceneContext, SceneInstance, TemplateFactory } from '../types.ts';
import {
  CAPTION_RESERVE,
  CAPTION_TEXT_CSS,
  captionBlock,
  fitImage,
  isDataImage,
  WINDOW_BAR_H,
  windowFrame,
} from './parts.ts';
import { createTerminalView, planTerminal } from './terminal.ts';

/** Space between the panels; the arrow badge sits in it. */
const GAP = 120;
const PANEL_W = (CONTENT_W - GAP) / 2;
const LABEL_H = 46;
const LABEL_GAP = 18;
const MIN_PANEL_H = 320;
const BULLET_PAD = 36;

interface PanelBody {
  el: HTMLElement;
  update(t: number): void;
  layout?: () => void;
}

/** When the "before" and "after" panels start, in scene seconds, given when the first two beats appear. */
export function panelStarts(beatStarts: readonly number[]): { before: number; after: number } {
  const before = Math.max(0.1, beatStarts[0] ?? 0);
  const second = beatStarts[1];
  const after = second === undefined ? before + 1.4 : Math.max(second, before + 0.9);
  return { before, after };
}

function naturalHeight(panel: ResolvedPanel, avail: number): number {
  switch (panel.kind) {
    case 'code':
      return planCodeView(panel.code, { width: PANEL_W, maxHeight: avail, compact: true }).height;
    case 'terminal':
      return planTerminal({ lineCount: panel.terminal.length, maxHeight: avail, compact: true }).height;
    case 'bullets':
      return 2 * BULLET_PAD + Math.max(1, panel.bullets.length) * 76;
    case 'screenshot':
      return (
        fitImage(panel.image.width, panel.image.height, PANEL_W, avail - WINDOW_BAR_H).height + WINDOW_BAR_H
      );
    default:
      panel satisfies never;
      throw new Error('A before and after panel has an unknown kind.');
  }
}

function buildBody(
  panel: ResolvedPanel,
  ctx: SceneContext,
  o: { height: number; start: number; planLines: number; maxFont: number },
): PanelBody {
  const { sw } = ctx;
  switch (panel.kind) {
    case 'code': {
      const view = renderCodeView(panel.code, {
        width: PANEL_W,
        maxHeight: o.height,
        height: o.height,
        compact: true,
        planLines: o.planLines,
        maxFont: o.maxFont,
      });
      const rows = view.lines.length;
      const stagger = Math.min(0.04, 0.5 / Math.max(1, rows));
      return {
        el: view.root,
        update(t) {
          for (let i = 0; i < rows; i++)
            view.setEmphasis(sw, i, 1, enter(t, o.start + 0.15 + i * stagger, 0.3));
        },
      };
    }
    case 'terminal': {
      const view = createTerminalView(panel.terminal, ctx, {
        width: PANEL_W,
        maxHeight: o.height,
        height: o.height,
        compact: true,
        title: null,
        note: 'Illustrative',
        minStart: o.start + 0.3,
      });
      return { el: view.root, update: (t) => view.update(t) };
    }
    case 'bullets': {
      const items = panel.bullets.map((text) =>
        h(
          'li',
          { class: 'ms-ba__bullet' },
          h('span', { class: 'ms-ba__dot' }),
          h('span', { class: 'ms-ba__bullet-text', text }),
        ),
      );
      const list = h('ul', { class: 'ms-ba__list' }, ...items);
      const el = h(
        'div',
        { class: 'ms-card ms-ba__card', style: { width: `${PANEL_W}px`, height: `${o.height}px` } },
        list,
      );
      return {
        el,
        layout: () => {
          fitText(list, { max: 30, min: 22, maxHeight: o.height - 2 * BULLET_PAD });
        },
        update(t) {
          items.forEach((li, i) => {
            const p = enter(t, o.start + 0.2 + i * 0.12, 0.5);
            sw.opacity(li, p);
            sw.transform(li, `translate(0px, ${q((1 - p) * 16, 2)}px)`);
          });
        },
      };
    }
    case 'screenshot': {
      // Only an embedded image is drawn; any other source gets a placeholder that says so, as the screenshot scene does.
      if (!isDataImage(panel.image.src)) {
        return {
          el: h(
            'div',
            {
              class: 'ms-card ms-ba__card ms-ba__empty',
              style: { width: `${PANEL_W}px`, height: `${o.height}px` },
            },
            'Image unavailable',
          ),
          update: () => {},
        };
      }
      const fit = fitImage(panel.image.width, panel.image.height, PANEL_W, o.height - WINDOW_BAR_H);
      const img = h('img', { class: 'ms-ba__img', attrs: { src: panel.image.src, alt: panel.label } });
      const win = windowFrame({
        class: 'ms-ba__shot',
        style: {
          width: `${fit.width}px`,
          height: `${fit.height + WINDOW_BAR_H}px`,
          left: `${Math.round((PANEL_W - fit.width) / 2)}px`,
          top: `${Math.round((o.height - fit.height - WINDOW_BAR_H) / 2)}px`,
        },
        barHeight: WINDOW_BAR_H,
        body: h('div', { class: 'ms-window__body' }, img),
      });
      return { el: h('div', { class: 'ms-ba__shotbox' }, win), update: () => {} };
    }
    default:
      panel satisfies never;
      throw new Error('A before and after panel has an unknown kind.');
  }
}

const BEFORE_AFTER_CSS = `
.ms-ba__panel { position: absolute; top: 0; width: ${PANEL_W}px; }
.ms-ba__label {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  height: ${LABEL_H}px;
  padding: 0 22px;
  border-radius: var(--radius-pill);
  font-size: 24px;
  font-weight: 750;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  white-space: nowrap;
}
.ms-ba__label::before { content: ''; width: 12px; height: 12px; border-radius: 50%; background: currentColor; }
.ms-ba__label--before { color: var(--text-1); background: var(--surface-inset); box-shadow: 0 0 0 1px var(--border-2); }
.ms-ba__label--after {
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}
.ms-ba__body { position: absolute; left: 0; width: ${PANEL_W}px; overflow: visible; }
.ms-ba__card { padding: ${BULLET_PAD}px 40px; display: flex; align-items: center; overflow: hidden; }
.ms-ba__empty { justify-content: center; font-size: 24px; color: var(--text-3); }
.ms-ba__list { list-style: none; width: 100%; display: flex; flex-direction: column; gap: 0.62em; font-size: 30px; }
.ms-ba__bullet { display: flex; align-items: flex-start; gap: 0.6em; line-height: 1.32; font-weight: 500; color: var(--text-0); }
.ms-ba__dot { flex: none; width: 0.38em; height: 0.38em; margin-top: 0.5em; border-radius: 50%; background: var(--accent-2); }
.ms-ba__bullet-text { min-width: 0; overflow-wrap: anywhere; }
.ms-ba__shotbox { position: absolute; inset: 0; }
.ms-ba__shot { position: absolute; }
.ms-ba__img { display: block; width: 100%; height: 100%; }
.ms-ba__arrow-pos { position: absolute; width: 0; height: 0; }
.ms-ba__arrow {
  display: grid;
  place-items: center;
  width: 76px;
  height: 76px;
  margin: -38px 0 0 -38px;
  border-radius: 50%;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 16px 36px -12px color-mix(in srgb, var(--glow) 70%, transparent), inset 0 0 0 1px rgba(255, 255, 255, 0.28);
}
.ms-ba__caption {
  position: absolute;
  left: 0;
  width: ${CONTENT_W}px;
  text-align: center;${CAPTION_TEXT_CSS}
  max-height: 76px;
}
`;

export const beforeAfterTemplate: TemplateFactory<BeforeAfterResolved> = (visual, ctx) => {
  css('before-after', BEFORE_AFTER_CSS);
  const { sw } = ctx;
  const caption = (visual.caption ?? '').trim() || null;
  const avail = CONTENT_H - LABEL_H - LABEL_GAP - (caption ? CAPTION_RESERVE : 0);
  const panelH = Math.round(
    Math.max(
      MIN_PANEL_H,
      Math.min(avail, Math.max(naturalHeight(visual.before, avail), naturalHeight(visual.after, avail))),
    ),
  );
  const groupH = LABEL_H + LABEL_GAP + panelH + (caption ? CAPTION_RESERVE : 0);
  const top = Math.max(0, Math.round((CONTENT_H - groupH) / 2));

  const beats = ctx.withStarts(
    ctx.scene.beats.map((_, i) => ({ beat: i })),
    0,
  );
  const start = panelStarts(beats.map((b) => b.start));
  // Two code panels share a font size so they read as a pair.
  const codes = [visual.before, visual.after].flatMap((p) => (p.kind === 'code' ? [p.code] : []));
  const planLines = Math.max(1, ...codes.map((code) => code.lines.length));
  const codeFonts = codes.map(
    (code) =>
      planCodeView(code, { width: PANEL_W, maxHeight: panelH, height: panelH, compact: true, planLines })
        .fontSize,
  );
  const maxFont = Math.min(26, ...codeFonts);

  const make = (panel: ResolvedPanel, side: 'before' | 'after', x: number, at: number) => {
    const body = buildBody(panel, ctx, { height: panelH, start: at, planLines, maxFont });
    const bodyBox = h(
      'div',
      { class: 'ms-ba__body', style: { top: `${LABEL_H + LABEL_GAP}px`, height: `${panelH}px` } },
      body.el,
    );
    const label = h('div', { class: `ms-ba__label ms-ba__label--${side}`, text: panel.label });
    const el = h(
      'div',
      { class: 'ms-ba__panel', style: { left: `${x}px`, height: `${LABEL_H + LABEL_GAP + panelH}px` } },
      label,
      bodyBox,
    );
    return { el, label, bodyBox, body };
  };
  const before = make(visual.before, 'before', 0, start.before);
  const after = make(visual.after, 'after', PANEL_W + GAP, start.after);

  const arrowPos = h('div', {
    class: 'ms-ba__arrow-pos',
    style: { left: `${PANEL_W + GAP / 2}px`, top: `${LABEL_H + LABEL_GAP + panelH / 2}px` },
  });
  const arrow = h('div', { class: 'ms-ba__arrow' }, icon('arrow', { size: 34, stroke: 2.6 }));
  arrowPos.append(arrow);

  const stage = h(
    'div',
    {
      style: {
        position: 'absolute',
        left: '0px',
        top: `${top}px`,
        width: `${CONTENT_W}px`,
        height: `${groupH}px`,
      },
    },
    before.el,
    after.el,
    arrowPos,
  );
  const root = h('div', { class: 'ms-content ms-ba' }, stage);

  const captionEl = caption
    ? captionBlock('ms-ba__caption', caption, { top: `${LABEL_H + LABEL_GAP + panelH + 24}px` })
    : null;
  if (captionEl) stage.append(captionEl.el);

  const instance: SceneInstance = {
    root,
    layout() {
      before.body.layout?.();
      after.body.layout?.();
      captionEl?.fit();
    },
    update(t) {
      const b = enter(t, start.before, 0.6);
      // The "before" side steps back a little once "after" arrives.
      const dim = lerp(1, 0.86, enter(t, start.after, 0.6));
      sw.opacity(before.el, b * dim);
      sw.transform(before.el, `translate(0px, ${q((1 - b) * 24, 2)}px)`);
      before.body.update(t);

      const labelIn = enter(t, start.after - 0.05, 0.5);
      sw.opacity(after.label, labelIn);
      sw.transform(after.label, `translate(0px, ${q((1 - labelIn) * 16, 2)}px)`);
      const wipe = enter(t, start.after, 0.75, ease.inOutCubic);
      sw.opacity(after.bodyBox, wipe === 0 ? 0 : 1);
      sw.style(after.bodyBox, 'clip-path', `inset(-40px ${q((1 - wipe) * 100, 2)}% -40px -40px round 24px)`);
      sw.transform(after.bodyBox, `translate(${q((wipe - 1) * 48, 2)}px, 0px)`);
      after.body.update(t);

      pop(sw, arrow, enter(t, start.after + 0.15, 0.6, ease.linear), 0.6);
      captionEl?.reveal(sw, t, start.after + 0.5);
    },
  };
  return instance;
};
