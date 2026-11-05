/** Small text helpers shared by every part of the engine. They keep no state and read nothing. */

/** "1 file", "2 files". `many` is for words that do not just add an "s". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function naturalList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

/** Words in a text. Counts runs of letters or digits separated by white space. */
export function countWords(text: string): number {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length;
}

/** Split text into lines at any line ending; a trailing newline does not produce an extra empty line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Cut a string to `max` characters (not UTF-16 units, so an emoji is never cut in half) and mark the cut with an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  return `${chars
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`;
}

/**
 * Show a range of one line as that line: "src/a.ts:8-8" becomes "src/a.ts:8". Works on a label that
 * holds a range anywhere, such as "withRetry (src/retry.ts:21-21)".
 */
export function collapseLineRange(label: string): string {
  return label.replace(/:(\d+)-\1(?![\d:])/g, ':$1');
}

/**
 * A value quoted for a POSIX shell, only when it needs it. A value that starts with "#" would begin
 * a comment and one that starts with "~" would turn into a home folder, so those are quoted too.
 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-][A-Za-z0-9_@%+=:,./#~-]*$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Characters that draw nothing or move text around: Arabic letter mark, zero-width characters,
 * direction marks and overrides, invisible operators, the byte order mark and the "tag" block. The
 * control characters are in the patterns below, because callers keep different ones.
 */
const HIDDEN =
  '\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}';

/**
 * Which control characters `stripInvisible` leaves in the text:
 * - "tab-newline": what a terminal can show. A carriage return would move the cursor back and overwrite text.
 * - "line-breaks": tab, line feed and carriage return, the line endings of text from a file.
 * - "white-space": every white space control (tab, line feed, vertical tab, form feed, carriage return),
 *   for a caller that collapses white space next.
 */
type KeptControls = 'tab-newline' | 'line-breaks' | 'white-space';

const INVISIBLE: Record<KeptControls, RegExp> = {
  'tab-newline': new RegExp(`(?![\\t\\n])\\p{Cc}|[${HIDDEN}]`, 'gu'),
  'line-breaks': new RegExp(`(?![\\t\\n\\r])\\p{Cc}|[${HIDDEN}]`, 'gu'),
  'white-space': new RegExp(`(?![\\t-\\r])\\p{Cc}|[${HIDDEN}]`, 'gu'),
};

/**
 * The text without control characters (except the ones named by `kept`) and without characters
 * that hide or reorder text. Text with these in it can rewrite a terminal, or look like something it is not.
 */
export function stripInvisible(text: string, kept: KeptControls = 'line-breaks'): string {
  return text.replace(INVISIBLE[kept], '');
}

/** `text` safe to print to a terminal: escape sequences and invisible or reordering characters are gone. Tabs and line feeds stay. */
export function terminalSafe(text: string): string {
  return stripInvisible(text, 'tab-newline');
}

/** Git treats a file as binary when a NUL byte appears in its first 8000 bytes; so do we. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Decode file bytes as text for the repository readers, or return null for binary data.
 * A leading byte order mark is dropped and CRLF line endings become LF, so line numbers and
 * line text match what the diff parser returns.
 */
export function decodeTextBlob(data: Buffer): string | null {
  if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  let text = data.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text;
}
