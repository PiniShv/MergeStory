/** Hunk ranges and key-hunk ranking. */
import type {
  ChangedFile,
  DiffHunk,
  FileRole,
  KeyHunk,
  RiskSignal,
  Side,
  SymbolChange,
} from '../core/types.ts';
import { ROLE_WEIGHT } from './roles.ts';
import { commentOnlyHunk } from './trivial.ts';
import { round } from './util.ts';

export const MAX_KEY_HUNKS = 12;

export interface HunkRange {
  side: Side;
  startLine: number;
  endLine: number;
}

/** The lines a hunk covers: head side unless the hunk only deletes. */
export function hunkRange(hunk: DiffHunk): HunkRange {
  const hasAdd = hunk.lines.some((l) => l.kind === 'add');
  if (hasAdd || hunk.oldLines === 0) {
    const start = Math.max(1, hunk.newStart);
    return { side: 'head', startLine: start, endLine: Math.max(start, hunk.newStart + hunk.newLines - 1) };
  }
  const start = Math.max(1, hunk.oldStart);
  return { side: 'base', startLine: start, endLine: Math.max(start, hunk.oldStart + hunk.oldLines - 1) };
}

/** The path a hunk is read at: a hunk that only removes lines is read at base, where a renamed file still has its old path. */
export function hunkPath(file: ChangedFile, range: HunkRange): string {
  return range.side === 'base' && file.oldPath ? file.oldPath : file.path;
}

export function changedLineCount(hunk: DiffHunk): number {
  let n = 0;
  for (const l of hunk.lines) if (l.kind !== 'ctx') n++;
  return n;
}

export interface RankFile {
  file: ChangedFile;
  role: FileRole;
  trivial: boolean;
  hidden: boolean;
}

/** Score hunks by size, role and bonuses, and keep the best ones. */
export function rankKeyHunks(
  files: readonly RankFile[],
  symbols: readonly SymbolChange[],
  risks: readonly RiskSignal[],
): KeyHunk[] {
  const out: (KeyHunk & { order: number })[] = [];
  let order = 0;
  for (const { file, role, trivial, hidden } of files) {
    if (hidden || trivial || file.binary) continue;
    const weight = ROLE_WEIGHT[role];
    if (weight <= 0) continue;
    for (const hunk of file.hunks) {
      order++;
      const changed = changedLineCount(hunk);
      if (changed === 0) continue;
      const range = hunkRange(hunk);
      const reasons = [`${changed} changed ${changed === 1 ? 'line' : 'lines'}`];
      let score = (Math.log1p(changed) / Math.log1p(30)) * weight;
      if (role !== 'source') reasons.push(`${role} file`);
      if (commentOnlyHunk(file.path, hunk)) {
        score *= 0.3;
        reasons.push('comment-only');
      }
      const newExport = symbols.find(
        (s) =>
          s.fileId === file.id &&
          s.exported &&
          s.change === 'added' &&
          s.side === 'head' &&
          range.side === 'head' &&
          s.startLine <= range.endLine &&
          s.endLine >= range.startLine,
      );
      if (newExport) {
        score += 0.35;
        reasons.push(`new exported ${newExport.kind} ${newExport.name}`);
      }
      const flagged = risks.filter((r) => r.evidence.includes(hunk.id));
      if (flagged.length > 0) {
        score += flagged.some((r) => r.severity === 'high') ? 0.4 : 0.3;
        reasons.push(`risk ${flagged.map((r) => r.id).join(', ')}`);
      }
      if (file.status === 'added') {
        score += 0.2;
        reasons.push('new file');
      }
      out.push({
        id: hunk.id,
        fileId: file.id,
        path: hunkPath(file, range),
        side: range.side,
        startLine: range.startLine,
        endLine: range.endLine,
        score: round(score),
        reasons,
        order,
      });
    }
  }
  return out
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_KEY_HUNKS)
    .map(({ order: _order, ...hunk }) => hunk);
}
