/** The review scene: what the author asks to check and what the analysis flags, with values and places. */

import { changedLinesAt, shrinkRange } from '../core/diff-view.ts';
import { isShowable } from '../core/path-policy.ts';
import { basename } from '../core/posix.ts';
import {
  type CodeRefInput,
  STORYBOARD_LIMITS as LIMITS,
  type ReviewItem,
  type Scene,
} from '../core/storyboard-schema.ts';
import { naturalList, plural } from '../core/text.ts';
import type { CodeRef, RiskSignal } from '../core/types.ts';
import { proseName, sideFor } from './heuristic-code.ts';
import { type Ctx, cite, type Line, safeText } from './heuristic-context.ts';
import {
  affectedNames,
  dependencySentences,
  numericFacts,
  numericSentences,
  reviewHint,
} from './heuristic-facts.ts';
import { type Build, fitWords, scene, sizeText, topFiles } from './heuristic-shared.ts';
import { ordinal, truncateText } from './text.ts';

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<RiskSignal['severity'], number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Among risks of one severity, the ones with values or names to say come first. */
function concreteness(risk: RiskSignal): number {
  return numericFacts(risk).length > 0 || affectedNames(risk).length > 0 ? 0 : 1;
}

/** A reference that the validator will accept: a changed file that can be shown, on a side that exists. */
function safeRef(ctx: Ctx, ref: CodeRef | null): CodeRefInput | null {
  if (!ref) return null;
  const file = ctx.fileByPath.get(ref.path) ?? ctx.changeSet.files.find((f) => f.oldPath === ref.path);
  if (!file || !isShowable(file) || ref.startLine < 1 || ref.endLine < ref.startLine) return null;
  const side = sideFor(file, ref.side);
  const [start, end] = shrinkRange(
    ref.startLine,
    ref.endLine,
    LIMITS.maxCodeLines,
    changedLinesAt(file, side),
    null,
  );
  return { path: file.path, side, startLine: start, endLine: end };
}

function shortDetail(ctx: Ctx, text: string): string {
  const clean = safeText(ctx, text) ?? '';
  // The detail may end with values such as "retries: new value 3", which are lower case after the full stop.
  const first = clean.length <= 160 ? clean : (clean.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)[0] ?? clean);
  return truncateText(first, 160);
}

/** Where a risk sits, as a name that may be said: the symbol it was found in, or else the file. */
function placeOf(ctx: Ctx, risk: RiskSignal, ref: CodeRefInput | null): string | null {
  for (const id of risk.evidence) {
    const symbol = ctx.analysis.symbols.find((s) => s.id === id);
    const name = symbol ? safeText(ctx, symbol.name) : null;
    const file = symbol ? ctx.fileById.get(symbol.fileId) : undefined;
    if (symbol && name && file && isShowable(file)) return proseName(symbol.kind, name);
  }
  return ref ? basename(ref.path) : null;
}

export interface Review {
  scene: Scene;
  items: ReviewItem[];
  firstSubject: string | null;
  firstEvidence: string[];
}

function riskSentence(ctx: Ctx, risk: RiskSignal, item: ReviewItem, index: number): string {
  const affected = affectedNames(risk)
    .map((name) => safeText(ctx, name))
    .filter((name): name is string => name !== null);
  const values = numericFacts(risk);
  const found = affected.length > 0 ? null : placeOf(ctx, risk, item.ref);
  // "in TOKEN_TTL_SECONDS" adds nothing when the next sentence says what TOKEN_TTL_SECONDS is set to.
  const place = found !== null && values.some((fact) => fact.name === found) ? null : found;
  const rated = risk.severity === 'high' || risk.severity === 'medium';
  const facts = numericSentences(values, null);
  const extras = [
    ...(affected.length > 0 ? [`It affects ${naturalList(affected.slice(0, 3))}.`] : []),
    ...facts,
    ...dependencySentences(risk, (name) => safeText(ctx, name)),
  ];
  const head = `${ordinal(index)}: ${item.title}${place ? `, in ${place}` : ''}.${rated ? ` The analysis rates it ${risk.severity}.` : ''}`;
  // Every line stays within the limit for a caption: the values and names that do not fit are left out.
  return fitWords([head, ...extras], LIMITS.maxWordsPerNarrationLine);
}

