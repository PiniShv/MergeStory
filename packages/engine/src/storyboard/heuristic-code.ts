/**
 * Choosing what the code scenes show. A code scene is a window of at most 18 lines around the most
 * important symbol of a key hunk. Only symbols whose lines are on screen are described, so the
 * narration never talks about code the viewer cannot see.
 */
import { changedLinesAt, diffViewSpan, hunkLines, overlapsAnyHunk, shrinkRange } from '../core/diff-view.ts';
import { isShowable } from '../core/path-policy.ts';
import { STORYBOARD_LIMITS as LIMITS } from '../core/storyboard-schema.ts';
import type {
  ChangedFile,
  DiffHunk,
  DiffLine,
  FileRole,
  KeyHunk,
  Side,
  SymbolChange,
  SymbolKind,
} from '../core/types.ts';
import { type Ctx, isTrivial, symbolName } from './heuristic-context.ts';
import { escapeRegExp } from './text.ts';

/** The longest code range a scene may show. */
export const MAX_LINES = LIMITS.maxCodeLines;
/** At most this many symbols are described in one code scene. */
export const MAX_SYMBOLS_IN_VIEW = 3;
/** Symbols are packed into one window when no more than this many lines lie between them. */
const MAX_GAP = 4;
/** The longest declaration (signature) that gets its own highlight. */
const MAX_DECLARATION_LINES = 6;
/** Comment lines directly above a symbol are shown with it, up to this many. */
const MAX_COMMENT_LINES = 3;
/** A second window from the same hunk counts for less than the first one. */
const SECONDARY_DISCOUNT = 0.6;
/** Longer lines are minified or generated text; names in them are not looked for. */
const MAX_SCANNED_LINE = 2000;
/** A hunk with no known symbol and fewer changed lines than this (imports, one-line edits) is not worth a scene. */
const MIN_PLAIN_CHANGES = 4;

// ---------------------------------------------------------------------------
// Lines of a file at one side, as far as the diff shows them
// ---------------------------------------------------------------------------

export interface SideLines {
  /** Text of every line that the diff carries at this side. */
  text: Map<number, string>;
  /** Whether each of those lines is added or removed by the change, or unchanged context. */
  kind: Map<number, DiffLine['kind']>;
}

export function sideLines(file: ChangedFile, side: Side): SideLines {
  const text = new Map<number, string>();
  const kind = new Map<number, DiffLine['kind']>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const n = side === 'head' ? line.newLine : line.oldLine;
      if (n === null) continue;
      text.set(n, line.text);
      kind.set(n, line.kind);
    }
  }
  return { text, kind };
}

/** The side to show. A new file has only a head side and a deleted file only a base side; otherwise the analysis decides. */
export function sideFor(file: ChangedFile, hint: Side): Side {
  if (file.status === 'added') return 'head';
  if (file.status === 'deleted') return 'base';
  return hint;
}

