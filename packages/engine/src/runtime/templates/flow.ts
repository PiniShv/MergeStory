/** Sequence diagram: actor cards with lifelines, one arrow per step, the current step highlighted. */
import { CONTENT_H, CONTENT_W, type FlowResolved } from '../../core/render-plan.ts';
import { clamp01, enter, lerp, q } from '../anim.ts';
import { css, h, s } from '../dom.ts';
import { fitLines } from '../fit.ts';
import { icon } from '../icons.ts';
import type { SceneInstance, TemplateFactory } from '../types.ts';

const HEADER_H = 84;
const HEADER_GAP = 20;
const BOTTOM_PAD = 8;
const MIN_GAP = 64;
const MAX_GAP = 112;
const LABEL_LH = 1.15;
const DETAIL_H = 26;
const DIM = 0.72;
const LOOP_W = 64;
/** Widest a step label may become when it runs past its arrow. */
const MAX_LABEL_W = 1200;
const LOOP_H = 24;

export interface FlowPlan {
  /** Width of one actor column. */
  colW: number;
  cardW: number;
  /** Vertical distance between steps. */
  stepGap: number;
  totalH: number;
  /** Top of the diagram inside the content area. */
  offsetY: number;
  labelFont: number;
}

/** Sizes for a sequence diagram with the given number of actors and steps. */
export function planFlow(actors: number, steps: number): FlowPlan {
  const n = Math.max(1, actors);
  const colW = CONTENT_W / n;
  const cardW = Math.round(Math.min(Math.max(colW - 32, 200), 340));
  const avail = CONTENT_H - HEADER_H - HEADER_GAP - BOTTOM_PAD;
  const stepGap = Math.max(MIN_GAP, Math.min(MAX_GAP, Math.floor(avail / Math.max(1, steps))));
  const totalH = HEADER_H + HEADER_GAP + Math.max(1, steps) * stepGap + BOTTOM_PAD;
  return {
    colW,
    cardW,
    stepGap,
    totalH,
    offsetY: Math.max(0, Math.round((CONTENT_H - totalH) / 2 - 8)),
    labelFont: stepGap >= 100 ? 28 : stepGap >= 84 ? 26 : 24,
  };
}

/** Centre x of an actor's lifeline. */
export function lifelineX(index: number, actors: number): number {
  return (CONTENT_W / Math.max(1, actors)) * (index + 0.5);
}

let nextId = 0;

const FLOW_CSS = `
.ms-flow__svg { position: absolute; left: 0; overflow: visible; }
.ms-flow__life { stroke: var(--border-2); stroke-width: 2.5; stroke-dasharray: 3 11; stroke-linecap: round; }
.ms-flow__line { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.ms-flow__line--request { stroke: var(--accent); stroke-width: 4; }
.ms-flow__line--response { stroke: var(--text-1); stroke-width: 3; stroke-dasharray: 11 9; stroke-linecap: butt; }
.ms-flow__line--event { stroke: var(--accent-2); stroke-width: 4.5; stroke-dasharray: 0.1 11; }
.ms-flow__line--call { stroke: var(--text-1); stroke-width: 2.5; }
.ms-flow__glow { fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-width: 12; opacity: 0.16; }
.ms-flow__glow--request { stroke: var(--accent); }
.ms-flow__glow--response { stroke: var(--text-1); }
.ms-flow__glow--event { stroke: var(--accent-2); }
.ms-flow__glow--call { stroke: var(--text-1); }
.ms-flow__head--request { fill: var(--accent); }
.ms-flow__head--event { fill: var(--accent-2); }
.ms-flow__head--call { fill: var(--text-1); }
.ms-flow__head--response { fill: none; stroke: var(--text-1); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }

.ms-flow__actor {
  position: absolute;
  top: 0;
  height: ${HEADER_H}px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 22px 0 18px;
  border-radius: 24px;
  background: var(--surface-2);
  box-shadow: var(--shadow-lift), 0 0 0 1.5px var(--border-2);
}
.ms-flow__ring {
  position: absolute;
  inset: -3px;
  border-radius: 27px;
  box-shadow: 0 0 0 2.5px var(--accent), 0 0 36px var(--accent-soft);
  pointer-events: none;
}
.ms-flow__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 54px;
  height: 54px;
  border-radius: 16px;
  color: var(--accent-2);
  background: var(--accent-2-soft);
}
.ms-flow__name {
  min-width: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.15;
  color: var(--text-0);
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.ms-flow__label {
  position: absolute;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
  font-weight: 650;
  line-height: ${LABEL_LH};
  letter-spacing: -0.01em;
  color: var(--text-0);
}
.ms-flow__detail {
  position: absolute;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
  font-size: 22px;
  font-weight: 500;
  line-height: ${DETAIL_H}px;
  height: ${DETAIL_H}px;
  color: var(--text-2);
}
.ms-flow__label--self, .ms-flow__detail--self { text-align: left; }
`;

