/**
 * Shared code window used by the code and before-after templates: file chrome, gutter,
 * diff markers, syntax tokens and per-line emphasis.
 *
 * Layout is analytic (monospace metrics), so nothing is measured and the result is the same
 * on every machine. The font comes down to a floor before any line is wrapped; a line that is
 * still too long wraps with a hanging indent and a marker, and the line number stays on its first
 * row. Everything that moves goes through the StyleWriter.
 */
import { CONTENT_W, type CodeLine, type CodeToken, type ResolvedCode } from '../core/render-plan.ts';
import { q, type StyleWriter } from './anim.ts';
import { css, h, s } from './dom.ts';
import { monoChars, truncatePath } from './fit.ts';
import { icon } from './icons.ts';
import { windowFrame } from './templates/parts.ts';

/** Advance width of the code font, in em. */
export const CODE_CHAR_EM = 0.6;
/** Opacity of lines that are not in focus: dimmed, but still easy to read (45 to 55 percent is the range). */
export const DIM_OPACITY = 0.55;
/** The smallest code font a view uses before it wraps long lines. */
export const MIN_CODE_FONT = 20;

const FOOTER_HEIGHT = 52;
const LABELS: Record<string, string> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  py: 'Python',
  python: 'Python',
  go: 'Go',
  rs: 'Rust',
  rust: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kotlin: 'Kotlin',
  swift: 'Swift',
  rb: 'Ruby',
  ruby: 'Ruby',
  php: 'PHP',
  c: 'C',
  cpp: 'C++',
  cs: 'C#',
  csharp: 'C#',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  md: 'Markdown',
  markdown: 'Markdown',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  shell: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  text: 'Text',
  txt: 'Text',
  plaintext: 'Text',
};

