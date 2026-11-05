import type { SymbolKind } from '../core/types.ts';

/** A declaration found in one version of a file. */
export interface RawSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  exported: boolean;
  /** Line of the declaration itself when decorators or annotations come first (1-based). */
  declLine?: number;
  /** Declaration text, whitespace-collapsed. Compared across base and head to spot signature changes. */
  decl: string;
}

export function collapse(text: string, max = 240): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, max);
}

/** A declaration line without its body: cut at the first "{" so edits inside the body do not look like signature changes. */
export function signature(text: string): string {
  const cut = text.indexOf('{');
  return collapse(cut < 0 ? text : text.slice(0, cut));
}
