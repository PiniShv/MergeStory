/**
 * The code scenes: a window of code around the most important symbol of a hunk, or the old and new
 * lines of one small modified function side by side. The narration says only what the lines on
 * screen show.
 */

import { changedLinesAt } from '../core/diff-view.ts';
import { basename } from '../core/posix.ts';
import { type CodeRefInput, STORYBOARD_LIMITS as LIMITS, type Scene } from '../core/storyboard-schema.ts';
import { naturalList, plural } from '../core/text.ts';
import type { RiskSignal, SymbolChange } from '../core/types.ts';
import {
  type BeforeAfter,
  beforeAfterOf,
  type CodeWindow,
  callNames,
  changedRuns,
  declarationEnd,
  findReferences,
  planWindows,
  proseName,
  type Reference,
  type SideLines,
  SYMBOL_WORD,
  type SymbolView,
  sideLines,
} from './heuristic-code.ts';
import { type Ctx, cite, type Line, symbolName } from './heuristic-context.ts';
import {
  numericFacts,
  numericSentences,
  pickStatement,
  quoteLine,
  type StatementMatch,
} from './heuristic-facts.ts';
import { type Build, scene, sizeText } from './heuristic-shared.ts';
import { capitalise, escapeRegExp, truncateText } from './text.ts';

// ---------------------------------------------------------------------------
// Code scenes
// ---------------------------------------------------------------------------

const CHANGE_LABEL: Record<SymbolChange['change'], string> = {
  added: 'New',
  modified: 'Changed',
  removed: 'Removed',
};

interface FocusDraft {
  startLine: number;
  endLine: number;
  note: string | null;
  /** Dropped when another highlight already covers the lines. */
  optional?: boolean;
}

/** A candidate narration line with the focus ranges that go with it. Lower priority numbers survive a cut. */
interface Draft extends Line {
  focus: FocusDraft[];
  priority: number;
  order: number;
  quote?: StatementMatch;
}

/** "exported" in languages that have exports, "public" in the others. */
function visibility(path: string): string {
  return /\.(?:[mc]?[jt]sx?|go)$/i.test(path) ? 'exported' : 'public';
}

function anchorText(b: Build, lead: string, view: SymbolView, path: string): string {
  const { symbol, name } = view;
  const word = SYMBOL_WORD[symbol.kind];
  const note = b.ctx.config.style === 'product' || !symbol.exported ? null : visibility(path);
  if (symbol.change === 'added') return `${lead}, the ${word} ${name} is new${note ? ` and ${note}` : ''}.`;
  if (symbol.change === 'modified')
    return `${lead}, the ${word} ${name} was changed${note ? ` and is ${note}` : ''}.`;
  return `${lead}, the ${word} ${name} was removed.${note ? ` It was ${note}.` : ''}`;
}

/** The other symbols on screen, grouped by what happened to them. */
function othersText(views: readonly SymbolView[]): string {
  const phrase = {
    added: ['is new', 'are new'],
    modified: ['was changed', 'were changed'],
    removed: ['was removed', 'were removed'],
  };
  const sentences: string[] = [];
  for (const change of ['added', 'modified', 'removed'] as const) {
    const group = views.filter((view) => view.symbol.change === change);
    if (group.length === 0) continue;
    const names = naturalList(group.map((view) => `the ${SYMBOL_WORD[view.symbol.kind]} ${view.name}`));
    sentences.push(`${capitalise(names)} ${phrase[change][group.length === 1 ? 0 : 1]} too.`);
  }
  return sentences.join(' ');
}

/** The name that starts a sentence. A name from code keeps its case: "withRetry calls ...", not "WithRetry". */
function sentenceSubject(view: SymbolView): string {
  const subject = proseName(view.symbol.kind, view.name);
  return subject.startsWith('the ') ? capitalise(subject) : subject;
}

/** What the symbol `subject` calls, creates and uses. The line names its subject: another line may come before it. */
function referencesText(subject: string, references: readonly Reference[]): string {
  const sentences: string[] = [];
  for (const kind of ['calls', 'creates', 'uses'] as const) {
    const group = references.filter((reference) => reference.kind === kind);
    if (group.length === 0) continue;
    sentences.push(
      `${sentences.length > 0 ? 'It also' : subject} ${kind} ${naturalList(group.map((r) => r.name))}.`,
    );
  }
  return sentences.join(' ');
}

