/**
 * Unified diff parsing: the hunks of one file, from a GitHub "patch" string or from the output of
 * `git diff` for one file (the file header lines before the first hunk are skipped).
 *
 * Hunks are read by their line counts, not by line prefixes. A removed line that starts with
 * "-- " looks like a file header ("--- ") and an added line that starts with "++" looks like
 * one too, so only the counts in the "@@" header can tell them apart reliably.
 */
import type { DiffHunk, DiffLine } from '../core/types.ts';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Split on newlines, drop one trailing empty element and any carriage returns. */
function splitPatchLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.endsWith('\r')) lines[i] = line.slice(0, -1);
  }
  return lines;
}

interface HunkParse {
  hunk: DiffHunk;
  /** Index of the first line after the hunk. */
  next: number;
}

/** Parse the hunk whose "@@" header is at `start`, or return null when that line is not a header. */
function parseHunkAt(lines: string[], start: number, id: string): HunkParse | null {
  const match = HUNK_HEADER.exec(lines[start]!);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  const header = (match[5] ?? '').replace(/^ /, '').trimEnd();

  const body: DiffLine[] = [];
  let oldLeft = oldLines;
  let newLeft = newLines;
  let oldNumber = oldStart;
  let newNumber = newStart;
  let i = start + 1;
  while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
    const line = lines[i]!;
    const marker = line.charAt(0);
    if (marker === '\\') {
      // "\ No newline at end of file" describes the previous line and has no line number.
      i++;
      continue;
    }
    if (marker === '+' && newLeft > 0) {
      body.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newNumber });
      newNumber++;
      newLeft--;
    } else if (marker === '-' && oldLeft > 0) {
      body.push({ kind: 'del', text: line.slice(1), oldLine: oldNumber, newLine: null });
      oldNumber++;
      oldLeft--;
    } else if ((marker === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
      // Some tools strip the space from empty context lines.
      body.push({ kind: 'ctx', text: line.slice(1), oldLine: oldNumber, newLine: newNumber });
      oldNumber++;
      newNumber++;
      oldLeft--;
      newLeft--;
    } else {
      break;
    }
    i++;
  }
  while (i < lines.length && lines[i]!.startsWith('\\')) i++;
  return { hunk: { id, oldStart, oldLines, newStart, newLines, header, lines: body }, next: i };
}

/**
 * Parse the hunks of one file from a GitHub "patch" string (no file headers).
 * Ids are "<fileId>.H1", "<fileId>.H2", ... Text before the first header is ignored.
 */
export function parsePatchHunks(patch: string, fileId: string): DiffHunk[] {
  const lines = splitPatchLines(patch);
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const parsed = parseHunkAt(lines, i, `${fileId}.H${hunks.length + 1}`);
    if (!parsed) {
      i++;
      continue;
    }
    hunks.push(parsed.hunk);
    i = parsed.next;
  }
  return hunks;
}
