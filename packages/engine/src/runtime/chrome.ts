/**
 * Persistent chrome drawn above the scenes: brand bar, chapter label, captions, evidence chips,
 * badges and the chapter progress bar. Every write goes through the shared StyleWriter and
 * everything here is a pure function of the time passed to update().
 */
import {
  type BadgeKind,
  CONTENT_W,
  type PlanCue,
  type PlannedScene,
  type RenderPlan,
} from '../core/render-plan.ts';
import { clamp01, ease, enter, progress, q, type StyleWriter } from './anim.ts';
import { css, h, s } from './dom.ts';
import { fitLines, monoChars, pad2, truncatePath } from './fit.ts';
import { shift } from './motion.ts';
import type { SceneSlot } from './transitions.ts';

/** Horizontal padding of the caption pill, in pixels. */
const CAPTION_PAD_X = 34;

const MARK_CSS = String.raw`
.ms-mark {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 28%;
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%);
  box-shadow: 0 10px 28px -10px color-mix(in srgb, var(--glow) 75%, transparent), inset 0 0 0 1px rgba(255, 255, 255, 0.24);
}
.ms-mark svg { width: 64%; height: 64%; display: block; }
`;

const CHROME_CSS = String.raw`
.ms-chrome { position: absolute; inset: 0; pointer-events: none; }

.ms-chrome__top {
  position: absolute;
  left: 120px;
  right: 120px;
  top: 40px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 40px;
}
.ms-chrome__brand { display: flex; align-items: center; gap: 14px; min-width: 0; flex: none; }
.ms-chrome__word { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; color: var(--text-0); }
.ms-chrome__word b {
  font-weight: 700;
  background: linear-gradient(90deg, var(--brand-1), var(--brand-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.ms-chrome__sep { width: 1px; height: 30px; margin: 0 8px; background: var(--border-2); flex: none; }
.ms-chrome__repo {
  font-family: var(--font-code);
  font-size: 22px;
  color: var(--text-1);
  max-width: 440px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ms-chrome__change {
  font-family: var(--font-code);
  font-size: 22px;
  font-weight: 500;
  color: var(--accent-2);
  padding: 4px 14px;
  border-radius: var(--radius-pill);
  background: var(--accent-2-soft);
  white-space: nowrap;
  flex: none;
}

.ms-chrome__scenes { position: relative; flex: 1; min-width: 0; height: 60px; }
.ms-chrome__scene {
  position: absolute;
  right: 0;
  top: 0;
  height: 60px;
  max-width: 100%;
  display: flex;
  align-items: center;
  gap: 18px;
  white-space: nowrap;
}
.ms-chrome__count { font-family: var(--font-code); font-size: 22px; font-weight: 700; color: var(--accent-2); flex: none; }
.ms-chrome__count i { font-style: normal; font-weight: 500; color: var(--text-3); }
.ms-chrome__title { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; }

.ms-chrome__foot {
  position: absolute;
  left: 120px;
  right: 120px;
  bottom: 38px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.ms-chrome__refs { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ms-chrome__badges { display: flex; align-items: center; gap: 10px; flex: none; margin-left: auto; }
.ms-ref {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 16px;
  border-radius: var(--radius-pill);
  background: var(--surface-inset);
  box-shadow: 0 0 0 1px var(--border-2);
  font-family: var(--font-code);
  font-size: 22px;
  color: var(--text-1);
  white-space: nowrap;
}
.ms-ref::before { content: ''; width: 8px; height: 8px; border-radius: 2px; background: var(--accent-2); flex: none; }

.ms-cap { position: absolute; left: 260px; width: 1400px; bottom: 100px; display: flex; justify-content: center; }
.ms-cap__pill {
  max-width: 1400px;
  padding: 14px ${CAPTION_PAD_X}px;
  border-radius: 30px;
  background: var(--cap-bg);
  box-shadow: 0 0 0 1px var(--cap-ring), 0 18px 44px -14px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(14px);
}
.ms-cap__text {
  font-size: 36px;
  line-height: 46px;
  font-weight: 550;
  letter-spacing: -0.005em;
  color: var(--cap-fg);
  text-align: center;
  text-wrap: balance;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.ms-cap__text--probe {
  position: absolute;
  left: 0;
  top: 0;
  width: 1332px;
  visibility: hidden;
  display: block;
  -webkit-line-clamp: unset;
  overflow: visible;
}

.ms-prog { position: absolute; left: 120px; right: 120px; top: 1052px; height: 8px; }
.ms-prog__seg {
  position: absolute;
  top: 1px;
  height: 6px;
  border-radius: 3px;
  background: rgba(150, 165, 215, 0.2);
  overflow: hidden;
}
.ms-prog__seg.is-current { top: 0; height: 8px; border-radius: 4px; background: rgba(150, 165, 215, 0.34); }
.ms-prog__fill {
  position: absolute;
  inset: 0;
  transform-origin: 0 50%;
  transform: scaleX(0);
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}
.ms-prog__seg.is-done .ms-prog__fill { opacity: 0.55; }
`;