/** The lines to highlight for a symbol: all of it when it is short, otherwise its declaration or its changed lines. */
function symbolFocus(
  lines: SideLines,
  changed: readonly number[],
  view: SymbolView,
  window: { from: number; to: number },
): FocusDraft {
  const { startLine, endLine } = view.symbol;
  const first = Math.max(startLine, window.from);
  const last = Math.min(endLine, window.to);
  const note = `${CHANGE_LABEL[view.symbol.change]} ${SYMBOL_WORD[view.symbol.kind]} ${view.name}`;
  if (last - first + 1 <= 4) return { startLine: first, endLine: last, note };
  if (startLine >= window.from) {
    return { startLine, endLine: Math.min(declarationEnd(lines, view.symbol), window.to), note };
  }
  // The signature is off screen: point at the first lines this change touches.
  const run = changedRuns(changed, first, last)[0];
  return run
    ? { startLine: run[0], endLine: Math.min(run[1], run[0] + 5), note }
    : { startLine: first, endLine: first, note };
}

/** One highlight per line that mentions other changed symbols, with the symbols in its note. */
function referenceFocus(references: readonly Reference[]): FocusDraft[] {
  const byLine = new Map<number, Reference[]>();
  for (const reference of references) {
    byLine.set(reference.line, [...(byLine.get(reference.line) ?? []), reference]);
  }
  return [...byLine.entries()]
    .sort(([a], [z]) => a - z)
    .map(([line, group]) => {
      const kinds = ['calls', 'creates', 'uses'] as const;
      const note = kinds
        .map((kind) => [kind, group.filter((reference) => reference.kind === kind)] as const)
        .filter(([, found]) => found.length > 0)
        .map(
          ([kind, found]) => `${capitalise(kind)} ${naturalList(found.map((reference) => reference.name))}`,
        )
        .join('; ');
      return { startLine: line, endLine: line, note };
    });
}

/**
 * Values the analysis found on a line that is on screen, as sentences about the symbol that holds
 * them. A value outside every symbol on screen (a top-level constant) belongs to the file.
 */
function valuesOnScreen(
  ctx: Ctx,
  window: CodeWindow,
): { risk: RiskSignal; sentences: string[]; line: number; subject: SymbolView | null } | null {
  if (window.side !== 'head') return null;
  for (const risk of ctx.analysis.risks) {
    const ref = risk.ref;
    if (ref?.side !== 'head' || ref.path !== window.file.path) continue;
    if (ref.startLine < window.from || ref.startLine > window.to) continue;
    const facts = numericFacts(risk);
    if (facts.length === 0) continue;
    const subject =
      window.inView.find(
        (view) => view.symbol.startLine <= ref.startLine && view.symbol.endLine >= ref.startLine,
      ) ?? null;
    return {
      risk,
      sentences: numericSentences(facts, subject?.name ?? basename(window.file.path)),
      line: ref.startLine,
      subject,
    };
  }
  return null;
}

/** The first line on screen that mentions a name as a whole word, or null. */
function firstLineWith(lines: SideLines, window: { from: number; to: number }, name: string): number | null {
  const word = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
  for (let n = window.from; n <= window.to; n++) {
    if (word.test(lines.text.get(n) ?? '')) return n;
  }
  return null;
}

