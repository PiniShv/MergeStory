/**
 * How a diff is read at one side, and what the diff view shows for a range. The storyboard checks
 * and the renderer both ask these functions, so a range that the checks call "fits on screen" has
 * the same rows when it is drawn.
 */
import type { ChangedFile, DiffHunk, DiffLine, Side } from './types.ts';

/** The line number of a diff line at one side, or null when the line does not exist there. */
export function sideNumber(line: DiffLine, side: Side): number | null {
  return side === 'head' ? line.newLine : line.oldLine;
}

/** Where a hunk starts at one side and how many lines it has there (0 for a pure insertion or deletion). */
export function hunkLines(hunk: DiffHunk, side: Side): { start: number; count: number } {
  return side === 'head'
    ? { start: hunk.newStart, count: hunk.newLines }
    : { start: hunk.oldStart, count: hunk.oldLines };
}

/**
 * Whether the hunk has lines at this side inside the range. Used to ask "does this range show a
 * change": a hunk that only adds or only removes has no lines at the other side.
 */
export function hunkOverlaps(hunk: DiffHunk, side: Side, start: number, end: number): boolean {
  const { start: from, count } = hunkLines(hunk, side);
  if (count <= 0) return false;
  return start <= from + count - 1 && end >= from;
}

/**
 * Whether the diff view of the range includes the hunk. Like hunkOverlaps, but a hunk with no lines
 * at this side counts when the point between two lines where it sits is in or next to the range.
 * Used to decide which hunks the diff view draws.
 */
export function hunkTouches(hunk: DiffHunk, side: Side, start: number, end: number): boolean {
  const { start: from, count } = hunkLines(hunk, side);
  if (count === 0) return from + 1 >= start && from <= end;
  return from <= end && from + count - 1 >= start;
}

/** Whether any hunk of the file has lines at this side inside the range. */
export function overlapsAnyHunk(file: ChangedFile, side: Side, start: number, end: number): boolean {
  return file.hunks.some((hunk) => hunkOverlaps(hunk, side, start, end));
}

/** The hunks the diff view of a range draws. */
export function hunksInView(file: ChangedFile, side: Side, from: number, to: number): DiffHunk[] {
  return file.hunks.filter((hunk) => hunkTouches(hunk, side, from, to));
}

/** Line numbers that this change adds (at head) or removes (at base). */
export function changedLinesAt(file: ChangedFile, side: Side): number[] {
  const out: number[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (side === 'head' && line.kind === 'add' && line.newLine !== null) out.push(line.newLine);
      if (side === 'base' && line.kind === 'del' && line.oldLine !== null) out.push(line.oldLine);
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * The lines the diff view shows for a range: the lines of the range plus the lines that exist only
 * at the other side (removed lines when the range is at head) inside it or next to it. Null when no
 * hunk touches the range. The view holds at most STORYBOARD_LIMITS.maxCodeLines rows and cuts the
 * rest, so a range may be short and still not fit.
 */
export function diffViewSpan(file: ChangedFile, side: Side, from: number, to: number): DiffLine[] | null {
  const hunks = hunksInView(file, side, from, to);
  if (hunks.length === 0) return null;
  const lines = hunks.flatMap((hunk) => hunk.lines);
  const inRange = (line: DiffLine): boolean => {
    const n = sideNumber(line, side);
    return n !== null && n >= from && n <= to;
  };
  let first = lines.findIndex(inRange);
  let last = lines.findLastIndex(inRange);
  if (first < 0) {
    first = 0;
    last = lines.length - 1;
  }
  while (first > 0 && sideNumber(lines[first - 1]!, side) === null) first--;
  while (last < lines.length - 1 && sideNumber(lines[last + 1]!, side) === null) last++;
  return lines.slice(first, last + 1);
}

/**
 * Shorten a range until its diff view fits in `max` rows, never cutting into `keep` (the lines the
 * narration points at). The end with more room is cut first. Null when `keep` alone needs more rows.
 */
export function fitDiffRange(
  file: ChangedFile,
  side: Side,
  start: number,
  end: number,
  keep: readonly [number, number],
  max: number,
): [number, number] | null {
  let from = start;
  let to = end;
  while ((diffViewSpan(file, side, from, to)?.length ?? 0) > max) {
    const roomAbove = keep[0] - from;
    const roomBelow = to - keep[1];
    if (roomAbove <= 0 && roomBelow <= 0) return null;
    if (roomBelow >= roomAbove) to--;
    else from++;
  }
  return [from, to];
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Shrink [start, end] to `max` lines around the focus line, or around the densest run of changed lines. */
export function shrinkRange(
  start: number,
  end: number,
  max: number,
  changed: readonly number[],
  focusCentre: number | null,
): [number, number] {
  if (end - start + 1 <= max) return [start, end];
  let first: number;
  if (focusCentre !== null) {
    first = Math.round(focusCentre - (max - 1) / 2);
  } else {
    const inRange = changed.filter((n) => n >= start && n <= end);
    if (inRange.length === 0) {
      first = Math.round((start + end) / 2 - (max - 1) / 2);
    } else {
      // The run of changed lines that fits in one window and holds the most of them.
      let bestCount = 0;
      let bestFrom = inRange[0]!;
      let bestTo = inRange[0]!;
      let low = 0;
      for (let high = 0; high < inRange.length; high++) {
        while (inRange[high]! - inRange[low]! >= max) low++;
        if (high - low + 1 > bestCount) {
          bestCount = high - low + 1;
          bestFrom = inRange[low]!;
          bestTo = inRange[high]!;
        }
      }
      first = Math.round((bestFrom + bestTo) / 2 - (max - 1) / 2);
    }
  }
  first = clamp(first, start, end - max + 1);
  return [first, first + max - 1];
}
