/** Trivial-change detection: changes that are not worth explaining in a video. */

import type { ChangedFile, DiffHunk, FileRole } from '../core/types.ts';
import { languageSupport } from './languages/index.ts';

export interface TrivialVerdict {
  trivial: boolean;
  reason: string | null;
  /** Every changed line is a comment. Not trivial, but low importance. */
  commentOnly: boolean;
}

function commentStyle(path: string): readonly string[] | null {
  return languageSupport(path)?.comments ?? null;
}

function changedSides(hunk: DiffHunk): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === 'del') removed.push(line.text);
    else if (line.kind === 'add') added.push(line.text);
  }
  return { removed, added };
}

/**
 * Where the string literal that opens at `start` ends, or the place where the scan gave up as a
 * negative number. A quote must close on its own line; a backtick may run over lines.
 */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let at = start + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === quote) return at + 1;
    if (char === '\\') {
      if (at + 1 >= text.length || /[\n\r\u2028\u2029]/.test(text[at + 1]!)) break;
      at += 2;
    } else if (char === '\n' && quote !== '`') break;
    else at += 1;
  }
  return -at;
}

/**
 * Swaps each string literal for what `replace` returns. Scans by hand to stay linear: when a quote
 * finds no end, no later quote of that kind before the same place finds one either, so they are skipped.
 */
function replaceStrings(text: string, replace: (literal: string) => string): string {
  const openUntil: Record<string, number> = { "'": 0, '"': 0, '`': 0 };
  let out = '';
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    const end = char in openUntil && at >= openUntil[char]! ? stringEnd(text, at) : 0;
    if (end > 0) {
      out += replace(text.slice(at, end));
      at = end;
      continue;
    }
    if (end < 0) openUntil[char] = -end;
    out += char;
    at += 1;
  }
  return out;
}

/** Runs `edit` on the text with each string literal swapped for a marker, so the edit never touches a string. */
function outsideStrings(text: string, edit: (code: string) => string, unifyQuotes = false): string {
  const strings: string[] = [];
  const masked = replaceStrings(text, (literal) => {
    strings.push(unifyQuotes && literal.startsWith('"') ? `'${literal.slice(1, -1)}'` : literal);
    return `\0${strings.length - 1}\0`;
  });
  return edit(masked).replace(/\0(\d+)\0/g, (_, i: string) => strings[Number(i)] as string);
}

function stripWhitespace(text: string): string {
  return outsideStrings(text, (code) => code.replace(/\s+/g, ''));
}

/**
 * Normalise one side line by line: each run of whitespace outside strings becomes one space and
 * empty lines go. Line breaks stay, so a space or a newline that changes a command still shows.
 * Indentation is kept for indent-sensitive files.
 */
function collapseLines(lines: string[], indentSensitive: boolean): string[] {
  return lines
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const lead = indentSensitive ? (/^\s*/.exec(l)?.[0] ?? '') : '';
      return lead + outsideStrings(l.trim(), (code) => code.replace(/\s+/g, ' '));
    });
}

/** `joined` is true for the JavaScript family, where a re-wrapped line must stay trivial. */
function whitespaceOnlyHunk(hunk: DiffHunk, indentSensitive: boolean, joined: boolean): boolean {
  const { removed, added } = changedSides(hunk);
  if (removed.length === 0 && added.length === 0) return false;
  if (joined) return stripWhitespace(removed.join('\n')) === stripWhitespace(added.join('\n'));
  const a = collapseLines(removed, indentSensitive);
  const b = collapseLines(added, indentSensitive);
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function normaliseFormatting(lines: string[]): string {
  const text = lines.map((l) => l.replace(/,\s*$/, '')).join('\n');
  return outsideStrings(
    text,
    (code) =>
      code
        .replace(/;/g, '')
        .replace(/,(\s*[)\]}])/g, '$1')
        .replace(/\s+/g, '')
        .replace(/\((\w+)\)=>/g, '$1=>'),
    true,
  );
}

/** Only used for languages where quotes, semicolons and trailing commas carry no meaning. */
function formattingOnlyHunk(hunk: DiffHunk): boolean {
  const { removed, added } = changedSides(hunk);
  if (removed.length === 0 || added.length === 0) return false;
  return normaliseFormatting(removed) === normaliseFormatting(added);
}

function isCommentLine(text: string, prefixes: readonly string[]): boolean {
  const t = text.trim();
  return prefixes.some((p) => t.startsWith(p));
}

/** True when the line, taken alone, is a comment in the language of `path`. Unknown languages: false. */
export function isCommentText(path: string, text: string): boolean {
  const prefixes = commentStyle(path);
  return prefixes !== null && isCommentLine(text, prefixes);
}

function commentOnlyFile(file: ChangedFile): boolean {
  const prefixes = commentStyle(file.path);
  if (!prefixes || file.hunks.length === 0) return false;
  let seen = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'ctx' || line.text.trim() === '') continue;
      if (!isCommentLine(line.text, prefixes)) return false;
      seen++;
    }
  }
  return seen > 0;
}

/** True when every changed line of the hunk is a comment. Used to damp the hunk's score. */
export function commentOnlyHunk(path: string, hunk: DiffHunk): boolean {
  const prefixes = commentStyle(path);
  if (!prefixes) return false;
  let seen = 0;
  for (const line of hunk.lines) {
    if (line.kind === 'ctx' || line.text.trim() === '') continue;
    if (!isCommentLine(line.text, prefixes)) return false;
    seen++;
  }
  return seen > 0;
}

export function classifyTrivial(file: ChangedFile, role: FileRole): TrivialVerdict {
  const none = { trivial: false, reason: null, commentOnly: false };
  if (role === 'lockfile') return { trivial: true, reason: 'lockfile', commentOnly: false };
  if (role === 'generated') return { trivial: true, reason: 'generated file', commentOnly: false };
  if (file.status === 'renamed' && file.additions === 0 && file.deletions === 0) {
    return { trivial: true, reason: 'pure rename (no line changes)', commentOnly: false };
  }
  if (file.binary || file.patchTruncated || file.hunks.length === 0) return none;

  const support = languageSupport(file.path);
  const indentSensitive = support?.indentSensitive ?? false;
  const joined = support?.looseSyntax ?? false;
  const hunks = file.hunks;
  if (hunks.every((h) => whitespaceOnlyHunk(h, indentSensitive, joined))) {
    return { trivial: true, reason: 'whitespace-only change', commentOnly: false };
  }
  if (
    support?.looseSyntax &&
    hunks.every((h) => whitespaceOnlyHunk(h, indentSensitive, joined) || formattingOnlyHunk(h))
  ) {
    return {
      trivial: true,
      reason: 'formatting-only change (whitespace, quotes, semicolons or trailing commas)',
      commentOnly: false,
    };
  }
  return { trivial: false, reason: null, commentOnly: commentOnlyFile(file) };
}