export function reviewScene(b: Build): Review | null {
  const { ctx, level } = b;
  const hint = level.quotes ? reviewHint(ctx) : null;
  const risks = [...ctx.analysis.risks]
    .sort(
      (a, z) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[z.severity] ||
        concreteness(a) - concreteness(z) ||
        a.id.localeCompare(z.id),
    )
    .slice(0, Math.min(level.reviewItems - (hint ? 1 : 0), LIMITS.maxChecklistItems));

  if (risks.length > 0 || hint) {
    const items: ReviewItem[] = [];
    const lines: Line[] = [];
    // The line that names each item: the checklist shows an item when its line is spoken.
    const beats: number[] = [];
    const riskItems: ReviewItem[] = risks.map((risk) => ({
      title: truncateText(safeText(ctx, risk.title) ?? `Check the ${risk.category} signal`, 80),
      detail: shortDetail(ctx, risk.detail),
      severity: risk.severity,
      ref: safeRef(ctx, risk.ref),
      evidence: cite(ctx, risk.id, ...risk.evidence.slice(0, 2)),
    }));

    if (risks.length > 0) {
      const counts = (['high', 'medium', 'low', 'info'] as const)
        .map((severity) => [severity, risks.filter((risk) => risk.severity === severity).length] as const)
        .filter(([, count]) => count > 0)
        .map(([severity, count]) => `${count} ${severity}`);
      const total = ctx.analysis.risks.length;
      lines.push({
        text: `The analysis found ${plural(total, 'review signal')}${total === risks.length && total > 1 ? `: ${naturalList(counts)}` : ''}.`,
        evidence: cite(ctx, ...risks.slice(0, 3).map((risk) => risk.id)),
      });
    }
    if (hint) {
      b.quoted = true;
      items.push({
        title: hint.title,
        detail: hint.detail,
        severity: 'medium',
        ref: null,
        evidence: cite(ctx, hint.source),
      });
      beats.push(lines.length);
      lines.push({
        text: `${hint.stripped ? 'The notes flag this for review' : 'The notes say'}: ${hint.spoken}`,
        evidence: cite(ctx, hint.source),
      });
    }
    items.push(...riskItems);
    risks.forEach((risk, index) => {
      const item = riskItems[index]!;
      beats.push(lines.length);
      lines.push({ text: riskSentence(ctx, risk, item, index), evidence: item.evidence });
    });
    const visualItems = items.map((item, index) => ({ ...item, beat: beats[index] ?? 0 }));
    return {
      scene: scene(
        'review',
        'What to review',
        lines,
        { type: 'checklist', items: visualItems },
        'A checklist of the points to review, with the author notes and the signals the analysis flags.',
        'fade',
      ),
      items,
      firstSubject: items[0]!.title,
      firstEvidence: items[0]!.evidence,
    };
  }

  const files = topFiles(ctx, Math.min(level.reviewItems, 3));
  if (files.length === 0) return null;
  const items: ReviewItem[] = files.map((file) => {
    const hunk = ctx.analysis.keyHunks.find((k) => k.fileId === file.id);
    return {
      title: `Largest change: ${basename(file.path)}`,
      detail:
        sizeText(file.additions, file.deletions) === 'no changed lines'
          ? 'The file was renamed or moved.'
          : `${sizeText(file.additions, file.deletions)}.`,
      severity: 'info' as const,
      ref: hunk
        ? safeRef(ctx, { path: file.path, side: hunk.side, startLine: hunk.startLine, endLine: hunk.endLine })
        : null,
      evidence: cite(ctx, file.id, hunk?.id),
    };
  });
  const names = files.map((file) => basename(file.path));
  const lines: Line[] = [
    {
      text: `The largest changes are in ${naturalList(names)}.`,
      evidence: cite(ctx, ...files.map((f) => f.id)),
    },
  ];
  return {
    scene: scene(
      'review',
      'What to review',
      lines,
      { type: 'checklist', items: items.map((item) => ({ ...item, beat: 0 })) },
      'A checklist of the largest changes to read first.',
      'fade',
    ),
    items,
    firstSubject: names[0] ?? null,
    firstEvidence: items[0]!.evidence,
  };
}
