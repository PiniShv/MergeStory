/** Helpers that the language modules share. */
import type { SymbolKind } from '../../core/types.ts';
import { blockEnd } from '../scan.ts';
import { type RawSymbol, signature } from '../symbol-types.ts';

/** What a full-line comment starts with, by syntax family. A line that starts with "*" continues a block. */
export const C_COMMENTS = ['//', '/*', '*'] as const;
export const HASH_COMMENTS = ['#'] as const;
export const SQL_COMMENTS = ['--'] as const;
export const MARKUP_COMMENTS = ['<!--', '-->'] as const;

/** Every match of a global pattern in a text, counted from its start. */
export function matchAll(text: string, pattern: RegExp): RegExpExecArray[] {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)];
}

const MONOREPO_PREFIXES = new Set(['packages', 'apps', 'services', 'libs', 'crates', 'modules', 'cmd']);

/** The package folder of a path in a monorepo ("packages/api" for "packages/api/src/a.ts"); "" elsewhere. */
export function packageRootOf(path: string): string {
  const [first, second] = path.split('/');
  return first && second && MONOREPO_PREFIXES.has(first) && path.split('/').length > 2
    ? `${first}/${second}`
    : '';
}

export interface EmitOptions {
  /** Whether other code can use the symbol. Default: true. */
  exported?: boolean;
  /**
   * Last line, as a 0-based index. Default: the line where the bracket block that starts on the
   * declaring line closes, or the declaring line itself when the detector tracks no brackets.
   */
  end?: number;
  /** First line, as a 0-based index, when decorators or annotations come before the declaring line. */
  start?: number;
  /** The declaration text. Default: the declaring line up to its first "{". */
  decl?: string;
}

export interface SymbolEmitter {
  symbols: RawSymbol[];
  /** Records a symbol. `line` is the 0-based index of the line that declares it. */
  emit(name: string, kind: SymbolKind, line: number, options?: EmitOptions): void;
}

/**
 * Collects the symbols that a detector finds. A detector that tracks brackets passes their depths
 * (see `nestingDepths`), so that a symbol ends where its block closes.
 */
export function symbolEmitter(lines: readonly string[], depths?: readonly number[]): SymbolEmitter {
  const symbols: RawSymbol[] = [];
  return {
    symbols,
    emit(name, kind, line, options = {}) {
      const {
        exported = true,
        start,
        end = depths ? blockEnd(depths, line, lines.length) : line,
        decl = signature(lines[line] ?? ''),
      } = options;
      symbols.push({
        name,
        kind,
        exported,
        decl,
        startLine: (start ?? line) + 1,
        endLine: end + 1,
        ...(start === undefined ? {} : { declLine: line + 1 }),
      });
    },
  };
}
