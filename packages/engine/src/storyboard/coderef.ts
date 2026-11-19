/**
 * Resolving code references against the real change: the path must be a changed, visible,
 * text file; the lines must exist; the range is shortened to fit on screen.
 */
import { changedLinesAt, shrinkRange } from '../core/diff-view.ts';
import { isProtectedFile, isShowable } from '../core/path-policy.ts';
import { type CodeRefInput, STORYBOARD_LIMITS } from '../core/storyboard-schema.ts';
import { splitLines } from '../core/text.ts';
import type { ChangedFile, RepoReader, Side } from '../core/types.ts';

export type RefFailure = 'unknown-path' | 'sensitive' | 'binary' | 'unreadable' | 'out-of-range';

export type RefOutcome =
  | {
      ok: true;
      /** The reference after fixes. Its path can be read with the reader at its side. */
      ref: CodeRefInput;
      file: ChangedFile;
      /** All lines of the file at that side. */
      lines: string[];
      /** What was changed, for the fix list. */
      notes: string[];
    }
  | { ok: false; reason: RefFailure; message: string; file: ChangedFile | null };

export interface ResolveOptions {
  /** Keep this line in view when the range has to be shortened (the first focus range). */
  focusCentre?: number | null;
}

export interface RefResolver {
  resolve(ref: CodeRefInput, options?: ResolveOptions): Promise<RefOutcome>;
  /** True when the path is a changed file whose content may be shown. */
  isShowable(path: string): boolean;
}

/** A new file has only a head side and a deleted file only a base side; the note says what was changed. */
function chooseSide(file: ChangedFile, wanted: Side, notes: string[]): Side {
  if (file.status === 'added' && wanted === 'base') {
    notes.push(`${file.path} is a new file, so the side was changed from base to head`);
    return 'head';
  }
  if (file.status === 'deleted' && wanted === 'head') {
    notes.push(`${file.path} was deleted, so the side was changed from head to base`);
    return 'base';
  }
  return wanted;
}

function fail(reason: RefFailure, file: ChangedFile | null, message: string): RefOutcome {
  return { ok: false, reason, file, message };
}

/**
 * Clamp the range to the lines of the file and swap it when it is reversed; null when it lies
 * wholly outside. The notes say what was changed.
 */
function clampRange(ref: CodeRefInput, lineCount: number, notes: string[]): [number, number] | null {
  let start = Math.trunc(ref.startLine);
  let end = Math.trunc(ref.endLine);
  if (start > end) {
    [start, end] = [end, start];
    notes.push('start and end lines were swapped');
  }
  if (end < 1 || start > lineCount) return null;
  const clampedStart = Math.max(start, 1);
  const clampedEnd = Math.min(end, lineCount);
  if (clampedStart !== start || clampedEnd !== end) {
    notes.push(
      `range ${ref.startLine}-${ref.endLine} was clamped to lines ${clampedStart}-${clampedEnd} of ${lineCount}`,
    );
  }
  return [clampedStart, clampedEnd];
}

/** Shorten a range that is longer than the screen holds, around the focus line or the changed lines. */
function shortenRange(
  file: ChangedFile,
  side: Side,
  [start, end]: [number, number],
  focusCentre: number | null | undefined,
  notes: string[],
): [number, number] {
  const max = STORYBOARD_LIMITS.maxCodeLines;
  if (end - start + 1 <= max) return [start, end];
  const centre =
    focusCentre !== undefined && focusCentre !== null && focusCentre >= start && focusCentre <= end
      ? focusCentre
      : null;
  const [shrunkStart, shrunkEnd] = shrinkRange(start, end, max, changedLinesAt(file, side), centre);
  notes.push(
    `range ${start}-${end} is longer than ${max} lines and was shortened to ${shrunkStart}-${shrunkEnd}`,
  );
  return [shrunkStart, shrunkEnd];
}

export function createRefResolver(files: readonly ChangedFile[], reader: RepoReader): RefResolver {
  const byPath = new Map<string, ChangedFile>();
  const byOldPath = new Map<string, ChangedFile>();
  for (const file of files) {
    byPath.set(file.path, file);
    if (file.oldPath) byOldPath.set(file.oldPath, file);
  }
  const reads = new Map<string, Promise<string[] | null>>();

  function read(path: string, side: Side): Promise<string[] | null> {
    const key = `${side}\u0000${path}`;
    let pending = reads.get(key);
    if (!pending) {
      pending = reader
        .readFile(path, side)
        .then((content) => (content === null ? null : splitLines(content)))
        .catch(() => null);
      reads.set(key, pending);
    }
    return pending;
  }

  const lookup = (path: string, side?: Side): ChangedFile | null =>
    byPath.get(path) ?? (side === 'head' ? null : (byOldPath.get(path) ?? null));

  return {
    isShowable(path) {
      const file = lookup(path);
      return file !== null && isShowable(file);
    },
    async resolve(ref, options = {}) {
      const file = lookup(ref.path, ref.side);
      if (!file) {
        return fail(
          'unknown-path',
          null,
          `${ref.path} is not part of this change; use a path from the Files table`,
        );
      }
      if (isProtectedFile(file)) {
        return fail(
          'sensitive',
          file,
          `${ref.path} is a sensitive or excluded file and is never shown; choose another file`,
        );
      }
      if (file.binary) return fail('binary', file, `${ref.path} is a binary file and has no lines to show`);

      const notes: string[] = [];
      const side = chooseSide(file, ref.side, notes);

      // The old version of a renamed or copied file lives at its old path.
      const candidates = side === 'base' && file.oldPath !== null ? [file.oldPath, file.path] : [file.path];
      let usedPath = candidates[0]!;
      let lines: string[] | null = null;
      for (const candidate of candidates) {
        lines = await read(candidate, side);
        if (lines !== null) {
          usedPath = candidate;
          break;
        }
      }
      if (lines === null || lines.length === 0) {
        return fail(
          'unreadable',
          file,
          `${file.path} could not be read at ${side === 'head' ? 'the new' : 'the old'} version`,
        );
      }

      const clamped = clampRange(ref, lines.length, notes);
      if (!clamped) {
        return fail(
          'out-of-range',
          file,
          `lines ${ref.startLine}-${ref.endLine} are outside ${file.path}, which has ${lines.length} lines`,
        );
      }
      const [start, end] = shortenRange(file, side, clamped, options.focusCentre, notes);
      return { ok: true, ref: { path: usedPath, side, startLine: start, endLine: end }, file, lines, notes };
    },
  };
}