/** The lines a hunk covers at one side. */
function hunkSpan(hunk: DiffHunk, side: Side): [number, number] {
  const { start: first, count } = hunkLines(hunk, side);
  const start = Math.max(1, first);
  return [start, Math.max(start, start + count - 1)];
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export interface SymbolView {
  symbol: SymbolChange;
  /** The name as it may be said: masked and checked. */
  name: string;
  /** Lines of the symbol that this change adds (at head) or removes (at base). */
  changed: number;
}

/** The word that names a kind of symbol in narration. */
export const SYMBOL_WORD: Record<SymbolKind, string> = {
  function: 'function',
  method: 'method',
  class: 'class',
  interface: 'interface',
  type: 'type',
  constant: 'constant',
  component: 'component',
  route: 'route',
  other: 'symbol',
};

/** A name as it is said in a sentence. A bare lowercase word such as "get" needs its kind: "the method get". */
export function proseName(kind: SymbolKind, name: string): string {
  return /^[a-z][a-z0-9]*$/.test(name) ? `the ${SYMBOL_WORD[kind]} ${name}` : name;
}

const FUNCTION_LIKE = new Set<SymbolKind>(['function', 'method', 'class', 'component', 'route']);

/** Lower is more important: exported, added or modified functions and classes come first. */
function rank(view: SymbolView): number {
  const { symbol } = view;
  if (symbol.change === 'removed') return 4;
  if (FUNCTION_LIKE.has(symbol.kind)) return symbol.exported ? 0 : 1;
  return symbol.exported ? 2 : 3;
}

/** The order of importance: lower rank first, then more changed lines, then the larger symbol. */
export function compareViews(a: SymbolView, b: SymbolView): number {
  return (
    rank(a) - rank(b) ||
    b.changed - a.changed ||
    b.symbol.endLine - b.symbol.startLine - (a.symbol.endLine - a.symbol.startLine) ||
    a.symbol.startLine - b.symbol.startLine
  );
}

const spanOf = (symbol: SymbolChange): number => symbol.endLine - symbol.startLine + 1;

/** `inner` lies inside `outer` and is smaller than it. */
export function nestedIn(inner: SymbolView, outer: SymbolView): boolean {
  return (
    inner !== outer &&
    inner.symbol.startLine >= outer.symbol.startLine &&
    inner.symbol.endLine <= outer.symbol.endLine &&
    spanOf(inner.symbol) < spanOf(outer.symbol)
  );
}

function countIn(changed: readonly number[], from: number, to: number): number {
  let n = 0;
  for (const line of changed) if (line >= from && line <= to) n++;
  return n;
}

/** The symbols of a file at one side that may be named, with the number of lines the change touches in each. */
export function symbolViews(ctx: Ctx, file: ChangedFile, side: Side): SymbolView[] {
  const changed = changedLinesAt(file, side);
  const views: SymbolView[] = [];
  for (const symbol of ctx.symbolsByFile.get(file.id) ?? []) {
    if (symbol.side !== side) continue;
    const name = symbolName(ctx, symbol);
    if (name === null) continue;
    views.push({ symbol, name, changed: countIn(changed, symbol.startLine, symbol.endLine) });
  }
  return views;
}

/**
 * A container (a class, say) gives way to the symbols inside it when it is too big to show whole or
 * when it only counts as modified because something inside it changed. A new class stays: its
 * members are part of it.
 */
function withoutContainers(views: readonly SymbolView[]): SymbolView[] {
  return views.filter((view) => {
    if (!views.some((other) => nestedIn(other, view))) return true;
    return !(spanOf(view.symbol) > MAX_LINES || view.symbol.change === 'modified');
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export interface CodeWindow {
  file: ChangedFile;
  keyHunk: KeyHunk;
  side: Side;
  from: number;
  to: number;
  /** The most important symbol of the window, or null when the hunk has no known symbol. */
  anchor: SymbolView | null;
  /** The symbols on screen, in line order, at most three. Nested ones are left out. */
  inView: SymbolView[];
  mode: 'diff' | 'snippet';
  score: number;
  /** A later window taken from a hunk that already has one. */
  secondary: boolean;
}

function insideWindow(view: SymbolView, from: number, to: number): boolean {
  return view.symbol.startLine >= from && view.symbol.endLine <= to;
}

function overlapsWindow(view: SymbolView, from: number, to: number): boolean {
  return view.symbol.startLine <= to && view.symbol.endLine >= from;
}

/** The symbols whose lines are on screen, without the ones that another symbol on screen stands in for. */
function symbolsInView(
  all: readonly SymbolView[],
  from: number,
  to: number,
  anchor: SymbolView | null,
): SymbolView[] {
  const overlapping = all.filter((view) => overlapsWindow(view, from, to));
  // A new class that is fully on screen stands for its members; a modified one does not.
  const standsForMembers = (outer: SymbolView): boolean =>
    insideWindow(outer, from, to) && outer.symbol.change !== 'modified';
  const kept = overlapping.filter((view) => {
    if (overlapping.some((other) => nestedIn(other, view))) return standsForMembers(view);
    return !overlapping.some((outer) => nestedIn(view, outer) && standsForMembers(outer));
  });
  if (kept.length <= MAX_SYMBOLS_IN_VIEW) return kept.sort((a, b) => a.symbol.startLine - b.symbol.startLine);
  const best = [...kept].sort((a, b) => (a === anchor ? -1 : b === anchor ? 1 : compareViews(a, b)));
  return best.slice(0, MAX_SYMBOLS_IN_VIEW).sort((a, b) => a.symbol.startLine - b.symbol.startLine);
}

/** Contiguous comment lines directly above `from`, so a doc comment stays with its function. */
function commentLinesAbove(lines: SideLines, from: number, room: number): number {
  let count = 0;
  while (count < MAX_COMMENT_LINES && count < room) {
    const text = lines.text.get(from - count - 1);
    if (text === undefined || !/^\s*(?:\/\*\*?|\*|\/\/|#(?!!))/.test(text)) break;
    count++;
  }
  return count;
}

/** Lines of a window that hold the most changed lines of a symbol too long to show whole. */
function oversizeWindow(view: SymbolView, changed: readonly number[]): [number, number] {
  const { startLine, endLine } = view.symbol;
  const inside = changed.filter((line) => line >= startLine && line <= endLine);
  const firstChanged = inside[0];
  let first = startLine;
  // Keep the signature on screen when the change starts near the top; otherwise go to the change.
  if (firstChanged !== undefined && firstChanged - startLine > MAX_COMMENT_LINES) first = firstChanged - 2;
  first = Math.max(startLine, Math.min(first, endLine - MAX_LINES + 1));
  return [first, first + MAX_LINES - 1];
}

/** Grow a window around its anchor with the symbols next to it, while it stays within the line limit. */
function pack(
  anchor: SymbolView,
  pool: readonly SymbolView[],
  taken: ReadonlySet<string>,
): { from: number; to: number } {
  let from = anchor.symbol.startLine;
  let to = anchor.symbol.endLine;
  const members: SymbolView[] = [anchor];
  for (;;) {
    let best: SymbolView | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const view of pool) {
      if (members.includes(view) || taken.has(view.symbol.id)) continue;
      if (members.some((member) => nestedIn(view, member) || nestedIn(member, view))) continue;
      const { startLine, endLine } = view.symbol;
      const newFrom = Math.min(from, startLine);
      const newTo = Math.max(to, endLine);
      if (newTo - newFrom + 1 > MAX_LINES || members.length >= MAX_SYMBOLS_IN_VIEW) continue;
      const gap = startLine > to ? startLine - to - 1 : endLine < from ? from - endLine - 1 : 0;
      if (gap > MAX_GAP) continue;
      if (gap < bestGap || (gap === bestGap && best !== null && compareViews(view, best) < 0)) {
        best = view;
        bestGap = gap;
      }
    }
    if (best === null) return { from, to };
    members.push(best);
    from = Math.min(from, best.symbol.startLine);
    to = Math.max(to, best.symbol.endLine);
  }
}

/** "diff" when the changed lines and the removed lines all fit on screen, "snippet" otherwise. */
function modeFor(file: ChangedFile, side: Side, from: number, to: number): 'diff' | 'snippet' {
  // A new file is all added lines: showing it as plain code is clearer.
  if (file.status === 'added' || file.status === 'deleted') return 'snippet';
  if (!overlapsAnyHunk(file, side, from, to)) return 'snippet';
  const rows = diffViewSpan(file, side, from, to)?.length ?? null;
  return rows !== null && rows <= MAX_LINES ? 'diff' : 'snippet';
}

interface Candidate {
  keyHunk: KeyHunk;
  file: ChangedFile;
  hunk: DiffHunk;
  side: Side;
  tier: 0 | 1;
}

const CODE_ROLES = new Set<FileRole>(['source', 'migration', 'build', 'other']);

function candidatesOf(ctx: Ctx): Candidate[] {
  const out: Candidate[] = [];
  for (const keyHunk of ctx.analysis.keyHunks) {
    const file = ctx.fileById.get(keyHunk.fileId);
    if (!file || !isShowable(file) || isTrivial(ctx, file)) continue;
    if (!ctx.evidence.has(keyHunk.id) || keyHunk.endLine < keyHunk.startLine || keyHunk.startLine < 1)
      continue;
    const hunk = file.hunks.find((h) => h.id === keyHunk.id);
    if (!hunk) continue;
    const role = ctx.insightByFile.get(file.id)?.role ?? 'source';
    out.push({
      keyHunk,
      file,
      hunk,
      side: sideFor(file, keyHunk.side),
      tier: CODE_ROLES.has(role) ? 0 : 1,
    });
  }
  return out.sort((a, b) => b.keyHunk.score - a.keyHunk.score || a.keyHunk.id.localeCompare(b.keyHunk.id));
}

/** The best window of one hunk that does not repeat symbols that earlier windows already cover. */
function windowFor(
  ctx: Ctx,
  candidate: Candidate,
  taken: ReadonlySet<string>,
  secondary: boolean,
  relaxed: boolean,
): CodeWindow | null {
  const { keyHunk, file, hunk, side } = candidate;
  const [hunkStart, hunkEnd] = hunkSpan(hunk, side);
  const lines = sideLines(file, side);
  const changed = changedLinesAt(file, side);
  const all = symbolViews(ctx, file, side);
  const inHunk = all.filter((view) => view.symbol.startLine <= hunkEnd && view.symbol.endLine >= hunkStart);
  const eligible = withoutContainers(inHunk);
  const pool = eligible.filter((view) => !taken.has(view.symbol.id));
  const score = keyHunk.score * (secondary ? SECONDARY_DISCOUNT : 1);

  if (all.length === 0 || inHunk.length === 0) {
    if (secondary) return null;
    if (!relaxed && countIn(changed, hunkStart, hunkEnd) < MIN_PLAIN_CHANGES) return null;
    const [from, to] = shrinkRange(hunkStart, hunkEnd, MAX_LINES, changed, null);
    return {
      file,
      keyHunk,
      side,
      from,
      to,
      anchor: null,
      inView: [],
      mode: modeFor(file, side, from, to),
      score,
      secondary,
    };
  }

  const anchor = [...pool].sort(compareViews)[0];
  if (!anchor) return null;
  // A second window must be worth a scene of its own.
  if (secondary && anchor.changed < 3) return null;

  let from: number;
  let to: number;
  if (spanOf(anchor.symbol) > MAX_LINES) {
    [from, to] = oversizeWindow(anchor, changed);
  } else {
    ({ from, to } = pack(anchor, pool, taken));
    from -= commentLinesAbove(lines, from, MAX_LINES - (to - from + 1));
  }
  // Symbols that an earlier window already describes are not described again.
  const inView = symbolsInView(
    all.filter((view) => view === anchor || !taken.has(view.symbol.id)),
    from,
    to,
    anchor,
  );
  return {
    file,
    keyHunk,
    side,
    from,
    to,
    anchor,
    inView,
    mode: modeFor(file, side, from, to),
    score,
    secondary,
  };
}

/**
 * Pick up to `count` windows. Source files only, unless the change has none. Each file gets one
 * window before any file gets a second one, and a second window of the same hunk comes last.
 */
export function planWindows(ctx: Ctx, count: number): CodeWindow[] {
  if (count <= 0) return [];
  const candidates = candidatesOf(ctx);
  const chosen: CodeWindow[] = [];
  const taken = new Set<string>();
  const fileHasWindow = new Set<string>();
  const hunkWindows = new Map<string, number>();

  const add = (window: CodeWindow): void => {
    chosen.push(window);
    for (const view of window.inView) taken.add(view.symbol.id);
    if (window.anchor) taken.add(window.anchor.symbol.id);
    fileHasWindow.add(window.file.id);
    hunkWindows.set(window.keyHunk.id, (hunkWindows.get(window.keyHunk.id) ?? 0) + 1);
  };

  const run = (relaxed: boolean): void => {
    for (const tier of [0, 1] as const) {
      const group = candidates.filter((candidate) => candidate.tier === tier);
      const passes: ((candidate: Candidate) => CodeWindow | null)[] = [
        (c) => (fileHasWindow.has(c.file.id) ? null : windowFor(ctx, c, taken, false, relaxed)),
        (c) => (hunkWindows.has(c.keyHunk.id) ? null : windowFor(ctx, c, taken, false, relaxed)),
        (c) => (hunkWindows.has(c.keyHunk.id) ? windowFor(ctx, c, taken, true, relaxed) : null),
      ];
      for (const pass of passes) {
        for (const candidate of group) {
          if (chosen.length >= count) return;
          const window = pass(candidate);
          if (window) add(window);
        }
      }
      // Tests, docs and configuration get a scene only when the change has no code to show.
      if (chosen.length > 0) return;
    }
  };
  run(false);
  // A change made only of small edits still gets a scene.
  if (chosen.length === 0) run(true);

  // Windows of one file stay together; the best file comes first, and so does the best window of a file.
  const best = new Map<string, number>();
  for (const window of chosen)
    best.set(window.file.id, Math.max(best.get(window.file.id) ?? 0, window.score));
  return chosen.sort(
    (a, b) =>
      (best.get(b.file.id) ?? 0) - (best.get(a.file.id) ?? 0) ||
      a.file.id.localeCompare(b.file.id) ||
      b.score - a.score ||
      a.from - b.from,
  );
}

// ---------------------------------------------------------------------------
// The two sides of a modified function
// ---------------------------------------------------------------------------

/** The base line that an unchanged head line came from, or null when the head line is new. */
function baseLineFor(file: ChangedFile, headLine: number): number | null {
  let delta = 0;
  const hunks = [...file.hunks].sort((a, b) => a.newStart - b.newStart);
  for (const hunk of hunks) {
    const before = hunk.newLines > 0 ? headLine < hunk.newStart : headLine <= hunk.newStart;
    if (before) return headLine - delta;
    if (hunk.newLines > 0 && headLine < hunk.newStart + hunk.newLines) {
      const line = hunk.lines.find((l) => l.newLine === headLine);
      return line && line.kind === 'ctx' ? line.oldLine : null;
    }
    delta += hunk.newLines - hunk.oldLines;
  }
  return headLine - delta;
}

export interface BeforeAfter {
  view: SymbolView;
  file: ChangedFile;
  base: [number, number];
  head: [number, number];
}

/**
 * The old and new lines of a modified function or method, when both fit on screen. The first and
 * last line of the function must be unchanged, so that the two ranges describe the same function.
 */
export function beforeAfterOf(file: ChangedFile, view: SymbolView): BeforeAfter | null {
  const { symbol } = view;
  if (symbol.change !== 'modified' || symbol.side !== 'head') return null;
  if (symbol.kind !== 'function' && symbol.kind !== 'method') return null;
  if (!isShowable(file) || file.status === 'added' || file.status === 'deleted') return null;
  if (spanOf(symbol) > MAX_LINES) return null;
  const start = baseLineFor(file, symbol.startLine);
  const end = baseLineFor(file, symbol.endLine);
  if (start === null || end === null || end < start || end - start + 1 > MAX_LINES) return null;
  return { view, file, base: [start, end], head: [symbol.startLine, symbol.endLine] };
}

// ---------------------------------------------------------------------------
// Reading the lines on screen
// ---------------------------------------------------------------------------

/** Where the declaration (the signature) of a symbol ends. One line when it cannot be told. */
export function declarationEnd(lines: SideLines, symbol: SymbolChange): number {
  const last = Math.min(symbol.endLine, symbol.startLine + MAX_DECLARATION_LINES - 1);
  for (let n = symbol.startLine; n <= last; n++) {
    const text = lines.text.get(n);
    if (text === undefined) break;
    if (/(?:\{|:|=>)\s*$/.test(text)) return n;
  }
  return symbol.startLine;
}

/** The text of a line without string literals and comments, so names inside them are not taken for code. */
export function codeOnly(text: string): string {
  // A line this long is minified or generated: it is not searched.
  if (text.length > MAX_SCANNED_LINE) return '';
  const trimmed = text.trim();
  if (/^(?:\/\/|\/\*|\*|#(?!!))/.test(trimmed)) return '';
  return text
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\s#\s.*$/, '');
}

/** Runs of changed lines inside a range, merged when only one line lies between them. */
export function changedRuns(changed: readonly number[], from: number, to: number): [number, number][] {
  const runs: [number, number][] = [];
  for (const n of changed) {
    if (n < from || n > to) continue;
    const last = runs[runs.length - 1];
    if (last && n <= last[1] + 2) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

/** The kinds of reference one changed symbol can make to another. */
export type ReferenceKind = 'calls' | 'creates' | 'uses';

export interface Reference {
  symbol: SymbolChange;
  name: string;
  kind: ReferenceKind;
  /** The first added line that mentions it. */
  line: number;
}

const REFERENCE_ORDER: Record<ReferenceKind, number> = { calls: 0, creates: 1, uses: 2 };
const PLAIN_NAME = /^[A-Za-z_$][\w$]{3,}$/;

/**
 * Other changed symbols that the added lines of `view` mention, found by name. Only head lines in
 * [from, to] that this change adds count, and names inside strings or comments do not.
 */
export function findReferences(
  ctx: Ctx,
  file: ChangedFile,
  view: SymbolView,
  window: { from: number; to: number },
  max = 3,
): Reference[] {
  if (view.symbol.side !== 'head') return [];
  const lines = sideLines(file, 'head');
  const from = Math.max(window.from, view.symbol.startLine);
  const to = Math.min(window.to, view.symbol.endLine);
  const found = new Map<string, Reference>();
  for (const other of ctx.analysis.symbols) {
    if (other.id === view.symbol.id || other.side !== 'head' || other.change === 'removed') continue;
    if (!PLAIN_NAME.test(other.name) || other.name === view.symbol.name) continue;
    const name = symbolName(ctx, other);
    if (name === null) continue;
    const word = new RegExp(`(?<![\\w$.])${escapeRegExp(other.name)}(?![\\w$])`);
    const call = new RegExp(`(?<![\\w$.])${escapeRegExp(other.name)}\\s*\\(`);
    const create = new RegExp(`\\bnew\\s+${escapeRegExp(other.name)}\\s*\\(`);
    // The strongest way a symbol is mentioned wins; among equals, the first line.
    let reference: Reference | null = null;
    for (let n = from; n <= to; n++) {
      if (lines.kind.get(n) !== 'add') continue;
      const text = codeOnly(lines.text.get(n) ?? '');
      if (!word.test(text)) continue;
      const kind: ReferenceKind = create.test(text) ? 'creates' : call.test(text) ? 'calls' : 'uses';
      if (reference === null || REFERENCE_ORDER[kind] < REFERENCE_ORDER[reference.kind])
        reference = { symbol: other, name, kind, line: n };
    }
    if (reference) found.set(other.id, reference);
  }
  return [...found.values()]
    .sort((a, b) => REFERENCE_ORDER[a.kind] - REFERENCE_ORDER[b.kind] || a.line - b.line)
    .slice(0, max);
}

const CALL = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
const NOT_CALLS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'typeof',
  'await',
  'async',
  'super',
  'new',
  'import',
  'require',
  'elif',
  'def',
  'class',
  'fn',
  'func',
  'else',
  'with',
  'assert',
  'sizeof',
  'defer',
  'match',
  'when',
]);

/** Names that are called as plain functions (not as methods) in the lines of a range, in order of appearance. */
export function callNames(
  lines: SideLines,
  range: { from: number; to: number },
  kinds: readonly DiffLine['kind'][],
): string[] {
  const names: string[] = [];
  for (let n = range.from; n <= range.to; n++) {
    const kind = lines.kind.get(n);
    if (kind === undefined || !kinds.includes(kind)) continue;
    for (const match of codeOnly(lines.text.get(n) ?? '').matchAll(CALL)) {
      const name = match[1]!;
      if (name.length >= 3 && !NOT_CALLS.has(name) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}
