/** A reproduction: the steps as numbered rows that appear on their beats, each with its result and a small picture. */
import type { ReproResolved } from '../../core/render-plan.ts';
import { enter } from '../anim.ts';
import { css, h } from '../dom.ts';
import { fitLines } from '../fit.ts';
import { icon } from '../icons.ts';
import { rise } from '../motion.ts';
import type { SceneContext, SceneInstance, TemplateFactory } from '../types.ts';
import { fitImage, isDataImage } from './parts.ts';
import { createFramePlayer } from './recording.ts';

type Step = ReproResolved['steps'][number];

const REPRO_CSS = String.raw`
.ms-rp__head { display: flex; flex-direction: column; gap: 6px; padding-bottom: 4px; }
.ms-rp__title { font-size: 46px; font-weight: 750; letter-spacing: -0.025em; line-height: 1.15; padding-bottom: 0.06em; overflow-wrap: anywhere; }
.ms-rp__env {
  font-size: 24px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.ms-rp__list { display: flex; flex-direction: column; gap: var(--rp-gap, 12px); margin-top: 16px; }
.ms-rp__row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 24px;
  min-width: 0;
  padding: var(--rp-pad, 12px) 24px var(--rp-pad, 12px) 36px;
  border-radius: 20px;
  overflow: hidden;
  background: var(--surface-1);
}
.ms-rp__row--bug { --rp-tone: var(--del); }
.ms-rp__row--fixed { --rp-tone: var(--add); }
.ms-rp__stripe { position: absolute; left: 0; top: 0; bottom: 0; width: 10px; background: var(--rp-tone, var(--border-2)); }
.ms-rp__num {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  font-size: 26px;
  font-weight: 750;
  color: var(--rp-tone, var(--text-1));
  background: var(--surface-inset);
  box-shadow: inset 0 0 0 2px var(--rp-tone, var(--border-2));
}
.ms-rp__text {
  flex: 1;
  min-width: 0;
  font-size: var(--rp-text, 34px);
  font-weight: 550;
  line-height: 1.25;
  letter-spacing: -0.012em;
  color: var(--text-0);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--rp-lines, 2);
  overflow: hidden;
  overflow-wrap: anywhere;
}
.ms-rp__chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 18px 0 14px;
  border-radius: var(--radius-pill);
  font-size: 22px;
  font-weight: 750;
  letter-spacing: 0.04em;
  color: var(--text-1);
  background: var(--surface-inset);
  box-shadow: inset 0 0 0 1px var(--border-2);
}
.ms-rp__chip--bug { color: var(--del); background: color-mix(in srgb, var(--del) 16%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--del) 55%, transparent); }
.ms-rp__chip--fixed { color: var(--add); background: color-mix(in srgb, var(--add) 16%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--add) 55%, transparent); }
.ms-rp__thumb { flex: none; border-radius: 8px; overflow: hidden; background: var(--surface-code); box-shadow: 0 0 0 1px var(--border-2), 0 8px 18px -8px rgba(0, 0, 0, 0.5); }
.ms-rp__bar { display: flex; align-items: center; gap: 4px; padding-left: 7px; background: var(--surface-2); border-bottom: 1px solid var(--border-1); }
.ms-rp__bar i { width: 5px; height: 5px; border-radius: 50%; background: var(--text-3); opacity: 0.6; }
.ms-rp__room { flex: none; height: 1px; }
.ms-rp__pic { position: relative; }
.ms-rp__img { display: block; width: 100%; height: 100%; }
`;

const RESULT_WORDS = { expected: 'Expected', actual: 'Actual', bug: 'Bug', fixed: 'Fixed' } as const;

/** One set of sizes. The first level whose rows fit the content area is used. */
interface Level {
  thumbW: number;
  thumbH: number;
  bar: number;
  pad: number;
  gap: number;
  text: number;
  lines: number;
}

const LEVELS: Level[] = [
  { thumbW: 150, thumbH: 84, bar: 12, pad: 12, gap: 14, text: 34, lines: 3 },
  { thumbW: 150, thumbH: 84, bar: 12, pad: 10, gap: 12, text: 32, lines: 2 },
  { thumbW: 132, thumbH: 74, bar: 10, pad: 7, gap: 9, text: 30, lines: 2 },
  { thumbW: 116, thumbH: 65, bar: 10, pad: 5, gap: 8, text: 28, lines: 2 },
];

