/** Regex-based declaration detection. Not a parser: it finds the named things a reviewer talks about. */

import { splitLines } from '../core/text.ts';
import { languageSupport } from './languages/index.ts';
import type { RawSymbol } from './symbol-types.ts';

const MAX_LINES = 20_000;
const MAX_LINE_LENGTH = 2_000;

/** Detect declarations in a file. Unknown languages and oversized files yield nothing. */
export function detectSymbols(path: string, content: string): RawSymbol[] {
  const detect = languageSupport(path)?.symbols;
  if (!detect) return [];
  const raw = splitLines(content);
  if (raw.length === 0 || raw.length > MAX_LINES) return [];
  return detect(
    raw.map((l) => (l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) : l)),
    path,
  );
}
