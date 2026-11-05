/** Terminal window: commands are typed out, output appears line by line. Also used inside before-after. */
import { CONTENT_H, CONTENT_W, type TerminalResolved } from '../../core/render-plan.ts';
import { enter, lerp, q } from '../anim.ts';
import { CODE_CHAR_EM, planCodeLayout } from '../code-view.ts';
import { css, h } from '../dom.ts';
import { clampText } from '../fit.ts';
import { icon } from '../icons.ts';
import type { SceneContext, SceneInstance, TemplateFactory } from '../types.ts';
import { enterWindow, windowFrame } from './parts.ts';

export type TerminalLine = TerminalResolved['lines'][number];

/** The smallest terminal font before a long line is cut off. */
const MIN_TERMINAL_FONT = 22;

/** Typing speed in characters per second; long commands speed up so none takes longer than MAX_TYPE_SEC. */
const TYPE_CPS = 30;
const MAX_TYPE_SEC = 2.4;
const PAUSE_AFTER_COMMAND = 0.3;

export interface TermTiming {
  /** When the line appears (a command starts typing). */
  start: number;
  /** Characters per second while typing (0 for lines that are not typed). */
  rate: number;
  /** How long typing takes; 0 for output and comments. */
  typeSec: number;
  /** When the line is complete. */
  end: number;
}

/**
 * When each line appears. Lines follow the narration beats but never overlap: a command is typed
 * in full, then its output follows line by line.
 */
export function scheduleTerminal(
  lines: readonly (TerminalLine & { start: number })[],
  options: { minStart?: number } = {},
): TermTiming[] {
  let cursor = options.minStart ?? 0;
  return lines.map((line) => {
    const start = Math.max(line.start, cursor);
    if (line.kind === 'command') {
      const chars = Array.from(line.text).length;
      const rate = Math.max(TYPE_CPS, chars / MAX_TYPE_SEC);
      const typeSec = chars / rate;
      cursor = start + typeSec + PAUSE_AFTER_COMMAND;
      return { start, rate, typeSec, end: start + typeSec };
    }
    cursor = start + (line.kind === 'comment' ? 0.35 : 0.16);
    return { start, rate: 0, typeSec: 0, end: start + 0.2 };
  });
}

/**
 * Squeeze a schedule so the last line is complete by `deadline`. Order is kept; pauses shrink and
 * typing speeds up, by at most a factor of three.
 */
export function compressSchedule(timings: readonly TermTiming[], deadline: number): TermTiming[] {
  const first = timings[0]?.start ?? 0;
  const last = timings.reduce((m, t) => Math.max(m, t.end), first);
  if (last <= deadline || last <= first) return timings.slice();
  const f = Math.max(0.34, (deadline - first) / (last - first));
  return timings.map((t) => ({
    start: first + (t.start - first) * f,
    rate: t.rate / f,
    typeSec: t.typeSec * f,
    end: first + (t.end - first) * f,
  }));
}

/** How many characters of a command are on screen at time `t`. */
export function typedChars(timing: TermTiming, length: number, t: number): number {
  if (t < timing.start) return 0;
  if (timing.rate === 0) return length;
  return Math.min(length, Math.floor((t - timing.start) * timing.rate));
}

export interface OutputMarker {
  lead: string;
  marker: string;
  tone: 'ok' | 'fail' | 'warn';
  rest: string;
}

const MARKER_RE = /^(\s*)(✓|✔|✗|✘|×|PASS|FAIL|OK|WARN|WARNING|ERROR|Error)(?=[\s:]|$)/;

/** A leading pass/fail/warning word or symbol in an output line, so it can be coloured. */
export function outputMarker(text: string): OutputMarker | null {
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  const marker = m[2] as string;
  const tone = /^(✓|✔|PASS|OK)$/.test(marker) ? 'ok' : /^(WARN|WARNING)$/.test(marker) ? 'warn' : 'fail';
  return { lead: m[1] as string, marker, tone, rest: text.slice(m[0].length) };
}

export interface TerminalPlan {
  fontSize: number;
  lineHeight: number;
  barHeight: number;
  padY: number;
  height: number;
  /** Rows that fit without scrolling. */
  capacity: number;
}

/** Font size, line height and window height for a terminal with `lineCount` rows. */
export function planTerminal(input: {
  lineCount: number;
  maxHeight: number;
  compact?: boolean;
  height?: number;
}): TerminalPlan {
  const barHeight = input.compact ? 56 : 64;
  const padY = input.compact ? 16 : 22;
  const limit = input.height ?? input.maxHeight;
  const layout = planCodeLayout({
    lineCount: input.lineCount,
    avail: limit - barHeight - 2 * padY,
    minFont: 22,
    maxFont: input.compact ? 24 : 28,
  });
  const fit = Math.max(1, Math.floor((limit - barHeight - 2 * padY) / layout.lineHeight));
  const rows = Math.max(1, Math.min(input.lineCount, fit));
  return {
    fontSize: layout.fontSize,
    lineHeight: layout.lineHeight,
    barHeight,
    padY,
    height: Math.round(
      input.height ?? Math.max(input.compact ? 220 : 300, barHeight + 2 * padY + rows * layout.lineHeight),
    ),
    capacity: fit,
  };
}

