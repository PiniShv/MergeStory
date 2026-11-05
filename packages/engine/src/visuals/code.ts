/**
 * Code resolution: reads the real lines a code reference points at, so a video never shows code
 * that is not in the change. Secrets are masked before highlighting, protected files are never shown.
 */
import type { Config } from '../core/config.ts';
import { diffViewSpan, hunksInView, sideNumber } from '../core/diff-view.ts';
import { MergeStoryError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import { isProtectedFile } from '../core/path-policy.ts';
import { safeRepoPath } from '../core/paths.ts';
import type { CodeLine, CodeToken, ResolvedCode } from '../core/render-plan.ts';
import { findSecrets, MASK_CHAR } from '../core/secrets.ts';
import { STORYBOARD_LIMITS } from '../core/storyboard-schema.ts';
import type { ChangedFile, ChangeSet, CodeRef, DiffHunk, DiffLine, RepoReader, Side } from '../core/types.ts';
import { highlightText, plainTokens, resolveLanguage } from './highlight.ts';

/** Lines longer than this are cut with an ellipsis, so one minified line cannot flood the page. */
export const MAX_LINE_CHARS = 240;

/** Files up to this many lines are highlighted whole; longer files only up to the lines that are shown. */
const FULL_FILE_LINES = 6000;

const MASK_TEXT = MASK_CHAR.repeat(8);

/** A range of lines at the side of a code reference (1-based, inclusive). */
export interface FocusRange {
  startLine: number;
  endLine: number;
}

export interface CodeResolverDeps {
  reader: RepoReader;
  changeSet: ChangeSet;
  config: Pick<Config, 'theme'>;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Line preparation
// ---------------------------------------------------------------------------

/** Tabs become two spaces and trailing whitespace is dropped, so every line renders the same way. */
export function normalizeLine(line: string): string {
  return line.replace(/\t/g, '  ').trimEnd();
}

/** Split file content into normalised lines. A final newline does not create an extra line. */
export function splitCodeLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(normalizeLine);
}

export interface MaskedLines {
  lines: string[];
  /** true for every line that had a secret masked. */
  flags: boolean[];
  /** Number of secrets found. */
  count: number;
}

/**
 * Mask secrets in a block of lines without changing the number of lines. The whole block is scanned
 * at once, so a secret that spans lines (such as a private key) is masked on every line it touches.
 */
export function maskLines(lines: readonly string[]): MaskedLines {
  const text = lines.join('\n');
  const found = findSecrets(text);
  if (found.length === 0) return { lines: [...lines], flags: lines.map(() => false), count: 0 };

  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const ranges: Array<Array<[number, number]>> = lines.map(() => []);
  for (const match of found) {
    let index = starts.findLastIndex((start) => start <= match.start);
    if (index < 0) index = 0;
    let position = match.start;
    while (position < match.end && index < lines.length) {
      const lineStart = starts[index]!;
      const lineEnd = lineStart + lines[index]!.length;
      const segmentEnd = Math.min(match.end, lineEnd);
      if (segmentEnd > position) ranges[index]!.push([position - lineStart, segmentEnd - lineStart]);
      position = lineEnd + 1;
      index++;
    }
  }
  const flags = ranges.map((r) => r.length > 0);
  const masked = lines.map((line, i) => {
    const parts = ranges[i]!;
    if (parts.length === 0) return line;
    parts.sort((a, b) => a[0] - b[0]);
    let out = '';
    let cursor = 0;
    for (const [from, to] of parts) {
      if (to <= cursor) continue;
      out += line.slice(cursor, Math.max(from, cursor)) + MASK_TEXT;
      cursor = to;
    }
    return out + line.slice(cursor);
  });
  return { lines: masked, flags, count: found.length };
}

function clipTokens(tokens: CodeToken[]): { tokens: CodeToken[]; clipped: boolean } {
  let used = 0;
  const out: CodeToken[] = [];
  for (const token of tokens) {
    const room = MAX_LINE_CHARS - used;
    if (room <= 0) return { tokens: [...out, { t: '…', c: null, s: 0 }], clipped: true };
    if (token.t.length <= room) {
      out.push(token);
      used += token.t.length;
      continue;
    }
    let cut = room;
    const code = token.t.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--; // do not split a surrogate pair
    out.push({ ...token, t: token.t.slice(0, cut) }, { t: '…', c: null, s: 0 });
    return { tokens: out, clipped: true };
  }
  return { tokens: out, clipped: false };
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/** Choose at most `max` rows around the focus (or around `anchor` when there is no focus). */
function pickWindow(
  count: number,
  max: number,
  focus: { first: number; last: number } | null,
  anchor: number,
): { start: number; end: number } {
  if (count <= max) return { start: 0, end: count };
  let start = anchor;
  if (focus) {
    const span = focus.last - focus.first + 1;
    start = span >= max ? focus.first : Math.round((focus.first + focus.last) / 2 - (max - 1) / 2);
  }
  start = Math.max(0, Math.min(start, count - max));
  return { start, end: start + max };
}

interface Row {
  kind: CodeLine['kind'];
  oldNumber: number | null;
  newNumber: number | null;
  /** Number at the side of the reference, used to match focus ranges. */
  number: number | null;
  text: string;
  tokens: CodeToken[];
  masked: boolean;
}

interface Prepared {
  masked: MaskedLines;
  tokens: CodeToken[][];
}

/** Resolves code references for one run. Files are read, masked and highlighted once and reused. */
export class CodeResolver {
  private readonly deps: CodeResolverDeps;
  private readonly fileLines = new Map<string, Promise<string[] | null>>();
  private readonly prepared = new Map<string, Promise<Prepared>>();

  constructor(deps: CodeResolverDeps) {
    this.deps = deps;
  }

  /**
   * Resolve a reference into displayable lines.
   * - snippet: the lines startLine..endLine at the reference's side.
   * - diff: the diff lines of the hunks that overlap the range, with old and new numbers.
   * At most STORYBOARD_LIMITS.maxCodeLines lines are returned, positioned around the first focus range.
   */
  async resolve(
    ref: CodeRef,
    mode: 'snippet' | 'diff',
    focus: readonly FocusRange[] = [],
  ): Promise<ResolvedCode> {
    const path = safeRepoPath(ref.path);
    if (path === null) {
      throw new MergeStoryError('STORYBOARD_INVALID', `A code reference has an unsafe path: ${ref.path}`, {
        hint: 'Code references must use repository-relative paths.',
      });
    }
    const side: Side = ref.side === 'base' ? 'base' : 'head';
    const file = this.findFile(path);
    if (file === null) {
      throw new MergeStoryError(
        'STORYBOARD_INVALID',
        `A code reference points at ${path}, which is not part of the change.`,
        {
          hint: 'The storyboard cites a file that the change does not touch. Validate it against this change.',
        },
      );
    }
    if (isProtectedFile(file)) {
      this.deps.logger?.warn('A code reference points at a protected file; its content is not shown.', {
        path,
      });
      return protectedCode(path, side);
    }
    const startLine = Math.max(1, Math.floor(ref.startLine));
    const endLine = Math.max(startLine, Math.floor(ref.endLine));
    const language = resolveLanguage(file.language) ?? 'text';

    let rows: Row[] | null = null;
    let truncated = false;
    if (mode === 'diff' && file.hunks.length > 0) {
      const result = await this.diffRows(file, side, startLine, endLine, language, focus);
      if (result) ({ rows, truncated } = result);
    }
    if (rows === null) {
      if (mode === 'diff') {
        this.deps.logger?.debug('No diff hunk overlaps a code reference; showing it as a snippet.', { path });
      }
      ({ rows, truncated } = await this.snippetRows(file, path, side, startLine, endLine, language, focus));
    }
    const lines: CodeLine[] = [];
    let clipped = false;
    for (const row of rows) {
      const result = clipTokens(row.tokens);
      clipped ||= result.clipped;
      lines.push({
        kind: row.kind,
        oldNumber: row.oldNumber,
        newNumber: row.newNumber,
        tokens: result.tokens,
      });
    }
    return {
      path,
      language,
      side,
      lines,
      masked: rows.some((row) => row.masked),
      truncated: truncated || clipped,
    };
  }

  // -------------------------------------------------------------------------

  private findFile(path: string): ChangedFile | null {
    return this.deps.changeSet.files.find((f) => f.path === path || f.oldPath === path) ?? null;
  }

  private sidePath(file: ChangedFile, side: Side): string {
    return side === 'head' ? file.path : (file.oldPath ?? file.path);
  }

  private async readSide(sidePath: string, side: Side): Promise<string[] | null> {
    const key = `${side}:${sidePath}`;
    let pending = this.fileLines.get(key);
    if (!pending) {
      pending = this.deps.reader.readFile(sidePath, side).then(
        (content) => (content === null ? null : splitCodeLines(content)),
        (err: unknown) => {
          this.deps.logger?.debug('A file could not be read for a code reference.', {
            side,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        },
      );
      this.fileLines.set(key, pending);
    }
    return pending;
  }

  /** Mask and highlight the first `limit` lines of a normalised file (cached). */
  private prepareFile(key: string, lines: string[], language: string, neededUpTo: number): Promise<Prepared> {
    const limit = lines.length <= FULL_FILE_LINES ? lines.length : Math.min(lines.length, neededUpTo + 50);
    const cacheKey = `${key}:${limit}`;
    let pending = this.prepared.get(cacheKey);
    if (!pending) {
      pending = this.prepareLines(lines.slice(0, limit), language);
      this.prepared.set(cacheKey, pending);
    }
    return pending;
  }

  private async prepareLines(lines: string[], language: string): Promise<Prepared> {
    const masked = maskLines(lines);
    const tokens = await highlightText(masked.lines.join('\n'), {
      language,
      theme: this.deps.config.theme,
      logger: this.deps.logger,
    });
    return { masked, tokens };
  }

  private async snippetRows(
    file: ChangedFile,
    path: string,
    side: Side,
    startLine: number,
    endLine: number,
    language: string,
    focus: readonly FocusRange[],
  ): Promise<{ rows: Row[]; truncated: boolean }> {
    const sidePath = this.sidePath(file, side);
    const content = await this.readSide(sidePath, side);
    let all: Row[] = [];
    if (content && startLine <= content.length) {
      const last = Math.min(endLine, content.length);
      const prepared = await this.prepareFile(`${side}:${sidePath}`, content, language, last);
      for (let n = startLine; n <= last; n++) {
        all.push(
          this.snippetRow(
            side,
            n,
            prepared.masked.lines[n - 1] ?? '',
            prepared.tokens[n - 1],
            prepared.masked.flags[n - 1],
          ),
        );
      }
    } else {
      all = await this.snippetRowsFromHunks(file, side, startLine, endLine, language);
    }
    if (all.length === 0) {
      throw new MergeStoryError(
        'STORYBOARD_INVALID',
        `Lines ${startLine}-${endLine} of ${path} (${side}) are not available.`,
        {
          hint: 'The storyboard cites lines that do not exist in the change. Validate it against this change.',
        },
      );
    }
    return this.limitRows(all, focus);
  }

  private snippetRow(
    side: Side,
    n: number,
    text: string,
    tokens: CodeToken[] | undefined,
    masked: boolean | undefined,
  ): Row {
    return {
      kind: 'ctx',
      oldNumber: side === 'base' ? n : null,
      newNumber: side === 'head' ? n : null,
      number: n,
      text,
      tokens: tokens ?? plainTokens(text)[0] ?? [],
      masked: masked ?? false,
    };
  }

  /** Last resort when the file cannot be read: use the lines the diff itself carries. */
  private async snippetRowsFromHunks(
    file: ChangedFile,
    side: Side,
    startLine: number,
    endLine: number,
    language: string,
  ): Promise<Row[]> {
    const rows: Row[] = [];
    for (const hunk of file.hunks) {
      const own = hunk.lines.filter((l) => sideNumber(l, side) !== null);
      if (!own.some((l) => sideNumber(l, side)! >= startLine && sideNumber(l, side)! <= endLine)) continue;
      const prepared = await this.prepareLines(
        own.map((l) => normalizeLine(l.text)),
        language,
      );
      own.forEach((line, i) => {
        const n = sideNumber(line, side)!;
        if (n < startLine || n > endLine) return;
        rows.push(
          this.snippetRow(
            side,
            n,
            prepared.masked.lines[i] ?? '',
            prepared.tokens[i],
            prepared.masked.flags[i],
          ),
        );
      });
    }
    return rows;
  }

  private limitRows(rows: Row[], focus: readonly FocusRange[]): { rows: Row[]; truncated: boolean } {
    const max = STORYBOARD_LIMITS.maxCodeLines;
    if (rows.length <= max) return { rows, truncated: false };
    let focusSpan: { first: number; last: number } | null = null;
    for (const range of focus) {
      const first = rows.findIndex(
        (r) => r.number !== null && r.number >= range.startLine && r.number <= range.endLine,
      );
      if (first < 0) continue;
      const last = rows.findLastIndex(
        (r) => r.number !== null && r.number >= range.startLine && r.number <= range.endLine,
      );
      focusSpan = { first, last };
      break;
    }
    const firstChange = rows.findIndex((r) => r.kind !== 'ctx');
    const anchor = firstChange > 0 ? firstChange - 2 : 0;
    const { start, end } = pickWindow(rows.length, max, focusSpan, anchor);
    return { rows: rows.slice(start, end), truncated: true };
  }

  private async diffRows(
    file: ChangedFile,
    side: Side,
    startLine: number,
    endLine: number,
    language: string,
    focus: readonly FocusRange[],
  ): Promise<{ rows: Row[]; truncated: boolean } | null> {
    const span = diffViewSpan(file, side, startLine, endLine);
    if (span === null) return null;
    const hunks = hunksInView(file, side, startLine, endLine);

    const head = span.some((l) => l.kind !== 'del')
      ? await this.diffSource(file, hunks, 'head', language)
      : null;
    const base = span.some((l) => l.kind === 'del')
      ? await this.diffSource(file, hunks, 'base', language)
      : null;

    const rows: Row[] = span.map((line) => {
      const source = line.kind === 'del' ? base : head;
      const found = source?.lookup(line);
      return {
        kind: line.kind,
        oldNumber: line.oldLine,
        newNumber: line.newLine,
        number: sideNumber(line, side),
        text: found?.text ?? normalizeLine(line.text),
        tokens: found?.tokens ?? plainTokens(normalizeLine(line.text))[0] ?? [],
        masked: found?.masked ?? false,
      };
    });
    return this.limitRows(rows, focus);
  }

  /**
   * Tokens for the lines of one side of a diff. Prefers the whole file (correct grammar state) and
   * falls back to the text of the overlapping hunks when the file cannot be read or does not match.
   */
  private async diffSource(
    file: ChangedFile,
    hunks: DiffHunk[],
    side: Side,
    language: string,
  ): Promise<{ lookup(line: DiffLine): { text: string; tokens: CodeToken[]; masked: boolean } | undefined }> {
    const ownLines = hunks.flatMap((h) =>
      h.lines.filter((l) => (side === 'head' ? l.kind !== 'del' : l.kind !== 'add')),
    );
    const wholeFileAvailable =
      !(side === 'head' && file.status === 'deleted') && !(side === 'base' && file.status === 'added');
    if (wholeFileAvailable) {
      const sidePath = this.sidePath(file, side);
      const content = await this.readSide(sidePath, side);
      if (content && ownLines.every((l) => normalizeLine(l.text) === content[sideNumber(l, side)! - 1])) {
        const needed = Math.max(...ownLines.map((l) => sideNumber(l, side) ?? 0), 1);
        const prepared = await this.prepareFile(`${side}:${sidePath}`, content, language, needed);
        return {
          lookup: (line) => {
            const index = (sideNumber(line, side) ?? 0) - 1;
            const text = prepared.masked.lines[index];
            if (text === undefined) return undefined;
            return {
              text,
              tokens: prepared.tokens[index] ?? plainTokens(text)[0] ?? [],
              masked: prepared.masked.flags[index] ?? false,
            };
          },
        };
      }
    }
    const prepared = await this.prepareLines(
      ownLines.map((l) => normalizeLine(l.text)),
      language,
    );
    const index = new Map<DiffLine, number>();
    for (const [i, line] of ownLines.entries()) index.set(line, i);
    return {
      lookup: (line) => {
        const i = index.get(line);
        if (i === undefined) return undefined;
        const text = prepared.masked.lines[i] ?? '';
        return {
          text,
          tokens: prepared.tokens[i] ?? plainTokens(text)[0] ?? [],
          masked: prepared.masked.flags[i] ?? false,
        };
      },
    };
  }
}

/** Shown instead of code for protected files: the content is never read. */
function protectedCode(path: string, side: Side): ResolvedCode {
  return {
    path,
    language: 'text',
    side,
    lines: [
      {
        kind: 'ctx',
        oldNumber: null,
        newNumber: null,
        tokens: [{ t: 'Protected file: its contents are never shown.', c: null, s: 1 }],
      },
    ],
    masked: true,
    truncated: false,
  };
}
