/** Branded end card shown after the last scene. */
import type { RenderPlan } from '../core/render-plan.ts';
import { ease, enter, type StyleWriter } from './anim.ts';
import { brandMark } from './chrome.ts';
import { css, h } from './dom.ts';
import { grow, pop, rise } from './motion.ts';
import { OUTRO_FADE_SEC } from './transitions.ts';

const OUTRO_CSS = String.raw`
.ms-outro {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ms-outro__glow {
  position: absolute;
  left: 50%;
  top: 46%;
  width: 1500px;
  height: 1000px;
  margin: -500px 0 0 -750px;
  background: radial-gradient(closest-side in srgb, color-mix(in srgb, var(--accent) 30%, transparent), color-mix(in srgb, var(--accent-2) 10%, transparent) 58%, transparent 100%);
}
:root[data-theme='light'] .ms-outro__glow {
  background: radial-gradient(closest-side in srgb, color-mix(in srgb, var(--accent) 16%, transparent), color-mix(in srgb, var(--accent-2) 7%, transparent) 58%, transparent 100%);
}
.ms-outro__col {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 1400px;
}
.ms-outro__brand { display: flex; align-items: center; gap: 30px; }
.ms-outro__word { font-size: 104px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; color: var(--text-0); }
.ms-outro__word b {
  font-weight: 800;
  background: linear-gradient(90deg, var(--brand-1), var(--brand-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.ms-outro__tag { margin-top: 34px; font-size: 52px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; color: var(--text-1); }
.ms-outro__rule {
  width: 160px;
  height: 3px;
  margin: 46px 0 42px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}
.ms-outro__chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; max-width: 1300px; }
.ms-outro__chip {
  display: inline-flex;
  align-items: center;
  height: 54px;
  padding: 0 26px;
  border-radius: var(--radius-pill);
  background: var(--surface-inset);
  box-shadow: 0 0 0 1px var(--border-2);
  font-family: var(--font-code);
  font-size: 25px;
  font-weight: 500;
  color: var(--text-0);
  white-space: nowrap;
}
.ms-outro__note { margin-top: 36px; max-width: 1120px; font-size: 28px; font-weight: 450; line-height: 1.45; color: var(--text-2); }
`;

export interface Outro {
  root: HTMLElement;
  update(t: number): void;
}

/** Lines at most this long become chips (repo, change, commit); longer ones become a note. */
const CHIP_MAX_CHARS = 36;

/** Build the end card, or null when the plan has none. */
export function createOutro(plan: RenderPlan, sw: StyleWriter): Outro | null {
  const spec = plan.outro;
  if (spec.durationSec <= 0) return null;
  css('outro', OUTRO_CSS);

  const lines = spec.lines.map((l) => l.trim()).filter(Boolean);
  const chipLines = lines.filter((l) => l.length <= CHIP_MAX_CHARS).slice(0, 5);
  const noteLines = lines.filter((l) => l.length > CHIP_MAX_CHARS).slice(0, 2);

  const mark = brandMark(128);
  const word = h('div', { class: 'ms-outro__word' }, 'Merge', h('b', { text: 'Story' }));
  const brand = h('div', { class: 'ms-outro__brand' }, mark, word);
  const tagline = spec.tagline ? h('div', { class: 'ms-outro__tag', text: spec.tagline }) : null;
  const rule = h('div', { class: 'ms-outro__rule' });
  const chips = chipLines.map((text) => h('span', { class: 'ms-outro__chip', text }));
  const chipRow = chips.length > 0 ? h('div', { class: 'ms-outro__chips' }, ...chips) : null;
  const notes = noteLines.map((text) => h('div', { class: 'ms-outro__note', text }));

  const col = h('div', { class: 'ms-outro__col' }, brand, tagline, rule, chipRow, ...notes);
  const root = h('div', { class: 'ms-outro' }, h('div', { class: 'ms-outro__glow' }), col);
  root.style.display = 'none';

  return {
    root,
    update(t) {
      const local = t - spec.startSec;
      const opacity = enter(local, 0, OUTRO_FADE_SEC, ease.inOutCubic);
      sw.opacity(root, opacity);
      sw.visible(root, opacity > 0, 'flex');
      if (opacity <= 0) return;
      pop(sw, mark, enter(local, 0.15, 0.7, ease.linear), 0.8);
      rise(sw, word, enter(local, 0.3, 0.7), 24);
      if (tagline) rise(sw, tagline, enter(local, 0.6, 0.7), 20);
      sw.opacity(rule, enter(local, 0.85, 0.5));
      grow(sw, rule, 'x', enter(local, 0.85, 0.6, ease.outCubic));
      chips.forEach((chip, i) => rise(sw, chip, enter(local, 1.0 + i * 0.1, 0.55), 16));
      notes.forEach((note, i) => rise(sw, note, enter(local, 1.4 + i * 0.15, 0.6), 14));
    },
  };
}
