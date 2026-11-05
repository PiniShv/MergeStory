/** Deciding which files of a large change keep their code hunks. */
import type { SourceLimits } from './limits.ts';

export interface HunkCandidate {
  /** Position of the file in the change set. */
  index: number;
  /** Added plus deleted lines. */
  changedLines: number;
}

export interface HunkSelection {
  /** Files that keep their hunks, in file order. */
  selected: number[];
  /** Files with more changed lines than one file may have. */
  tooLarge: Set<number>;
  /** Files left out because the file count or the line budget was used up. */
  overCap: Set<number>;
}

/**
 * Pick the files whose hunks are kept: the ones with the most changed lines first, up to
 * `maxHunkFiles` files and `maxTotalPatchLines` lines in all. A file that does not fit the
 * remaining line budget is skipped, so smaller files after it can still be kept. Callers pass
 * only files that have hunks to give (text, not protected, with changed lines).
 */
export function selectHunkFiles(
  candidates: readonly HunkCandidate[],
  limits: Pick<SourceLimits, 'maxHunkFiles' | 'maxFilePatchLines' | 'maxTotalPatchLines'>,
): HunkSelection {
  const tooLarge = new Set<number>();
  const overCap = new Set<number>();
  const selected: number[] = [];
  let lines = 0;

  const eligible: HunkCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.changedLines > limits.maxFilePatchLines) tooLarge.add(candidate.index);
    else eligible.push(candidate);
  }
  eligible.sort((a, b) => b.changedLines - a.changedLines || a.index - b.index);
  for (const candidate of eligible) {
    if (
      selected.length < limits.maxHunkFiles &&
      lines + candidate.changedLines <= limits.maxTotalPatchLines
    ) {
      selected.push(candidate.index);
      lines += candidate.changedLines;
    } else {
      overCap.add(candidate.index);
    }
  }
  selected.sort((a, b) => a - b);
  return { selected, tooLarge, overCap };
}

/** A sentence for `ChangeSet.limits.note` about files that lost their hunks, or null. */
export function hunkLimitNote(
  totalFiles: number,
  selection: HunkSelection,
  limits: SourceLimits,
): string | null {
  const parts: string[] = [];
  if (selection.overCap.size > 0) {
    parts.push(
      `Code is included for ${selection.selected.length} of ${totalFiles} changed files (the largest changes first, ` +
        `at most ${limits.maxHunkFiles} files); the others keep their path and line counts only.`,
    );
  }
  if (selection.tooLarge.size > 0) {
    parts.push(
      `${selection.tooLarge.size} file${selection.tooLarge.size === 1 ? ' has' : 's have'} more than ` +
        `${limits.maxFilePatchLines} changed lines, so no code is included for ${selection.tooLarge.size === 1 ? 'it' : 'them'}.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