export interface TerminalViewOptions {
  /** Window width in px, or 'fit' to hug the longest line between minWidth and maxWidth. */
  width: number | 'fit';
  minWidth?: number;
  maxWidth?: number;
  maxHeight: number;
  height?: number;
  compact?: boolean;
  title: string | null;
  /** Small muted note at the right end of the title bar. */
  note: string | null;
  /** No line starts before this time. */
  minStart?: number;
}

export interface TerminalView {
  root: HTMLElement;
  plan: TerminalPlan;
  width: number;
  /** Apply the state at scene time `t`. */
  update(t: number): void;
}

interface Row {
  el: HTMLElement;
  typed: HTMLElement | null;
  caret: HTMLElement | null;
  chars: string[];
  kind: TerminalLine['kind'];
}

/** Build a terminal window for `lines`; timings follow the scene's narration beats. */
export function createTerminalView(
  lines: readonly TerminalLine[],
  ctx: SceneContext,
  options: TerminalViewOptions,
): TerminalView {
  registerStyles();
  const { sw } = ctx;
  const compact = options.compact ?? false;
  const fitted = planTerminal({
    lineCount: lines.length,
    maxHeight: options.maxHeight,
    compact,
    height: options.height,
  });
  const { lineHeight, barHeight, padY } = fitted;
  const padX = compact ? 24 : 32;

  const shown = lines.map((l) =>
    l.kind === 'comment' && !/^\s*(#|\/\/)/.test(l.text) ? `# ${l.text}` : l.text,
  );
  // The longest line, in pixels, at a given font size: text plus the prompt of a command.
  const longestAt = (size: number) =>
    lines.reduce((m, l, i) => {
      const chars = Array.from(shown[i] as string).length;
      return Math.max(
        m,
        chars * CODE_CHAR_EM * size + (l.kind === 'command' ? Math.round(size * 0.9) + 12 : 0),
      );
    }, 0);
  const widthLimit = options.width === 'fit' ? (options.maxWidth ?? 1560) : options.width;
  // The font comes down, to 22 px, before a line is cut: what the narration mentions stays in view.
  let fontSize = fitted.fontSize;
  while (fontSize > MIN_TERMINAL_FONT && 2 * padX + longestAt(fontSize) + 24 > widthLimit) fontSize -= 1;
  const plan: TerminalPlan = { ...fitted, fontSize };
  const charW = CODE_CHAR_EM * fontSize;
  const promptW = Math.round(fontSize * 0.9) + 12;
  const width =
    options.width === 'fit'
      ? Math.round(
          Math.min(
            options.maxWidth ?? 1560,
            Math.max(options.minWidth ?? 1000, 2 * padX + longestAt(fontSize) + 24),
          ),
        )
      : options.width;
  const textWidth = width - 2 * padX;

  const rows: Row[] = lines.map((line, i) => {
    const text = shown[i] as string;
    const chars = Array.from(text);
    const el = h('div', { class: `ms-term__line ms-term__line--${line.kind}` });
    let typed: HTMLElement | null = null;
    let caret: HTMLElement | null = null;
    if (line.kind === 'command') {
      typed = h('span', { class: 'ms-term__typed' });
      caret = h('span', { class: 'ms-term__caret' });
      el.append(
        h(
          'span',
          { class: 'ms-term__prompt' },
          icon('chevron', { size: Math.round(fontSize * 0.9), stroke: 2.8 }),
        ),
        typed,
        caret,
      );
    } else {
      const marker = line.kind === 'output' ? outputMarker(text) : null;
      if (marker) {
        el.append(
          marker.lead,
          h('span', { class: `ms-term__mark ms-term__mark--${marker.tone}`, text: marker.marker }),
          marker.rest,
        );
      } else {
        el.append(text);
      }
    }
    const used = chars.length * charW + (line.kind === 'command' ? promptW : 0);
    if (used > textWidth) el.classList.add('ms-term__line--clip');
    return { el, typed, caret, chars, kind: line.kind };
  });

  const linesEl = h('div', { class: 'ms-term__lines' }, ...rows.map((r) => r.el));
  const viewportH = plan.height - barHeight - 2 * padY;
  const viewport = h(
    'div',
    {
      class: 'ms-window__body ms-term__viewport',
      style: { margin: `${padY}px ${padX}px`, height: `${viewportH}px` },
    },
    linesEl,
  );

  const right: HTMLElement[] = [];
  if (options.note) right.push(h('span', { class: 'ms-term__note', text: options.note }));
  const root = windowFrame({
    class: `ms-term${compact ? ' ms-term--compact' : ''}`,
    style: {
      width: `${width}px`,
      height: `${plan.height}px`,
      '--tm-fs': `${fontSize}px`,
      '--tm-lh': `${lineHeight}px`,
    },
    barHeight,
    barItems: [
      h('div', { class: 'ms-term__title', text: options.title ? clampText(options.title, 48) : '' }),
      ...right,
    ],
    body: viewport,
  });

  const timings = compressSchedule(
    scheduleTerminal(ctx.withStarts(lines, 0), { minStart: options.minStart }),
    ctx.duration - 0.8,
  );
  const scrollNeed = (i: number) => Math.max(0, (i + 1) * lineHeight - viewportH);

  return {
    root,
    plan,
    width,
    update(t) {
      let latest = -1;
      rows.forEach((row, i) => {
        const timing = timings[i] as TermTiming;
        if (t >= timing.start) latest = i;
        const p = enter(t, timing.start, row.kind === 'command' ? 0.1 : 0.2);
        sw.opacity(row.el, p);
        sw.transform(row.el, row.kind === 'command' ? 'none' : `translate(0px, ${q((1 - p) * 8, 2)}px)`);
        if (row.typed && row.caret) {
          sw.text(row.typed, row.chars.slice(0, typedChars(timing, row.chars.length, t)).join(''));
          sw.opacity(row.caret, t >= timing.start && t < timing.end ? 1 : 0);
        }
      });
      const offset =
        latest < 0
          ? 0
          : lerp(
              latest > 0 ? scrollNeed(latest - 1) : 0,
              scrollNeed(latest),
              enter(t, (timings[latest] as TermTiming).start, 0.25),
            );
      sw.transform(linesEl, `translate(0px, ${q(-offset, 2)}px)`);
    },
  };
}

const TERMINAL_CSS = `
.ms-term-scene__wrap { position: absolute; transform-origin: 50% 40%; }
`;

function registerStyles(): void {
  css(
    'terminal',
    `
.ms-term { font-family: var(--font-code); font-feature-settings: normal; font-variant-ligatures: none; }
.ms-term .ms-window__bar { padding: 0 24px; gap: 18px; }
.ms-term--compact .ms-window__bar { padding: 0 20px; gap: 14px; }
.ms-term--compact .ms-window__lights i { width: 12px; height: 12px; }
.ms-term__title { flex: 1 1 0; min-width: 0; font-size: 22px; color: var(--text-1); white-space: nowrap; overflow: hidden; }
.ms-term__note { flex: none; margin-left: auto; font-family: var(--font-ui); font-size: 22px; font-weight: 500; color: var(--text-3); white-space: nowrap; }
.ms-term__viewport { flex: none; overflow: hidden; }
.ms-term__line {
  height: var(--tm-lh);
  line-height: var(--tm-lh);
  font-size: var(--tm-fs);
  white-space: pre;
  tab-size: 4;
  overflow: hidden;
  color: var(--text-1);
}
.ms-term__line--clip {
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 64px), transparent);
  mask-image: linear-gradient(90deg, #000 calc(100% - 64px), transparent);
}
.ms-term__line--command { color: var(--text-0); display: flex; align-items: center; }
.ms-term__prompt { display: inline-flex; flex: none; margin-right: 12px; color: var(--accent-2); }
.ms-term__typed { white-space: pre; }
.ms-term__caret {
  display: inline-block;
  flex: none;
  width: 0.55em;
  height: 1.1em;
  margin-left: 2px;
  background: var(--accent-2);
  border-radius: 2px;
}
.ms-term__line--comment { color: var(--text-3); }
.ms-term__mark { font-weight: 700; }
.ms-term__mark--ok { color: var(--add); }
.ms-term__mark--fail { color: var(--del); }
.ms-term__mark--warn { color: var(--mod); }
`,
  );
}

export const terminalTemplate: TemplateFactory<TerminalResolved> = (visual, ctx) => {
  css('terminal-scene', TERMINAL_CSS);
  const { sw } = ctx;
  const view = createTerminalView(visual.lines, ctx, {
    width: 'fit',
    minWidth: 1000,
    maxWidth: CONTENT_W,
    maxHeight: CONTENT_H,
    title: visual.title,
    note: 'Illustrative output',
  });
  const height = view.plan.height;
  const wrap = h(
    'div',
    {
      class: 'ms-term-scene__wrap',
      style: {
        left: `${Math.round((CONTENT_W - view.width) / 2)}px`,
        top: `${Math.round((CONTENT_H - height) / 2)}px`,
        width: `${view.width}px`,
        height: `${height}px`,
      },
    },
    view.root,
  );
  const root = h('div', { class: 'ms-content ms-term-scene' }, wrap);

  const instance: SceneInstance = {
    root,
    update(t) {
      enterWindow(sw, wrap, t);
      view.update(t);
    },
  };
  return instance;
};