function codeScene(b: Build, window: CodeWindow, shown: Set<string>): Scene {
  const { ctx, level } = b;
  const { file, keyHunk, side } = window;
  const name = basename(file.path);
  const sourceLines = sideLines(file, side);
  const changed = changedLinesAt(file, side);
  const lead = shown.has(file.id) ? `Also in ${name}` : `In ${name}`;
  shown.add(file.id);
  const drafts: Draft[] = [];
  let title: string;
  let description: string;

  const anchor = window.anchor;
  if (anchor === null) {
    const hunk = file.hunks.find((h) => h.id === keyHunk.id);
    const adds = hunk ? hunk.lines.filter((l) => l.kind === 'add').length : 0;
    const dels = hunk ? hunk.lines.filter((l) => l.kind === 'del').length : 0;
    drafts.push({
      text:
        file.status === 'deleted'
          ? `${name} is deleted, which removes ${plural(dels, 'line')}.`
          : `${name} changes here, with ${sizeText(adds, dels)}.`,
      evidence: cite(ctx, keyHunk.id, file.id),
      focus: changedRuns(changed, window.from, window.to)
        .slice(0, 3)
        .map(([a, z]) => ({ startLine: a, endLine: z, note: null })),
      priority: 0,
      order: 0,
    });
    title = lead.startsWith('Also') ? `More in ${name}` : `Inside ${name}`;
    description = `The ${window.mode === 'diff' ? 'diff' : 'code'} of ${name} with the changed lines highlighted.`;
  } else {
    const hunkId = keyHunk.id;
    drafts.push({
      text: anchorText(b, lead, anchor, file.path),
      evidence: cite(ctx, hunkId, anchor.symbol.id),
      focus: [symbolFocus(sourceLines, changed, anchor, window)],
      priority: 0,
      order: 0,
    });
    const others = window.inView.filter((view) => view !== anchor);
    if (others.length > 0) {
      drafts.push({
        text: othersText(others),
        evidence: cite(ctx, hunkId, ...others.map((view) => view.symbol.id)),
        focus: others.map((view) => symbolFocus(sourceLines, changed, view, window)),
        priority: 1,
        order: 1,
      });
    }
    const references = findReferences(ctx, file, anchor, window);
    if (references.length > 0) {
      drafts.push({
        text: referencesText(sentenceSubject(anchor), references),
        evidence: cite(ctx, hunkId, anchor.symbol.id, ...references.map((r) => r.symbol.id)),
        focus: referenceFocus(references),
        priority: 4,
        order: 2,
      });
    }
    const values = valuesOnScreen(ctx, window);
    if (values) {
      drafts.push({
        text: values.sentences.join(' '),
        evidence: cite(ctx, values.risk.id, hunkId, values.subject?.symbol.id ?? anchor.symbol.id),
        focus: [{ startLine: values.line, endLine: values.line, note: 'Values found by the analysis' }],
        priority: 2,
        order: 3,
      });
    }
    if (level.quotes) {
      const text: string[] = [];
      for (let n = window.from; n <= window.to; n++) text.push(sourceLines.text.get(n) ?? '');
      const names = window.inView.flatMap((view) => [view.name, ...view.name.split('.')]);
      const match = pickStatement(b.statements, { code: text.join('\n'), names }, b.used);
      if (match) {
        // Point at a name from the code first; the symbols' own names are marked by their declarations.
        const symbolNames = new Set(names);
        const mentioned = [...match.shared].sort(
          (a, z) => Number(symbolNames.has(a)) - Number(symbolNames.has(z)),
        );
        const hit = mentioned
          .map((shared) => ({ shared, line: firstLineWith(sourceLines, window, shared) }))
          .find((found) => found.line !== null);
        drafts.push({
          ...quoteLine(ctx, match.statement, hunkId, anchor.symbol.id),
          focus: hit?.line
            ? [
                {
                  startLine: hit.line,
                  endLine: hit.line,
                  note: `Notes mention ${hit.shared}`,
                  optional: true,
                },
              ]
            : [],
          priority: 3,
          order: 4,
          quote: match,
        });
      }
    }
    title = truncateText(`${anchor.name} in ${name}`, LIMITS.maxTitleLength);
    description = `The code of ${anchor.name} in ${name}, with the lines that matter highlighted in turn.`;
  }

  // Keep the most useful lines when there is not room for all of them, in reading order.
  const max = Math.max(1, level.codeLines);
  const kept = (
    drafts.length <= max ? drafts : [...drafts].sort((a, z) => a.priority - z.priority).slice(0, max)
  ).sort((a, z) => a.order - z.order);
  for (const draft of kept) {
    if (draft.quote) {
      b.used.add(draft.quote.statement.full);
      b.quoted = true;
    }
  }
  const clipped = kept.flatMap((draft, index) =>
    draft.focus.flatMap((f) => {
      const startLine = Math.max(window.from, Math.min(f.startLine, f.endLine));
      const endLine = Math.min(window.to, Math.max(f.startLine, f.endLine));
      return startLine <= endLine
        ? [{ startLine, endLine, note: f.note, beat: index, optional: f.optional }]
        : [];
    }),
  );
  const focus = clipped
    .filter(
      (f) =>
        !f.optional ||
        !clipped.some((o) => o !== f && !o.optional && o.startLine <= f.startLine && o.endLine >= f.endLine),
    )
    .map(({ optional: _optional, ...f }) => f);
  const ref: CodeRefInput = { path: file.path, side, startLine: window.from, endLine: window.to };
  return scene(
    'under-the-hood',
    title,
    kept.map((draft) => ({ text: draft.text, evidence: draft.evidence })),
    { type: 'code', ref, mode: window.mode, focus, caption: null },
    description,
    'slide',
  );
}

/** The before and after of the one function a window is about, when it is a modified function that is small enough. */
function singleFunction(window: CodeWindow): BeforeAfter | null {
  const { anchor } = window;
  if (anchor === null || window.inView.length !== 1 || window.inView[0] !== anchor) return null;
  return beforeAfterOf(window.file, anchor);
}