/** Default badge wording, used when the plan gives no text. */
const BADGE_DEFAULTS: Record<BadgeKind, string> = {
  simulated: 'Simulated UI',
  actual: 'Actual screenshot',
  masked: 'Secrets masked',
  reported: 'Reported by caller',
};

export function badgeText(badge: { kind: BadgeKind; text: string }): string {
  return badge.text.trim() || BADGE_DEFAULTS[badge.kind];
}

/** The brand mark: a rounded accent tile with a small merge glyph. */
export function brandMark(size: number): HTMLElement {
  css('mark', MARK_CSS);
  const glyph = s(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: '#ffffff', 'stroke-width': 1.9, 'stroke-linecap': 'round' },
    s('path', { d: 'M7 8.3 C7 13.4 12 12.4 12 15.7' }),
    s('path', { d: 'M17 8.3 C17 13.4 12 12.4 12 15.7' }),
    s('circle', { cx: 7, cy: 6, r: 2.3, fill: '#ffffff', stroke: 'none' }),
    s('circle', { cx: 17, cy: 6, r: 2.3, fill: '#ffffff', stroke: 'none' }),
    s('circle', { cx: 12, cy: 18, r: 2.3, fill: '#ffffff', stroke: 'none' }),
  );
  return h('div', { class: 'ms-mark', style: { width: `${size}px`, height: `${size}px` } }, glyph);
}

// ---------------------------------------------------------------------------
// Pure helpers (no DOM)
// ---------------------------------------------------------------------------

/** Index of the chapter that is current at time t. Chapters before the first start count as the first. */
export function chapterIndexAt(chapters: readonly { startSec: number }[], t: number): number {
  let index = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i]!.startSec <= t + 1e-6) index = i;
  }
  return index;
}

/** Index of the caption cue showing at time t (the latest one that started), or -1. */
export function activeCueIndex(cues: readonly PlanCue[], t: number): number {
  let found = -1;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    if (t >= cue.startSec && t < cue.endSec) found = i;
  }
  return found;
}

export const CAPTION_FADE_SEC = 0.15;

/** Caption opacity: fades in over the first and out over the last 0.15 s of the cue. */
export function captionAlpha(cue: PlanCue, t: number): number {
  const fadeIn = progress(t, cue.startSec, CAPTION_FADE_SEC);
  const fadeOut = 1 - progress(t, cue.endSec - CAPTION_FADE_SEC, CAPTION_FADE_SEC);
  // Snap float noise at the ends so a finished cue is hidden, not shown at 0.0000000000000005.
  return q(Math.min(fadeIn, fadeOut), 4);
}

export interface ProgressSegment {
  startSec: number;
  endSec: number;
  /** Number of visible fill steps; capped at 20 so the bar changes rarely. */
  steps: number;
}

/** Chapter segments of the progress bar. The first starts at 0; the last ends at `totalSec`. */
export function progressSegments(
  chapters: readonly { startSec: number }[],
  totalSec: number,
): ProgressSegment[] {
  const starts = chapters.length === 0 ? [0] : chapters.map((c, i) => (i === 0 ? 0 : c.startSec));
  const out: ProgressSegment[] = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! : totalSec;
    if (end - start <= 0.01) return;
    out.push({
      startSec: start,
      endSec: end,
      steps: Math.max(4, Math.min(20, Math.round((end - start) / 0.4))),
    });
  });
  return out;
}