/** Human label for a language id, e.g. "ts" becomes "TypeScript". */
export function languageLabel(language: string): string {
  const key = language.trim().toLowerCase();
  if (key === '') return 'Text';
  return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Expand tabs to spaces (column aware) and drop line breaks, so one character is one grid cell. */
export function prepareTokens(
  tokens: readonly CodeToken[],
  tabSize = 4,
): { tokens: CodeToken[]; length: number } {
  const out: CodeToken[] = [];
  let column = 0;
  for (const token of tokens) {
    let text = '';
    for (const ch of token.t) {
      if (ch === '\n' || ch === '\r') continue;
      if (ch === '\t') {
        const n = tabSize - (column % tabSize);
        text += ' '.repeat(n);
        column += n;
      } else {
        text += ch;
        column += 1;
      }
    }
    if (text !== '') out.push(text === token.t ? token : { ...token, t: text });
  }
  return { tokens: out, length: column };
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/** One screen row of a code line. */
export interface WrappedRow {
  tokens: CodeToken[];
  /** Characters on the row, not counting spaces at its end. */
  length: number;
}

/** A code line cut into screen rows. A line that fits has one row and no hanging indent. */
export interface LineWrap {
  rows: WrappedRow[];
  /** Columns the continuation rows are indented by. */
  hang: number;
}

/** Wrapping may make a block this many times as many rows as it has lines, on average. */
const MAX_ROWS_PER_LINE = 3;

/** Extra columns a continuation row is indented by, beyond the indent of the line itself. */
const HANG_EXTRA = 2;
/** A wrapped row never ends before this share of its width unless there is no better place. */
const MIN_ROW_SHARE = 0.55;
/** Lines may break after these characters. */
const BREAK_AFTER = new Set([' ', ',', ';', '(', '[', '{', '|', '&']);

/** The part of a token list between two character positions (code points). */
function sliceTokens(tokens: readonly CodeToken[], from: number, to: number): CodeToken[] {
  const out: CodeToken[] = [];
  let position = 0;
  for (const token of tokens) {
    const chars = Array.from(token.t);
    const end = position + chars.length;
    if (end > from && position < to) {
      const a = Math.max(from, position) - position;
      const b = Math.min(to, end) - position;
      const text = a === 0 && b === chars.length ? token.t : chars.slice(a, b).join('');
      if (text !== '') out.push(text === token.t ? token : { ...token, t: text });
    }
    position = end;
    if (position >= to) break;
  }
  return out;
}

/**
 * Cut a prepared line into rows of at most `cols` characters. The cut falls after a space, comma or
 * bracket when one is near the end of the row, else at the column limit. Continuation rows are
 * indented by the line's own indent plus two columns (at most 40% of the width), so the structure
 * of the code stays visible.
 */
export function wrapCodeLine(prepared: { tokens: CodeToken[]; length: number }, cols: number): LineWrap {
  const whole: LineWrap = {
    rows: [{ tokens: prepared.tokens, length: prepared.length }],
    hang: 0,
  };
  if (prepared.length <= cols || cols < 8) return whole;

  const chars: string[] = [];
  for (const token of prepared.tokens) for (const ch of token.t) chars.push(ch);
  let indent = 0;
  while (indent < chars.length && chars[indent] === ' ') indent += 1;
  const hang = Math.max(0, Math.min(indent + HANG_EXTRA, Math.floor(cols * 0.4)));

  const rows: WrappedRow[] = [];
  let start = 0;
  while (start < chars.length) {
    const room = rows.length === 0 ? cols : cols - hang;
    let end = Math.min(chars.length, start + room);
    if (end < chars.length) {
      const floor = start + Math.max(1, Math.floor(room * MIN_ROW_SHARE));
      for (let i = end; i > floor; i--) {
        if (BREAK_AFTER.has(chars[i - 1] as string)) {
          end = i;
          break;
        }
      }
    }
    let last = end;
    while (last > start && chars[last - 1] === ' ') last -= 1;
    rows.push({ tokens: sliceTokens(prepared.tokens, start, end), length: last - start });
    start = end;
    while (start < chars.length && chars[start] === ' ') start += 1;
  }
  return { rows, hang };
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

/**
 * Rows of the block covered by a focus range given as file line numbers on the code's side.
 * Removed rows (or added rows, for base-side code) carry no number on that side and are only
 * matched through their own number when nothing else matches. Returns null if nothing matches.
 */
export function focusIndexRange(
  code: ResolvedCode,
  startLine: number,
  endLine: number,
): { first: number; last: number } | null {
  const lo = Math.min(startLine, endLine);
  const hi = Math.max(startLine, endLine);
  const primary = (l: CodeLine) => (code.side === 'base' ? l.oldNumber : l.newNumber);
  const other = (l: CodeLine) => (code.side === 'base' ? l.newNumber : l.oldNumber);
  const scan = (pick: (l: CodeLine) => number | null, only?: (l: CodeLine) => boolean) => {
    let first = -1;
    let last = -1;
    code.lines.forEach((line, i) => {
      if (only && !only(line)) return;
      const n = pick(line);
      if (n === null || n < lo || n > hi) return;
      if (first < 0) first = i;
      last = i;
    });
    return first < 0 ? null : { first, last };
  };
  return scan(primary) ?? scan(other, (l) => primary(l) === null);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface CodeLayout {
  fontSize: number;
  lineHeight: number;
  /** How many of the lines fit. */
  shown: number;
}

/**
 * Largest font (minFont..maxFont) that still leaves a comfortable line height for `lineCount`
 * lines in `avail` px. Very long blocks fall back to the smallest font with tight lines and
 * show only the rows that fit.
 */
export function planCodeLayout(input: {
  lineCount: number;
  avail: number;
  minFont: number;
  maxFont: number;
}): CodeLayout {
  const n = Math.max(1, input.lineCount);
  const perLine = Math.max(1, input.avail) / n;
  for (let fs = input.maxFont; fs >= input.minFont; fs--) {
    if (perLine / fs >= 1.42) {
      return { fontSize: fs, lineHeight: Math.min(Math.floor(perLine), Math.round(fs * 1.62)), shown: n };
    }
  }
  const lineHeight = Math.max(Math.floor(perLine), Math.ceil(input.minFont * 1.18));
  return {
    fontSize: input.minFont,
    lineHeight,
    shown: Math.max(1, Math.min(n, Math.floor(input.avail / lineHeight))),
  };
}

export interface CodeViewOptions {
  /** Window width in px, or 'fit' to hug the longest line between minWidth and maxWidth. */
  width: number | 'fit';
  minWidth?: number;
  maxWidth?: number;
  /** The window never grows beyond this height. */
  maxHeight: number;
  /** Fixed window height (default: as tall as the lines need). */
  height?: number;
  /** Plan the font size for this many rows (to match a neighbouring window). Default: the rows needed. */
  planLines?: number;
  /** Smaller bar and padding for side-by-side use. */
  compact?: boolean;
  /** Elements placed at the right end of the title bar, before the language chip. */
  barExtras?: HTMLElement[];
  /** Approximate width of barExtras in px, used to shorten the path. */
  barExtrasWidth?: number;
  /** Smallest font before long lines wrap (default MIN_CODE_FONT). */
  minFont?: number;
  maxFont?: number;
}

export interface CodeViewMetrics {
  width: number;
  height: number;
  fontSize: number;
  lineHeight: number;
  barHeight: number;
  padY: number;
  gutterWidth: number;
  /** Code lines actually rendered. */
  shown: number;
  /** Code lines left out because they did not fit. */
  hidden: number;
  diff: boolean;
  /** Screen rows of the rendered lines: at least `shown`, more when long lines wrap. */
  rows: number;
  /** Lines that wrap onto more than one row. */
  wrapped: number;
  /** Width of one code character in px. */
  charW: number;
  /** Height of the "shortened" footer under the lines, 0 when there is none. */
  footer: number;
}

export interface CodeView {
  /** The window element. */
  root: HTMLElement;
  /** Layer over the whole window for highlights; same box as `root`, ignores the pointer. */
  overlay: HTMLElement;
  /** One element per rendered code line (all its rows). */
  lines: HTMLElement[];
  metrics: CodeViewMetrics;
  /** Distance from the window's top edge to the top of code line `index`. */
  lineTop(index: number): number;
  /** Height of code line `index`: one row, or more when it wraps. */
  lineSpan(index: number): number;
  /**
   * Where the text of each screen row ends: its top and bottom edge measured from the window's top,
   * and the right end of its last character measured from the window's left edge.
   */
  ink: { top: number; bottom: number; right: number }[];
  /**
   * Emphasis of a row: 1 is full strength, 0 dims it to DIM_OPACITY. `reveal` (0..1) fades
   * and slides the row in.
   */
  setEmphasis(sw: StyleWriter, index: number, emphasis: number, reveal?: number): void;
}

const TEXT_PAD_LEFT = 8;
const TEXT_PAD_RIGHT = 14;
/** Room kept at the right end of a row beyond the padding, so a full row never touches the edge. */
const ROW_SLACK = 8;

export interface CodeViewPlan extends CodeViewMetrics {
  numWidth: number;
  markWidth: number;
  /** Width available to code text in each row. */
  textWidth: number;
  /** Characters that fit in the first row of a line. */
  cols: number;
  /** The rows of every code line (also of the lines that are not shown). */
  wraps: LineWrap[];
  /** Screen rows each rendered line takes. */
  lineRows: number[];
  /** Index of the first screen row of each rendered line. */
  rowStarts: number[];
}

/** Work out size, font, wrapping and gutter of a code window without touching the DOM. */
export function planCodeView(code: ResolvedCode, options: CodeViewOptions): CodeViewPlan {
  const compact = options.compact ?? false;
  const barHeight = compact ? 56 : 64;
  const padY = compact ? 14 : 18;
  const prepared = code.lines.map((line) => prepareTokens(line.tokens));
  const diff = code.lines.some((l) => l.kind !== 'ctx');
  const total = code.lines.length;

  const minFont = options.minFont ?? MIN_CODE_FONT;
  const maxFont = Math.max(minFont, options.maxFont ?? 26);
  const maxNumber = code.lines.reduce((m, l) => Math.max(m, l.oldNumber ?? 0, l.newNumber ?? 0), 0);
  const digits = Math.max(2, String(maxNumber).length);
  const longest = prepared.reduce((m, p) => Math.max(m, p.length), 0);
  const gutterFor = (fontSize: number) => {
    const charW = CODE_CHAR_EM * fontSize;
    const numWidth = Math.ceil(digits * charW) + 26;
    const markWidth = diff ? Math.ceil(charW) + 28 : 0;
    return { charW, numWidth, markWidth, gutterWidth: (diff ? 2 : 1) * numWidth + markWidth };
  };
  const widthLimit = options.width === 'fit' ? (options.maxWidth ?? CONTENT_W) : options.width;
  const colsAt = (fontSize: number) => {
    const room = widthLimit - gutterFor(fontSize).gutterWidth - TEXT_PAD_LEFT - TEXT_PAD_RIGHT - ROW_SLACK;
    return Math.max(1, Math.floor(room / (CODE_CHAR_EM * fontSize)));
  };
  const rowTotal = (wraps: readonly LineWrap[]) => wraps.reduce((n, w) => n + w.rows.length, 0);

  /** Font, wrapping and line height for a window with `footer` px reserved at the bottom. */
  const choose = (footer: number) => {
    const avail = (options.height ?? options.maxHeight) - barHeight - 2 * padY - footer;
    const wrapAt = (fontSize: number) => {
      const cols = colsAt(fontSize);
      return { cols, wraps: prepared.map((p) => wrapCodeLine(p, cols)) };
    };
    let pick: { fontSize: number; cols: number; wraps: LineWrap[]; lineHeight: number } | null = null;
    const take = (fontSize: number, cols: number, wraps: LineWrap[]) => {
      const perRow = avail / Math.max(rowTotal(wraps), options.planLines ?? 0, 1);
      if (perRow / fontSize < 1.42) return false;
      pick = { fontSize, cols, wraps, lineHeight: Math.min(Math.floor(perRow), Math.round(fontSize * 1.62)) };
      return true;
    };
    // The font comes down first, to the floor, to keep every line in one piece.
    for (let fontSize = maxFont; fontSize >= minFont && !pick; fontSize--) {
      if (longest > colsAt(fontSize)) continue;
      const { cols, wraps } = wrapAt(fontSize);
      take(fontSize, cols, wraps);
    }
    // Some line is too long even at the floor. Lines wrap then, and with room to spare the type
    // stays large: the largest font at which every line is shown and no line wraps too many times.
    for (let fontSize = maxFont; fontSize >= minFont && !pick; fontSize--) {
      const { cols, wraps } = wrapAt(fontSize);
      if (fontSize > minFont && rowTotal(wraps) > MAX_ROWS_PER_LINE * Math.max(1, total)) continue;
      take(fontSize, cols, wraps);
    }
    if (!pick) {
      // Too many rows even at the smallest font: tight lines, and only the lines that fit.
      const { cols, wraps } = wrapAt(minFont);
      const perRow = avail / Math.max(rowTotal(wraps), options.planLines ?? 0, 1);
      pick = {
        fontSize: minFont,
        cols,
        wraps,
        lineHeight: Math.max(Math.floor(perRow), Math.ceil(minFont * 1.18)),
      };
    }
    const capacity = Math.max(1, Math.floor(avail / pick.lineHeight));
    let shown = 0;
    let used = 0;
    while (shown < total && used + (pick.wraps[shown]?.rows.length ?? 1) <= capacity) {
      used += pick.wraps[shown]?.rows.length ?? 1;
      shown += 1;
    }
    return { ...pick, shown: Math.max(Math.min(1, total), shown) };
  };

  let footer = code.truncated ? FOOTER_HEIGHT : 0;
  let chosen = choose(footer);
  if (footer === 0 && chosen.shown < total) {
    footer = FOOTER_HEIGHT;
    chosen = choose(footer);
  }
  const { fontSize, lineHeight, cols, wraps } = chosen;
  const shown = Math.min(total, chosen.shown);
  const hidden = total - shown;
  const { charW, numWidth, markWidth, gutterWidth } = gutterFor(fontSize);

  const lineRows = wraps.slice(0, shown).map((w) => w.rows.length);
  const rowStarts: number[] = [];
  let rows = 0;
  for (const n of lineRows) {
    rowStarts.push(rows);
    rows += n;
  }
  const wrapped = lineRows.filter((n) => n > 1).length;

  // A window that wraps uses the whole width it was given; otherwise it hugs the longest line.
  const needed = gutterWidth + TEXT_PAD_LEFT + Math.ceil(longest * charW) + TEXT_PAD_RIGHT + ROW_SLACK;
  const width =
    options.width === 'fit'
      ? Math.round(Math.min(widthLimit, Math.max(options.minWidth ?? 640, wrapped > 0 ? widthLimit : needed)))
      : options.width;
  const natural = barHeight + 2 * padY + rows * lineHeight + footer;
  const height = Math.round(options.height ?? Math.min(options.maxHeight, natural));
  const textWidth = width - gutterWidth - TEXT_PAD_LEFT - TEXT_PAD_RIGHT;
  return {
    width,
    height,
    fontSize,
    lineHeight,
    barHeight,
    padY,
    gutterWidth,
    shown,
    hidden,
    diff,
    rows,
    wrapped,
    charW,
    footer,
    numWidth,
    markWidth,
    textWidth,
    cols,
    wraps,
    lineRows,
    rowStarts,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A small corner arrow that marks a row continued from the one above. */
function wrapMark(size: number): SVGSVGElement {
  return s(
    'svg',
    {
      class: 'ms-codeview__wrap',
      viewBox: '0 0 16 16',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.7,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    s('path', { d: 'M3 2.5v5.2a2.8 2.8 0 0 0 2.8 2.8H12.5' }),
    s('path', { d: 'M9.6 7.7l3 2.8-3 2.8' }),
  );
}

/** Build a code window for `code`. */
export function renderCodeView(code: ResolvedCode, options: CodeViewOptions): CodeView {
  registerStyles();
  const plan = planCodeView(code, options);
  const { width, height, fontSize, lineHeight, barHeight, padY, gutterWidth, shown, hidden, diff } = plan;
  const { footer, numWidth, markWidth, charW, wraps, lineRows, rowStarts } = plan;
  const compact = options.compact ?? false;
  const markSize = Math.round(fontSize * 0.8);

  const lineEls: HTMLElement[] = [];
  const ink: CodeView['ink'] = [];
  const linesWrap = h('div', { class: 'ms-codeview__lines' });
  for (let i = 0; i < shown; i++) {
    const line = code.lines[i]!;
    const wrap = wraps[i]!;
    const lineEl = h('div', {
      class: `ms-codeview__line ms-codeview__line--${line.kind}`,
      style: { height: `${(lineRows[i] ?? 1) * lineHeight}px` },
    });
    wrap.rows.forEach((rowInfo, k) => {
      const text = h('span', { class: 'ms-codeview__text' });
      if (k > 0) text.style.paddingLeft = `${q(TEXT_PAD_LEFT + wrap.hang * charW, 2)}px`;
      if (rowInfo.length * charW + (k > 0 ? wrap.hang * charW : 0) > plan.textWidth) {
        text.classList.add('ms-codeview__text--clip');
      }
      for (const token of rowInfo.tokens) text.append(tokenNode(token));
      const row = h('div', { class: `ms-codeview__row${k > 0 ? ' ms-codeview__row--cont' : ''}` });
      const mark = k > 0 ? wrapMark(markSize) : null;
      if (diff) {
        row.append(
          h('span', {
            class: 'ms-codeview__num',
            text: k > 0 || line.oldNumber === null ? '' : String(line.oldNumber),
          }),
          h('span', {
            class: 'ms-codeview__num',
            text: k > 0 || line.newNumber === null ? '' : String(line.newNumber),
          }),
          h(
            'span',
            { class: 'ms-codeview__mark' },
            k > 0 ? mark : line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : '',
          ),
        );
      } else {
        const n =
          code.side === 'base' ? (line.oldNumber ?? line.newNumber) : (line.newNumber ?? line.oldNumber);
        row.append(h('span', { class: 'ms-codeview__num' }, k > 0 ? mark : n === null ? '' : String(n)));
      }
      row.append(text);
      lineEl.append(row);
      ink.push({
        top: barHeight + padY + (rowStarts[i]! + k) * lineHeight,
        bottom: barHeight + padY + (rowStarts[i]! + k + 1) * lineHeight,
        right: gutterWidth + TEXT_PAD_LEFT + (k > 0 ? wrap.hang : 0) * charW + rowInfo.length * charW,
      });
    });
    linesWrap.append(lineEl);
    lineEls.push(lineEl);
  }

  const language = languageLabel(code.language);
  const reserved =
    Math.ceil(language.length * 13) +
    52 +
    (code.masked ? 160 : 0) +
    (options.barExtrasWidth ?? 0) +
    24 * 2 +
    80;
  const titleChars = Math.max(8, monoChars(width - reserved, 22));
  const right = h('div', { class: 'ms-codeview__right' });
  if (code.masked) {
    right.append(
      h(
        'span',
        { class: 'ms-codeview__flag', attrs: { title: 'Secrets masked' } },
        icon('lock', { size: 22 }),
        'Masked',
      ),
    );
  }
  for (const extra of options.barExtras ?? []) right.append(extra);
  right.append(h('span', { class: 'ms-codeview__chip', text: language }));

  const overlay = h('div', { class: 'ms-codeview__overlay' });
  const body = h(
    'div',
    { class: 'ms-window__body ms-codeview__body', style: { padding: `${padY}px 0` } },
    linesWrap,
  );
  const root = windowFrame({
    class: `ms-codeview${compact ? ' ms-codeview--compact' : ''}${diff ? ' ms-codeview--diff' : ''}`,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      '--cv-fs': `${fontSize}px`,
      '--cv-lh': `${lineHeight}px`,
      '--cv-num': `${numWidth}px`,
      '--cv-mark': `${markWidth}px`,
      '--cv-pad-left': `${TEXT_PAD_LEFT}px`,
      '--cv-pad-right': `${TEXT_PAD_RIGHT}px`,
    },
    barItems: [h('div', { class: 'ms-codeview__path', text: truncatePath(code.path, titleChars) }), right],
    body,
  });
  if (footer > 0) {
    const notes: string[] = [];
    if (hidden > 0) notes.push(`+${hidden} more ${hidden === 1 ? 'line' : 'lines'}`);
    if (code.truncated) notes.push('Shortened to fit the screen');
    root.append(h('div', { class: 'ms-codeview__foot', text: `… ${notes.join('  ·  ')}` }));
  }
  root.append(overlay);

  return {
    root,
    overlay,
    lines: lineEls,
    metrics: {
      width,
      height,
      fontSize,
      lineHeight,
      barHeight,
      padY,
      gutterWidth,
      shown,
      hidden,
      diff,
      rows: plan.rows,
      wrapped: plan.wrapped,
      charW,
      footer,
    },
    lineTop: (index) => barHeight + padY + (rowStarts[index] ?? index) * lineHeight,
    lineSpan: (index) => (lineRows[index] ?? 1) * lineHeight,
    ink,
    setEmphasis(sw, index, emphasis, reveal = 1) {
      const row = lineEls[index];
      if (!row) return;
      sw.opacity(row, reveal * (DIM_OPACITY + (1 - DIM_OPACITY) * emphasis));
      sw.transform(row, reveal < 1 ? `translate(${q((reveal - 1) * 18, 2)}px, 0px)` : 'none');
    },
  };
}

function tokenNode(token: CodeToken): Node {
  if (!token.c && !token.s) return document.createTextNode(token.t);
  const span = h('span', { text: token.t });
  if (token.c) span.style.color = token.c;
  if (token.s & 1) span.style.fontStyle = 'italic';
  if (token.s & 2) span.style.fontWeight = '700';
  if (token.s & 4) span.style.textDecoration = 'underline';
  return span;
}

function registerStyles(): void {
  css(
    'ms-codeview',
    `
.ms-codeview { font-family: var(--font-code); font-feature-settings: normal; font-variant-ligatures: none; }
.ms-codeview .ms-window__bar { height: 64px; padding: 0 24px; gap: 18px; }
.ms-codeview--compact .ms-window__bar { height: 56px; padding: 0 20px; gap: 14px; }
.ms-codeview--compact .ms-window__lights i { width: 12px; height: 12px; }
.ms-codeview__path {
  flex: 1 1 0;
  min-width: 0;
  font-size: 22px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
}
.ms-codeview__right { display: flex; align-items: center; gap: 12px; flex: none; margin-left: auto; }
.ms-codeview__chip, .ms-codeview__flag, .ms-codeview__tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px;
  border-radius: var(--radius-pill);
  font-family: var(--font-ui);
  font-size: 22px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  color: var(--text-1);
  background: var(--surface-inset);
  box-shadow: 0 0 0 1px var(--border-2);
}
.ms-codeview__flag { color: var(--del); background: var(--del-soft); box-shadow: 0 0 0 1px rgba(255, 107, 129, 0.4); }
.ms-codeview__tag { color: var(--accent-2); background: var(--accent-2-soft); box-shadow: 0 0 0 1px color-mix(in srgb, var(--glow-2) 35%, transparent); }
.ms-codeview__body { overflow: hidden; }
.ms-codeview__lines { position: relative; }
.ms-codeview__line {
  display: block;
  font-size: var(--cv-fs);
  white-space: pre;
  color: var(--text-0);
}
.ms-codeview__row {
  display: flex;
  height: var(--cv-lh);
  line-height: var(--cv-lh);
}
.ms-codeview__num {
  flex: none;
  width: var(--cv-num);
  padding-right: 14px;
  text-align: right;
  color: var(--text-3);
}
.ms-codeview__mark { flex: none; width: var(--cv-mark); text-align: center; font-weight: 700; color: var(--text-3); }
.ms-codeview__num .ms-codeview__wrap, .ms-codeview__mark .ms-codeview__wrap {
  display: inline-block;
  vertical-align: middle;
  margin-top: -0.12em;
  color: var(--text-3);
}
.ms-codeview__text {
  flex: 1 1 0;
  min-width: 0;
  padding-left: var(--cv-pad-left);
  padding-right: var(--cv-pad-right);
}
.ms-codeview__text--clip {
  overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 72px), transparent);
  mask-image: linear-gradient(90deg, #000 calc(100% - 72px), transparent);
}
.ms-codeview__line--add { background: var(--add-line); box-shadow: inset 4px 0 0 var(--add); }
.ms-codeview__line--add .ms-codeview__num { background: var(--add-soft); color: var(--text-2); }
.ms-codeview__line--add .ms-codeview__mark { color: var(--add); }
.ms-codeview__line--del { background: var(--del-line); box-shadow: inset 4px 0 0 var(--del); }
.ms-codeview__line--del .ms-codeview__num { background: var(--del-soft); color: var(--text-2); }
.ms-codeview__line--del .ms-codeview__mark { color: var(--del); }
.ms-codeview__line--del .ms-codeview__text { opacity: 0.9; }
.ms-codeview__foot {
  display: flex;
  align-items: center;
  height: ${FOOTER_HEIGHT}px;
  padding: 0 24px;
  flex: none;
  border-top: 1px solid var(--border-1);
  font-family: var(--font-ui);
  font-size: 22px;
  color: var(--text-2);
}
.ms-codeview__overlay { position: absolute; inset: 0; pointer-events: none; }
`,
  );
}