type Step = FlowResolved['steps'][number];

export const flowTemplate: TemplateFactory<FlowResolved> = (visual, ctx) => {
  css('flow', FLOW_CSS);
  const { sw } = ctx;
  const index = new Map(visual.actors.map((a, i) => [a.id, i]));
  const steps = visual.steps.filter((st) => index.has(st.from) && index.has(st.to));
  const plan = planFlow(visual.actors.length, steps.length);
  const { stepGap, labelFont } = plan;
  const labelH = Math.round(labelFont * LABEL_LH);
  const stepsTop = HEADER_H + HEADER_GAP;
  const lifeBottom = stepsTop + steps.length * stepGap + 6;
  const xOf = (id: string) => lifelineX(index.get(id) as number, visual.actors.length);
  const uid = nextId++;

  const diagram = h('div', {
    style: {
      position: 'absolute',
      left: '0px',
      top: `${plan.offsetY}px`,
      width: `${CONTENT_W}px`,
      height: `${plan.totalH}px`,
    },
  });
  const root = h('div', { class: 'ms-content ms-flow' }, diagram);
  const defs = s('defs');
  const svg = s(
    'svg',
    {
      class: 'ms-flow__svg',
      width: CONTENT_W,
      height: plan.totalH,
      viewBox: `0 0 ${CONTENT_W} ${plan.totalH}`,
    },
    defs,
  );
  diagram.append(svg);

  // Actors and lifelines.
  const actors = visual.actors.map((actor, i) => {
    const x = lifelineX(i, visual.actors.length);
    const ring = h('div', { class: 'ms-flow__ring' });
    const el = h(
      'div',
      {
        class: 'ms-flow__actor',
        style: { left: `${Math.round(x - plan.cardW / 2)}px`, width: `${plan.cardW}px` },
      },
      ring,
      h('div', { class: 'ms-flow__icon' }, icon(actor.kind, { size: 32, stroke: 1.8 })),
      h('div', { class: 'ms-flow__name', text: actor.label }),
    );
    const life = s('line', { class: 'ms-flow__life', x1: x, y1: HEADER_H, x2: x, y2: HEADER_H });
    svg.append(life);
    diagram.append(el);
    return { el, ring, life, x, start: 0.1 + i * 0.09 };
  });

  // Steps.
  const built = ctx.withStarts(steps, 0.35).map((step: Step & { start: number }, i) => {
    const fromX = xOf(step.from);
    const toX = xOf(step.to);
    const self = step.from === step.to;
    const slotTop = stepsTop + i * stepGap;
    const y = slotTop + labelH + 8;
    const dir = toX >= fromX ? 1 : -1;
    const group = s('g');
    const clipId = `ms-flow-${uid}-${i}`;
    const clipRect = s('rect', { x: fromX, y: y - 24, width: 0, height: 48 });
    let glow: SVGElement;
    let line: SVGElement;
    let head: SVGElement;
    if (self) {
      const d = `M${fromX + 3} ${y - 2}H${fromX + LOOP_W - 12}Q${fromX + LOOP_W} ${y - 2} ${fromX + LOOP_W} ${y + 10}Q${fromX + LOOP_W} ${y + LOOP_H} ${fromX + LOOP_W - 12} ${y + LOOP_H}H${fromX + 14}`;
      glow = s('path', { class: `ms-flow__glow ms-flow__glow--${step.kind}`, d });
      line = s('path', { class: `ms-flow__line ms-flow__line--${step.kind}`, d });
      head = s('path', {
        class: `ms-flow__head--${step.kind}`,
        d: headPath(step.kind),
        transform: `translate(${fromX + 4} ${y + LOOP_H}) rotate(180)`,
      });
    } else {
      const x1 = fromX + dir * 6;
      const x2 = toX - dir * 3;
      const d = `M${x1} ${y}H${x2 - dir * 12}`;
      glow = s('path', { class: `ms-flow__glow ms-flow__glow--${step.kind}`, d });
      line = s('path', { class: `ms-flow__line ms-flow__line--${step.kind}`, d });
      head = s('path', {
        class: `ms-flow__head--${step.kind}`,
        d: headPath(step.kind),
        transform: `translate(${x2} ${y}) rotate(${dir > 0 ? 0 : 180})`,
      });
    }
    defs.append(s('clipPath', { id: clipId }, clipRect));
    group.append(glow, line, head);
    if (!self) group.setAttribute('clip-path', `url(#${clipId})`);
    svg.append(group);

    const span = Math.abs(toX - fromX);
    // A label may be wider than its arrow: every step has a row of its own, so it can run on over the
    // lifelines on both sides, as far as the area allows.
    const mid = (fromX + toX) / 2;
    const labelW = self
      ? CONTENT_W - fromX - LOOP_W - 28
      : Math.max(span - 28, Math.min(2 * Math.min(mid, CONTENT_W - mid) - 16, MAX_LABEL_W));
    const left = self ? fromX + LOOP_W + 20 : mid - labelW / 2;
    const label = h('div', {
      class: `ms-flow__label${self ? ' ms-flow__label--self' : ''}`,
      text: step.label,
      style: {
        left: `${Math.round(left)}px`,
        top: `${slotTop}px`,
        width: `${Math.round(labelW)}px`,
        'font-size': `${labelFont}px`,
      },
    });
    const detailText = (step.detail ?? '').trim();
    const detail = detailText
      ? h('div', {
          class: `ms-flow__detail${self ? ' ms-flow__detail--self' : ''}`,
          text: detailText,
          style: { left: `${Math.round(left)}px`, top: `${y + 8}px`, width: `${Math.round(labelW)}px` },
        })
      : null;
    diagram.append(label);
    if (detail) diagram.append(detail);
    return {
      step,
      from: index.get(step.from) as number,
      to: index.get(step.to) as number,
      self,
      group,
      glow,
      line,
      head,
      clipRect,
      fromX,
      toX,
      dir,
      label,
      detail,
      start: step.start,
    };
  });

  const maxRevealW = (b: (typeof built)[number]) => Math.abs(b.toX - b.fromX) + 24;

  const instance: SceneInstance = {
    root,
    /** Actor names keep whole words: the type comes down to 22 px before a word is broken. */
    layout() {
      for (const a of actors) {
        const name = a.el.querySelector('.ms-flow__name') as HTMLElement | null;
        if (!name) continue;
        const size = fitLines(name, { max: 28, min: 22, maxLines: 2, lineHeight: 1.15, step: 1 });
        if (name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1) {
          name.style.overflowWrap = 'anywhere';
          name.style.fontSize = `${size}px`;
        }
      }
    },
    update(t) {
      for (const a of actors) {
        const p = enter(t, a.start, 0.5);
        sw.opacity(a.el, p);
        sw.transform(a.el, `translate(0px, ${q((1 - p) * 18, 2)}px)`);
        sw.attr(a.life, 'y2', String(q(lerp(HEADER_H, lifeBottom, enter(t, a.start + 0.3, 0.9)), 1)));
      }
      // The current step is the latest one that has started.
      let current = -1;
      for (let i = 0; i < built.length; i++) if (t >= (built[i] as (typeof built)[number]).start) current = i;
      const progressNow = current >= 0 ? enter(t, (built[current] as (typeof built)[number]).start, 0.45) : 0;
      const involved = (stepIndex: number, actorIndex: number) => {
        const b = built[stepIndex];
        return b && (b.from === actorIndex || b.to === actorIndex) ? 1 : 0;
      };
      actors.forEach((a, i) => {
        const before = current >= 1 ? involved(current - 1, i) : 0;
        const now = current >= 0 ? involved(current, i) : 0;
        sw.opacity(a.ring, lerp(before, now, progressNow));
      });

      built.forEach((b, i) => {
        const appear = enter(t, b.start, 0.5);
        const next = built[i + 1];
        const dimmed = next ? enter(t, next.start, 0.4) : 0;
        const level = appear * lerp(1, DIM, dimmed);
        sw.opacity(b.label, level);
        sw.transform(b.label, `translate(0px, ${q((1 - appear) * 10, 2)}px)`);
        if (b.detail) {
          sw.opacity(b.detail, level);
          sw.transform(b.detail, `translate(0px, ${q((1 - appear) * 10, 2)}px)`);
        }
        if (b.self) {
          sw.opacity(b.group, level);
        } else {
          // The arrow grows out of the sender's lifeline.
          const grow = enter(t, b.start + 0.05, 0.5);
          const w = maxRevealW(b) * grow;
          sw.attr(b.clipRect, 'x', String(q(b.dir > 0 ? b.fromX - 12 : b.fromX + 12 - w, 1)));
          sw.attr(b.clipRect, 'width', String(q(w, 1)));
          sw.opacity(b.group, clamp01(grow * 20) * lerp(1, DIM, dimmed));
        }
        sw.opacity(b.glow, 0.16 * appear * (1 - dimmed));
      });
    },
  };
  return instance;
};

/** Arrowhead outline with its tip at the origin, pointing right. */
function headPath(kind: Step['kind']): string {
  switch (kind) {
    case 'response':
      return 'M-15 -9L0 0L-15 9';
    case 'call':
      return 'M0 0L-14 -7.5L-14 7.5Z';
    default:
      return 'M0 0L-18 -10L-18 10Z';
  }
}