/** The small picture of a step in its frame, or null when the step has none. */
function thumbnail(
  step: Step,
  ctx: SceneContext,
): { el: HTMLElement; update(t: number): void; w: number; h: number } | null {
  const { thumb } = step;
  if (!thumb) return null;
  const alt = `Step ${step.number}`;
  const source = thumb.kind === 'screenshot' ? thumb.image : thumb.frames;
  const pic = h('div', { class: 'ms-rp__pic' });
  let update: (t: number) => void = () => undefined;
  if (thumb.kind === 'screenshot') {
    if (isDataImage(thumb.image.src)) {
      pic.append(h('img', { class: 'ms-rp__img', attrs: { src: thumb.image.src, alt } }));
    }
  } else {
    const player = createFramePlayer(thumb.frames, ctx, alt);
    pic.append(player.el);
    update = player.update;
  }
  const el = h(
    'div',
    { class: 'ms-rp__thumb' },
    h('div', { class: 'ms-rp__bar' }, h('i'), h('i'), h('i')),
    pic,
  );
  return { el, update, w: source.width, h: source.height };
}

export const reproTemplate: TemplateFactory<ReproResolved> = (visual, ctx) => {
  css('repro', REPRO_CSS);
  const { sw } = ctx;
  const steps = visual.steps.slice(0, 6);

  const title = h('div', { class: 'ms-rp__title ms-gradient-text', text: visual.title });
  const head = h(
    'div',
    { class: 'ms-rp__head' },
    title,
    visual.environment ? h('div', { class: 'ms-rp__env', text: visual.environment }) : null,
  );

  const rows = ctx.withStarts(steps).map((step) => {
    const thumb = thumbnail(step, ctx);
    const result = step.result;
    const chip = result
      ? h(
          'div',
          { class: `ms-rp__chip ms-rp__chip--${result}` },
          result === 'bug'
            ? icon('cross', { size: 22, stroke: 2.6 })
            : result === 'fixed'
              ? icon('check', { size: 22, stroke: 2.6 })
              : null,
          RESULT_WORDS[result],
        )
      : null;
    const el = h(
      'div',
      { class: `ms-rp__row${result === 'bug' || result === 'fixed' ? ` ms-rp__row--${result}` : ''}` },
      h('div', { class: 'ms-rp__stripe' }),
      h('div', { class: 'ms-rp__num', text: String(step.number) }),
      h('div', { class: 'ms-rp__text', text: step.text }),
      chip,
      thumb?.el,
    );
    // A step without a picture keeps the room of one, so that the results line up.
    const room = h('div', { class: 'ms-rp__room' });
    if (!thumb && visual.steps.some((other) => other.thumb)) el.append(room);
    return { el, chip, thumb, room, start: step.start };
  });
  const list = h('div', { class: 'ms-rp__list' }, ...rows.map((r) => r.el));
  const root = h('div', { class: 'ms-content' }, head, list);

  const apply = (level: Level) => {
    const set = (name: string, value: string) => root.style.setProperty(name, value);
    set('--rp-text', `${level.text}px`);
    set('--rp-lines', String(level.lines));
    set('--rp-pad', `${level.pad}px`);
    set('--rp-gap', `${level.gap}px`);
    for (const row of rows) {
      row.room.style.width = `${level.thumbW}px`;
      if (!row.thumb) continue;
      const fit = fitImage(row.thumb.w, row.thumb.h, level.thumbW, level.thumbH, 1);
      row.thumb.el.style.width = `${fit.width}px`;
      const bar = row.thumb.el.firstElementChild as HTMLElement;
      bar.style.height = `${level.bar}px`;
      (row.thumb.el.lastElementChild as HTMLElement).style.height = `${fit.height}px`;
    }
  };
  const fits = () => list.offsetHeight <= root.clientHeight - head.offsetHeight - 16 - 2;

  const instance: SceneInstance = {
    root,
    layout() {
      fitLines(title, { max: 46, min: 34, maxLines: 2, lineHeight: 1.15 });
      for (const level of LEVELS) {
        apply(level);
        if (fits()) break;
      }
      // A short list sits in the middle of the free space, not at the top.
      const spare = root.clientHeight - head.offsetHeight - 16 - list.offsetHeight;
      list.style.marginTop = `${16 + Math.max(0, spare / 2)}px`;
    },
    update(t) {
      rise(sw, head, enter(t, 0.15, 0.6), 16);
      for (const row of rows) {
        rise(sw, row.el, enter(t, row.start, 0.65), 26);
        if (row.chip) sw.opacity(row.chip, enter(t, row.start + 0.3, 0.4));
        row.thumb?.update(t);
      }
    },
  };
  return instance;
};
