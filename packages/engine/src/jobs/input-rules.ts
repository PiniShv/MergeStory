/** Rules for text that ends up on a command line or in a git command, shared by the CLI and the HTTP API. */

export function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** What is wrong with a git ref (branch, tag or commit), or null when it is fine. A ref must never be read as an option. */
export function refProblem(value: string): string | null {
  if (value === '') return 'must not be empty';
  if (value.length > 256) return 'is too long';
  if (value.startsWith('-')) return 'must not start with "-"';
  if (/\s/.test(value) || hasControlCharacter(value)) return 'must not contain spaces or control characters';
  return null;
}

/** What is wrong with a source (pull request reference or repository path), or null when it is fine. */
export function sourceProblem(value: string): string | null {
  if (value === '') return 'must not be empty';
  if (value.length > 2048) return 'is too long';
  if (value.startsWith('-')) return 'must not start with "-"';
  if (hasControlCharacter(value)) return 'must not contain control characters';
  // A password in a URL would end up in logs and job files. Tokens belong in the environment.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i.test(value))
    return 'must not contain credentials (use GITHUB_TOKEN instead)';
  return null;
}

/**
 * The longest unbroken run of word characters (letters, digits, "_", "." and "-") accepted in text
 * from a caller. The secret scanner slows down sharply on very long runs, and real prose, notes and
 * test output never contain one.
 */
export const MAX_UNBROKEN_RUN = 1000;

/** Length of the longest run of word characters in `text`. One pass, so it is fast on any input. */
export function longestRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isWord =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95 ||
      code === 46 ||
      code === 45;
    current = isWord ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/** true when any string in a parsed JSON document, key or value, holds a run longer than the limit. Does not recurse. */
export function hasLongRunDeep(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string') {
      if (longestRun(item) > MAX_UNBROKEN_RUN) return true;
    } else if (Array.isArray(item)) {
      for (const entry of item) pending.push(entry);
    } else if (item !== null && typeof item === 'object') {
      for (const [key, entry] of Object.entries(item)) {
        if (longestRun(key) > MAX_UNBROKEN_RUN) return true;
        pending.push(entry);
      }
    }
  }
  return false;
}

/** The deepest nesting of arrays and objects accepted in a request body. Real requests are far shallower. */
export const MAX_NESTING = 64;

/** true when a parsed JSON document nests arrays or objects deeper than `MAX_NESTING`. Does not recurse. */
export function isTooDeep(value: unknown): boolean {
  const pending: Array<[unknown, number]> = [[value, 1]];
  while (pending.length > 0) {
    const [item, depth] = pending.pop() as [unknown, number];
    if (item === null || typeof item !== 'object') continue;
    if (depth > MAX_NESTING) return true;
    for (const entry of Array.isArray(item) ? item : Object.values(item)) pending.push([entry, depth + 1]);
  }
  return false;
}
