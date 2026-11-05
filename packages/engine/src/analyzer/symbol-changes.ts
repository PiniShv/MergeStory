/** Classifies the symbols of a changed file as added, modified or removed by overlapping them with the diff. */
import { isShowable } from '../core/path-policy.ts';
import type { ChangedFile, SymbolChange } from '../core/types.ts';
import type { RawSymbol } from './symbol-types.ts';
import { detectSymbols } from './symbols.ts';

export interface ChangedSymbol extends Omit<SymbolChange, 'id'> {
  /** The declaration text differs between base and head. */
  signatureChanged: boolean;
  decl: string;
}

interface DiffFootprint {
  /** Head line numbers of added lines. */
  added: Set<number>;
  /** Base line numbers of deleted lines. */
  deleted: Set<number>;
  /** Deletions sit between two head lines: [prev, next]. */
  gaps: { prev: number; next: number }[];
}

function footprint(file: ChangedFile): DiffFootprint {
  const added = new Set<number>();
  const deleted = new Set<number>();
  const gaps: { prev: number; next: number }[] = [];
  for (const hunk of file.hunks) {
    let prev = hunk.newStart - 1;
    let inRun = false;
    let runPrev = prev;
    for (const line of hunk.lines) {
      if (line.kind === 'del') {
        if (line.oldLine !== null) deleted.add(line.oldLine);
        if (!inRun) {
          inRun = true;
          runPrev = prev;
        }
        continue;
      }
      if (inRun && line.newLine !== null) {
        gaps.push({ prev: runPrev, next: line.newLine });
        inRun = false;
      }
      if (line.newLine !== null) {
        prev = line.newLine;
        if (line.kind === 'add') added.add(line.newLine);
      }
    }
    if (inRun) gaps.push({ prev: runPrev, next: prev + 1 });
  }
  return { added, deleted, gaps };
}

const keyOf = (s: RawSymbol): string => `${s.kind}:${s.name}`;
const declLineOf = (s: RawSymbol): number => s.declLine ?? s.startLine;

function toChange(
  file: ChangedFile,
  s: RawSymbol,
  change: SymbolChange['change'],
  side: SymbolChange['side'],
  signatureChanged: boolean,
): ChangedSymbol {
  return {
    name: s.name,
    kind: s.kind,
    change,
    fileId: file.id,
    path: side === 'base' ? (file.oldPath ?? file.path) : file.path,
    side,
    startLine: s.startLine,
    endLine: s.endLine,
    exported: s.exported,
    signatureChanged,
    decl: s.decl,
  };
}

/**
 * `head` and `base` are the file contents at each side (null when unavailable). Base content is
 * only needed to find removed symbols and to tell a new symbol from a changed signature.
 */
export function classifySymbols(
  file: ChangedFile,
  head: string | null,
  base: string | null,
): ChangedSymbol[] {
  if (!isShowable(file)) return [];

  if (file.status === 'deleted') {
    if (base === null) return [];
    return detectSymbols(file.path, base).map((s) => toChange(file, s, 'removed', 'base', false));
  }

  if (head === null) return [];
  const headSymbols = detectSymbols(file.path, head);

  if (file.status === 'added' || file.status === 'copied') {
    return headSymbols.map((s) => toChange(file, s, 'added', 'head', false));
  }
  if (file.hunks.length === 0) return [];

  const fp = footprint(file);
  const baseSymbols = base === null ? [] : detectSymbols(file.oldPath ?? file.path, base);
  const baseByKey = new Map(baseSymbols.map((s) => [keyOf(s), s]));
  const headKeys = new Set(headSymbols.map(keyOf));
  const out: ChangedSymbol[] = [];

  for (const s of headSymbols) {
    const baseMatch = baseByKey.get(keyOf(s));
    const signatureChanged = !!baseMatch && baseMatch.decl !== s.decl;
    if (fp.added.has(declLineOf(s))) {
      out.push(
        baseMatch
          ? toChange(file, s, 'modified', 'head', signatureChanged)
          : toChange(file, s, 'added', 'head', false),
      );
      continue;
    }
    let touched = false;
    for (let l = s.startLine; l <= s.endLine && !touched; l++) touched = fp.added.has(l);
    touched = touched || fp.gaps.some((g) => g.prev >= s.startLine && g.next <= s.endLine);
    if (touched) out.push(toChange(file, s, 'modified', 'head', signatureChanged));
  }

  for (const b of baseSymbols) {
    if (fp.deleted.has(declLineOf(b)) && !headKeys.has(keyOf(b)))
      out.push(toChange(file, b, 'removed', 'base', false));
  }
  return out;
}
