/** Small text helpers for narration, labels and PR text. */
import { countWords } from '../core/text.ts';

const ABBREVIATION = /(?:\be\.g|\bi\.e|\betc|\bvs|\bapprox|\bcf|\bincl|\bno|\bfig|\bmr|\bmrs|\bms|\bdr)\.$/i;

/** Split text into sentences. Keeps abbreviations, decimals and file names in one piece. */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const sentences: string[] = [];
  let start = 0;
  const boundary = /([.!?])(["')\]]*)(\s+)(?=[A-Z0-9"'([`])/g;
  for (const match of trimmed.matchAll(boundary)) {
    const end = (match.index ?? 0) + match[1]!.length + match[2]!.length;
    const candidate = trimmed.slice(start, end);
    if (ABBREVIATION.test(candidate)) continue;
    sentences.push(candidate.trim());
    start = (match.index ?? 0) + match[0].length;
  }
  const rest = trimmed.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

export const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The text with every character that has a meaning in a regular expression escaped. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function joinSentences(sentences: readonly string[]): string {
  return sentences
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

/** Shorten to at most `max` characters, cutting at a word boundary and adding an ellipsis. */
export function truncateText(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const room = Math.max(1, max - 1);
  const head = clean.slice(0, room);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace >= room * 0.5 ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s,;:.\-–—]+$/, '')}…`;
}

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];

export function ordinal(index: number): string {
  return ORDINALS[index] ?? `Number ${index + 1}`;
}

/** The line without HTML tags. Repeats until none is left, as taking one out can join the halves of another. */
function dropTags(line: string): string {
  let before: string;
  do {
    before = line;
    line = line.replace(/<\/?[A-Za-z][^<>]*>/g, '');
  } while (line !== before);
  return line;
}

/** Make Markdown readable as plain sentences: drops comments, code fences, headings, tables, links and emphasis. */
export function stripMarkdown(markdown: string): string {
  const lines = markdown
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .split(/\r?\n/);
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      kept.push('');
      continue;
    }
    if (/^#{1,6}\s/.test(line) || /^[-*_]{3,}$/.test(line) || /^\|/.test(line) || /^>\s*$/.test(line))
      continue;
    if (/^[-*+]\s*\[[ xX]\]/.test(line)) continue;
    kept.push(
      dropTags(line.replace(/!\[[^\]]*]\([^)]*\)/g, '').replace(/\[([^\]]+)]\([^)]*\)/g, '$1'))
        .replace(/(?:https?:\/\/|www\.)\S+/g, '')
        .replace(/^>\s*/, '')
        .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/`+([^`]*)`+/g, '$1')
        .replace(/(?<![\w])(\*{1,3}|_{1,3})(\S(?:[^*_\n]*?\S)?)\1(?![\w])/g, '$2')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BOILERPLATE =
  /^(?:(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|related to|see|ref(?:s|erences?)?|part of)\b.{0,60}#\d+|co-authored-by:|signed-off-by:|summary:?$|description:?$|what:?$|why:?$)/i;

/**
 * The first sentence of the first paragraph that says something, from a PR description or task.
 * Returns null when there is none. Ticket references and template boilerplate are skipped.
 */
export function firstMeaningfulSentence(markdown: string, minWords = 4): string | null {
  for (const paragraph of stripMarkdown(markdown).split(/\n{2,}/)) {
    const flat = paragraph.replace(/\s*\n\s*/g, ' ').trim();
    if (!flat || BOILERPLATE.test(flat)) continue;
    for (const sentence of splitSentences(flat)) {
      if (BOILERPLATE.test(sentence)) continue;
      if (countWords(sentence) >= minWords) return sentence;
    }
  }
  return null;
}