/** Fill amount rounded down to whole steps, so the bar only changes a few times per segment. */
export function steppedFill(t: number, segment: ProgressSegment): number {
  const fraction = clamp01((t - segment.startSec) / (segment.endSec - segment.startSec));
  return fraction >= 1 ? 1 : Math.floor(fraction * segment.steps) / segment.steps;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

export interface Chrome {
  root: HTMLElement;
  /** Measure caption sizes. Call once, with the root in the document and fonts loaded. */
  layout(): void;
  update(t: number): void;
}

interface SceneChrome {
  slot: SceneSlot;
  label: HTMLElement;
  foot: HTMLElement | null;
}

/** Approximate width of a badge in pixels, used to budget space for the evidence chips. */
function badgeWidth(text: string): number {
  return 64 + text.length * 17.6;
}

/**
 * Share a budget of characters between chips: a short chip keeps all its characters and the room it
 * does not need goes to the long ones, which are cut only when the chips together do not fit.
 */
export function chipBudgets(lengths: readonly number[], totalChars: number): number[] {
  const budgets = lengths.map(() => 0);
  let left = Math.max(0, Math.floor(totalChars));
  let open = lengths.map((_, i) => i);
  while (open.length > 0) {
    const share = Math.floor(left / open.length);
    const fits = open.filter((i) => (lengths[i] as number) <= share);
    if (fits.length === 0) {
      for (const i of open) budgets[i] = share;
      break;
    }
    for (const i of fits) {
      budgets[i] = lengths[i] as number;
      left -= lengths[i] as number;
    }
    open = open.filter((i) => !fits.includes(i));
  }
  return budgets;
}

function buildFoot(scene: PlannedScene): HTMLElement | null {
  const refs = scene.refs;
  if (refs.length === 0 && scene.badges.length === 0) return null;
  const badgeSpace = scene.badges.reduce((sum, b) => sum + badgeWidth(badgeText(b)) + 10, 0);
  const available = CONTENT_W - badgeSpace - (badgeSpace > 0 ? 24 : 0) - Math.max(0, refs.length - 1) * 10;
  // Each chip has 50 px of padding and marker around its text (22 px monospace, 13.2 px a character).
  const budgets = chipBudgets(
    refs.map((ref) => Array.from(ref).length),
    monoChars(available - 50 * refs.length, 22),
  );
  return h(
    'div',
    { class: 'ms-chrome__foot' },
    h(
      'div',
      { class: 'ms-chrome__refs' },
      ...refs.map((ref, i) =>
        h('span', { class: 'ms-ref', text: truncatePath(ref, Math.max(14, budgets[i] as number)) }),
      ),
    ),
    h(
      'div',
      { class: 'ms-chrome__badges' },
      ...scene.badges.map((b) => h('span', { class: `ms-badge ms-badge--${b.kind}`, text: badgeText(b) })),
    ),
  );
}

/**
 * Build the chrome for a plan. `outroStart` is the time the end card begins (null without one);
 * the chrome fades out as it starts.
 */
export function createChrome(
  plan: RenderPlan,
  slots: readonly SceneSlot[],
  sw: StyleWriter,
  outroStart: number | null,
): Chrome {
  css('chrome', CHROME_CSS);
  const { meta } = plan;
  const chapters = plan.chapters;
  const captionsOn = plan.captions.enabled && plan.captions.cues.length > 0;
  const cues = plan.captions.cues;
  const chapterTotal = chapters.length;

  // Top bar: brand and change label on the left, chapter counter and scene title on the right.
  const brand = h(
    'div',
    { class: 'ms-chrome__brand' },
    brandMark(44),
    h('div', { class: 'ms-chrome__word' }, 'Merge', h('b', { text: 'Story' })),
    meta.repoLabel || meta.changeLabel ? h('div', { class: 'ms-chrome__sep' }) : null,
    meta.repoLabel ? h('div', { class: 'ms-chrome__repo', text: meta.repoLabel }) : null,
    meta.changeLabel ? h('div', { class: 'ms-chrome__change', text: meta.changeLabel }) : null,
  );

  const sceneChrome: SceneChrome[] = plan.scenes.map((scene, i) => {
    const index = chapterTotal > 0 ? chapterIndexAt(chapters, scene.startSec + 0.001) : -1;
    const label = h(
      'div',
      { class: 'ms-chrome__scene' },
      chapterTotal > 0
        ? h(
            'div',
            { class: 'ms-chrome__count' },
            pad2(index + 1),
            h('i', { text: ` / ${pad2(chapterTotal)}` }),
          )
        : null,
      h('div', { class: 'ms-chrome__title', text: scene.title }),
    );
    label.style.display = 'none';
    const foot = buildFoot(scene);
    if (foot) foot.style.display = 'none';
    return { slot: slots[i]!, label, foot };
  });

  const scenesBox = h('div', { class: 'ms-chrome__scenes' }, ...sceneChrome.map((c) => c.label));
  const top = h('div', { class: 'ms-chrome__top' }, brand, scenesBox);

  // Captions: one pill whose text and size follow the active cue.
  const capText = h('div', { class: 'ms-cap__text' });
  const capPill = h('div', { class: 'ms-cap__pill' }, capText);
  const caption = h('div', { class: 'ms-cap' }, capPill);
  caption.style.display = 'none';
  const probe = h('div', { class: 'ms-cap__text ms-cap__text--probe' });
  let cueSizes: number[] = [];
  let cueWidths: number[] = [];

  // Progress bar: one segment per chapter.
  const totalSec = outroStart ?? plan.durationSec;
  const segments = progressSegments(chapters, totalSec);
  const gap = 6;
  const usable = CONTENT_W - gap * Math.max(0, segments.length - 1);
  let cursor = 0;
  const bars = segments.map((segment) => {
    const width = (usable * (segment.endSec - segment.startSec)) / Math.max(0.01, totalSec);
    const fill = h('div', { class: 'ms-prog__fill' });
    const el = h(
      'div',
      { class: 'ms-prog__seg', style: { left: `${q(cursor, 2)}px`, width: `${q(width, 2)}px` } },
      fill,
    );
    cursor += width + gap;
    return { segment, el, fill };
  });
  const progressBar = h('div', { class: 'ms-prog' }, ...bars.map((b) => b.el));

  const root = h(
    'div',
    { class: 'ms-chrome' },
    top,
    captionsOn ? caption : null,
    ...sceneChrome.map((c) => c.foot),
    progressBar,
    captionsOn ? probe : null,
  );

  return {
    root,
    layout() {
      if (!captionsOn) return;
      // Balanced text does not shrink its box, so measure the widest line of each cue and size the pill to it.
      const range = document.createRange();
      const sizes: number[] = [];
      const widths: number[] = [];
      for (const cue of cues) {
        probe.textContent = cue.text;
        sizes.push(fitLines(probe, { max: 38, min: 34, maxLines: 2, lineHeightPx: 46, step: 1 }));
        range.selectNodeContents(probe);
        const scale = probe.offsetWidth > 0 ? probe.getBoundingClientRect().width / probe.offsetWidth : 1;
        let widest = 0;
        for (const rect of Array.from(range.getClientRects())) widest = Math.max(widest, rect.width / scale);
        widths.push(Math.min(1400, Math.ceil(widest) + CAPTION_PAD_X * 2 + 6));
      }
      cueSizes = sizes;
      cueWidths = widths;
      probe.remove();
    },
    update(t) {
      const outroFade = outroStart === null ? 0 : enter(t, outroStart, 0.5, ease.inOutCubic);
      const opacity = enter(t, 0.1, 0.6) * (1 - outroFade);
      sw.opacity(root, opacity);
      sw.visible(root, opacity > 0);
      if (opacity <= 0) return;

      for (const c of sceneChrome) {
        const { slot } = c;
        // The old label leaves quickly and the new one arrives a moment later, so the two never read as overlapping text.
        const out = enter(t, slot.outStart, 0.25, ease.inOutCubic);
        const labelIn = enter(t, slot.start + 0.15, 0.4);
        const labelOpacity = labelIn * (1 - out);
        sw.visible(c.label, labelOpacity > 0, 'flex');
        sw.opacity(c.label, labelOpacity);
        shift(sw, c.label, (1 - labelIn) * 8 - out * 8);
        if (c.foot) {
          const footIn = enter(t, slot.start + 0.3, 0.5);
          const footOpacity = footIn * (1 - out);
          sw.visible(c.foot, footOpacity > 0, 'flex');
          sw.opacity(c.foot, footOpacity);
          shift(sw, c.foot, (1 - footIn) * 10);
        }
      }

      if (captionsOn) {
        const index = activeCueIndex(cues, t);
        const cue = index >= 0 ? cues[index]! : null;
        const alpha = cue ? captionAlpha(cue, t) : 0;
        if (cue) {
          sw.text(capText, cue.text);
          sw.style(capText, 'font-size', `${cueSizes[index] ?? 36}px`);
          sw.style(capPill, 'width', `${cueWidths[index] ?? 1400}px`);
        }
        sw.opacity(caption, alpha);
        sw.visible(caption, alpha > 0, 'flex');
      }

      for (const b of bars) {
        sw.style(b.fill, 'transform', `scaleX(${q(steppedFill(t, b.segment), 4)})`);
        sw.toggle(b.el, 'is-current', t >= b.segment.startSec && t < b.segment.endSec);
        sw.toggle(b.el, 'is-done', t >= b.segment.endSec);
      }
    },
  };
}
