/** Evidence ids of logs: "L1" is a whole log, "L1.120-140" is lines 120 to 140, "L1.120" is one line. */

/** The most lines that one cited range may span. */
export const MAX_LOG_RANGE_LINES = 200;

const LOG_ID = /^(L[1-9]\d*)(?:\.([1-9]\d*)(?:-([1-9]\d*))?)?$/;

export interface LogCite {
  /** The id of the whole log, e.g. "L1". */
  log: string;
  /** Lines of the log that the id points at, both included. */
  start: number;
  end: number;
}

/**
 * What a log id points at, or null when it is not a valid id. `lineCounts` says how many lines each
 * supplied log has. A range is valid when the log exists, 1 <= start <= end <= its lines, and it spans
 * at most MAX_LOG_RANGE_LINES lines. A whole log ("L1") has no such limit.
 */
export function resolveLogId(
  id: string,
  lineCounts: { get(log: string): number | undefined },
): LogCite | null {
  const match = LOG_ID.exec(id);
  if (!match) return null;
  const log = match[1] as string;
  const lines = lineCounts.get(log);
  if (lines === undefined) return null;
  if (match[2] === undefined) return { log, start: 1, end: lines };
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (end < start || end > lines || end - start + 1 > MAX_LOG_RANGE_LINES) return null;
  return { log, start, end };
}

/** "lines 120 to 140", or "line 120" for one line. */
export function lineRangeText(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start} to ${end}`;
}