function beforeAfterScene(b: Build, ba: BeforeAfter): Scene {
  const { ctx, level } = b;
  const { file, view } = ba;
  const { symbol, name } = view;
  const word = SYMBOL_WORD[symbol.kind];
  const adds = changedLinesAt(file, 'head').filter((n) => n >= ba.head[0] && n <= ba.head[1]).length;
  const dels = changedLinesAt(file, 'base').filter((n) => n >= ba.base[0] && n <= ba.base[1]).length;
  const baseLength = ba.base[1] - ba.base[0] + 1;
  const headLength = ba.head[1] - ba.head[0] + 1;
  const hunkIds = file.hunks
    .filter((h) => h.newStart <= ba.head[1] && h.newStart + Math.max(h.newLines, 1) - 1 >= ba.head[0])
    .map((h) => h.id);

  // What the two versions call, as far as the changed lines show it.
  const headRange = { from: ba.head[0], to: ba.head[1] };
  const baseRange = { from: ba.base[0], to: ba.base[1] };
  const headLines = sideLines(file, 'head');
  const baseLines = sideLines(file, 'base');
  const own = name.split('.').pop() ?? name;
  const headCalls = new Set(callNames(headLines, headRange, ['add', 'ctx']));
  const baseCalls = new Set(callNames(baseLines, baseRange, ['del', 'ctx']));
  const newCalls = callNames(headLines, headRange, ['add'])
    .filter((call) => !baseCalls.has(call) && call !== own)
    .slice(0, 3);
  const oldCalls = callNames(baseLines, baseRange, ['del'])
    .filter((call) => !headCalls.has(call) && call !== own)
    .slice(0, 3);
  // A call that is a symbol of this change is cited, unless that symbol lives in a file that may not be shown.
  const idsOf = (calls: readonly string[]): string[] =>
    calls.flatMap((call) =>
      ctx.analysis.symbols.filter((s) => s.name === call && symbolName(ctx, s) !== null).map((s) => s.id),
    );

  const lines: Line[] = [
    {
      text:
        oldCalls.length > 0
          ? `Before, the ${word} ${name} called ${naturalList(oldCalls)}.`
          : `Before, the ${word} ${name} was ${plural(baseLength, 'line')} long.`,
      evidence: cite(ctx, ...hunkIds.slice(0, 2), symbol.id, ...idsOf(oldCalls)),
    },
    {
      text:
        newCalls.length > 0
          ? `Now it calls ${naturalList(newCalls)}${oldCalls.length > 0 ? ' instead' : ''}.`
          : `Now it is ${plural(headLength, 'line')} long, with ${sizeText(adds, dels)} in it.`,
      evidence: cite(ctx, ...hunkIds.slice(0, 2), symbol.id, ...idsOf(newCalls)),
    },
  ];
  if (level.codeLines >= 3 && (oldCalls.length > 0 || newCalls.length > 0)) {
    lines.push({
      text:
        baseLength === headLength
          ? `It is still ${plural(headLength, 'line')} long.`
          : `It went from ${baseLength} to ${plural(headLength, 'line')}.`,
      evidence: cite(ctx, ...hunkIds.slice(0, 2), symbol.id),
    });
  }
  const panel = (label: string, side: 'base' | 'head', range: [number, number]) => ({
    label,
    kind: 'code' as const,
    codeRef: { path: file.path, side, startLine: range[0], endLine: range[1] },
    bullets: [],
    terminal: [],
    screenshotId: null,
  });
  return scene(
    'before-after',
    truncateText(`${name} before and after`, LIMITS.maxTitleLength),
    lines,
    {
      type: 'before-after',
      before: panel('Before', 'base', ba.base),
      after: panel('After', 'head', ba.head),
      caption: null,
    },
    `The old and the new version of ${name} side by side.`,
    'slide',
  );
}

export function codeScenes(b: Build): Scene[] {
  const { ctx, level } = b;
  const shown = new Set<string>();
  const scenes: Scene[] = [];
  let beforeAfter = false;
  for (const window of planWindows(ctx, level.codeScenes)) {
    // One small modified function is clearer as two panels than as a window of code.
    const ba = beforeAfter ? null : singleFunction(window);
    if (ba) {
      beforeAfter = true;
      shown.add(window.file.id);
      scenes.push(beforeAfterScene(b, ba));
    } else {
      scenes.push(codeScene(b, window, shown));
    }
  }
  return scenes;
}
