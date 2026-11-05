/**
 * A small lexical scan that tracks bracket nesting line by line while skipping strings and
 * comments. Symbol ranges come from it: a block ends on the line where nesting returns to the
 * level it had when the declaration started.
 */
export interface ScanProfile {
  lineComments: readonly string[];
  blockComments: boolean;
  /** Backtick strings may span lines (JS templates, Go raw strings). */
  backtick?: boolean;
  /** `${ ... }` inside backtick strings opens code (JS). */
  templateLiterals?: boolean;
  /** Slash can start a regular expression literal (JS). */
  regexLiterals?: boolean;
  /** A single quote may be a lifetime, not a character literal (Rust). */
  rustLifetimes?: boolean;
  /** Triple double quotes open a multi-line string (Kotlin, Java text blocks). */
  tripleQuotes?: boolean;
}

const REGEX_PRECEDERS = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

/**
 * Nesting depth of ( [ { at the start of every line. The result has one extra entry for the end
 * of the text, so `depths[i + 1]` is the depth after line `i`.
 */
export function nestingDepths(lines: readonly string[], profile: ScanProfile): number[] {
  const depths: number[] = [];
  let depth = 0;
  let inBlock = false;
  let multi: string | null = null;
  let lastSig = '';
  const templateStack: number[] = [];

  for (const line of lines) {
    depths.push(depth);
    let i = 0;
    while (i < line.length) {
      const ch = line[i] as string;
      if (inBlock) {
        if (ch === '*' && line[i + 1] === '/') {
          inBlock = false;
          i += 2;
        } else i++;
        continue;
      }
      if (multi !== null) {
        if (multi === '`') {
          if (ch === '\\') i += 2;
          else if (ch === '`') {
            multi = null;
            i++;
          } else if (profile.templateLiterals && ch === '$' && line[i + 1] === '{') {
            templateStack.push(depth);
            depth++;
            multi = null;
            i += 2;
          } else i++;
        } else if (line.startsWith(multi, i)) {
          i += multi.length;
          multi = null;
        } else i++;
        continue;
      }
      if (profile.lineComments.some((c) => line.startsWith(c, i))) break;
      if (profile.blockComments && ch === '/' && line[i + 1] === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      if (profile.tripleQuotes && line.startsWith('"""', i)) {
        multi = '"""';
        i += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        if (ch === "'" && profile.rustLifetimes) {
          const m = /^'(?:\\.|[^\\'])'/.exec(line.slice(i));
          i += m ? m[0].length : 1;
          continue;
        }
        i++;
        while (i < line.length && line[i] !== ch) i += line[i] === '\\' ? 2 : 1;
        i++;
        lastSig = ch;
        continue;
      }
      if (ch === '`' && profile.backtick) {
        multi = '`';
        i++;
        continue;
      }
      if (
        profile.regexLiterals &&
        ch === '/' &&
        line[i + 1] !== '/' &&
        line[i + 1] !== '*' &&
        REGEX_PRECEDERS.has(lastSig)
      ) {
        i++;
        let inClass = false;
        while (i < line.length) {
          const c = line[i] as string;
          if (c === '\\') i++;
          else if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          i++;
        }
        i++;
        lastSig = ')';
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        if (ch === '}' && templateStack.length > 0 && templateStack[templateStack.length - 1] === depth - 1) {
          templateStack.pop();
          depth--;
          multi = '`';
          i++;
          continue;
        }
        depth = Math.max(0, depth - 1);
      }
      if (ch !== ' ' && ch !== '\t') lastSig = ch;
      i++;
    }
  }
  depths.push(depth);
  return depths;
}

/** Zero-based index of the last line of a block that starts at line `start`. */
export function blockEnd(depths: readonly number[], start: number, lineCount: number): number {
  const base = depths[start] ?? 0;
  for (let e = start; e < lineCount; e++) {
    if ((depths[e + 1] ?? 0) <= base) return e;
  }
  return lineCount - 1;
}
