/**
 * Shared state and text-safety helpers for the offline storyboard. Text that comes from outside
 * the code (PR title, description, task, notes) is masked, checked for claims and web addresses,
 * and only ever quoted.
 */
import type { Config } from '../core/config.ts';
import { isProtectedFile, isShowable } from '../core/path-policy.ts';
import { maskPrivate } from '../core/secrets.ts';
import { countWords, stripInvisible } from '../core/text.ts';
import type {
  Analysis,
  ChangedFile,
  ChangeSet,
  Component,
  ContextInputs,
  FileInsight,
  SymbolChange,
} from '../core/types.ts';
import { findClaim } from './claims.ts';
import { escapeRegExp, firstMeaningfulSentence, splitSentences } from './text.ts';
import { codeTextOf, foreignUrls } from './urls.ts';

export interface Ctx {
  changeSet: ChangeSet;
  analysis: Analysis;
  inputs: ContextInputs;
  config: Config;
  evidence: Set<string>;
  fileById: Map<string, ChangedFile>;
  fileByPath: Map<string, ChangedFile>;
  insightByFile: Map<string, FileInsight>;
  componentById: Map<string, Component>;
  symbolsByFile: Map<string, SymbolChange[]>;
  /** Matches the path or the file name of a file that may not be shown, wherever author text names it. */
  hiddenNames: RegExp[];
  /** Lower-case code and paths of the visible files: bare names found here are not web addresses. */
  codeText: string;
}

/** One narration line with the evidence it cites. */
export interface Line {
  text: string;
  evidence: string[];
}

export function createCtx(
  changeSet: ChangeSet,
  analysis: Analysis,
  inputs: ContextInputs,
  config: Config,
): Ctx {
  const fileByPath = new Map<string, ChangedFile>();
  for (const file of changeSet.files) fileByPath.set(file.path, file);
  const symbolsByFile = new Map<string, SymbolChange[]>();
  for (const symbol of analysis.symbols) {
    const list = symbolsByFile.get(symbol.fileId) ?? [];
    list.push(symbol);
    symbolsByFile.set(symbol.fileId, list);
  }
  const hiddenNames: RegExp[] = [];
  for (const file of changeSet.files) {
    if (!isProtectedFile(file)) continue;
    for (const path of [file.path, file.oldPath]) {
      if (!path) continue;
      const name = path.split('/').pop() ?? path;
      for (const text of new Set([path, /[.]/.test(name) ? name : ''])) {
        if (text) hiddenNames.push(new RegExp(`(?<![\\w./-])${escapeRegExp(text)}(?![\\w-])`));
      }
    }
  }
  return {
    changeSet,
    analysis,
    inputs,
    config,
    hiddenNames,
    codeText: codeTextOf(
      changeSet.files,
      analysis.symbols.map((symbol) => symbol.name),
    ),
    evidence: new Set(analysis.evidence.map((item) => item.id)),
    fileById: new Map(changeSet.files.map((file) => [file.id, file])),
    fileByPath,
    insightByFile: new Map(analysis.files.map((insight) => [insight.fileId, insight])),
    componentById: new Map(analysis.components.map((component) => [component.id, component])),
    symbolsByFile,
  };
}

// ---------------------------------------------------------------------------
// Text that comes from outside
// ---------------------------------------------------------------------------

export function maskText(ctx: Ctx, text: string): string {
  return maskPrivate(stripInvisible(text), { maskEmails: ctx.config.privacy.maskEmails });
}

/**
 * The text, masked, or null when it contains a claim that the change cannot prove, a web address, or
 * the name of a file that may not be shown.
 */
export function safeText(ctx: Ctx, raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = maskText(ctx, raw.replace(/\s+/g, ' ').trim());
  if (!text) return null;
  if (foreignUrls(text, new Set(), ctx.codeText).length > 0) return null;
  if (ctx.hiddenNames.some((name) => name.test(text))) return null;
  return splitSentences(text).every((sentence) => findClaim(sentence) === null) ? text : null;
}

/** The first meaningful sentence of a description, if it is short and makes no unprovable claim. */
export function safeSentence(ctx: Ctx, raw: string | null | undefined, maxWords = 28): string | null {
  if (!raw) return null;
  const sentence = firstMeaningfulSentence(raw);
  const text = sentence ? safeText(ctx, sentence) : null;
  return text && countWords(text) <= maxWords ? text : null;
}

/** Ids that exist in the evidence index. Falls back to something that always exists, so a line never goes uncited. */
export function cite(ctx: Ctx, ...ids: (string | null | undefined)[]): string[] {
  const valid = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && ctx.evidence.has(id))),
  ];
  if (valid.length > 0) return valid;
  for (const fallback of ['PR', 'TASK', 'REPO', ctx.changeSet.files[0]?.id]) {
    if (fallback && ctx.evidence.has(fallback)) return [fallback];
  }
  return [];
}

// ---------------------------------------------------------------------------
// What the change contains
// ---------------------------------------------------------------------------

export function isTrivial(ctx: Ctx, file: ChangedFile): boolean {
  return ctx.insightByFile.get(file.id)?.trivial ?? false;
}

/** A symbol that may be named in the video: its file can be shown and its name is safe to say. */
export function symbolName(ctx: Ctx, symbol: SymbolChange): string | null {
  const file = ctx.fileById.get(symbol.fileId);
  if (!file || !isShowable(file)) return null;
  return safeText(ctx, symbol.name);
}
