/** Formatting and masking helpers for the evidence pack. */
import { MASK_CHAR, maskPrivate } from '../core/secrets.ts';
import { truncate } from '../core/text.ts';
import type { DiffLine } from '../core/types.ts';

export interface Masker {
  /** Single-line text: secrets masked, line breaks collapsed. */
  text(value: string): string;
  /** Multi-line text: secrets masked, line breaks kept. */
  block(value: string): string;
  /** Mask one line of code. */
  code(value: string): string;
  /** Mask the lines of one hunk, including multi-line private keys. */
  hunk(lines: readonly DiffLine[]): string[];
}

const MASK = MASK_CHAR.repeat(8);
const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
const BASE64_BODY = /^[A-Za-z0-9+/=]{48,}$/;
const MAX_CODE_LINE = 240;

export function createMasker(maskMail: boolean): Masker {
  const block = (value: string): string => maskPrivate(value, { maskEmails: maskMail });
  const text = (value: string): string => block(value).replace(/[\r\n\u2028\u2029]+/g, ' ');
  const code = (value: string): string => truncate(text(value.replace(/\t/g, '  ')), MAX_CODE_LINE);
  return {
    text,
    block,
    code,
    hunk(lines) {
      let inKey = false;
      return lines.map((line) => {
        const t = line.text;
        if (KEY_BEGIN.test(t)) {
          inKey = !KEY_END.test(t);
          return MASK;
        }
        if (inKey) {
          if (KEY_END.test(t)) inKey = false;
          return MASK;
        }
        if (BASE64_BODY.test(t.trim())) return MASK;
        return code(t);
      });
    },
  };
}

/** A Markdown fence longer than any backtick run inside, so untrusted text cannot close it early. */
export function fence(body: string, info = ''): string {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}${info}\n${body}\n${marks}`;
}

/** Make text safe for one Markdown table cell. */
export function cell(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/`/g, "'");
}

/** Inline code span that survives backticks in the text. */
export function code(value: string): string {
  return `\`${value.replace(/[\r\n`]+/g, ' ')}\``;
}

export function numberedLine(number: number | null, marker: '+' | '-' | ' ', text: string): string {
  return `${String(number ?? '').padStart(4)} ${marker} ${text}`;
}

const SIMPLE_ID = /^([A-Z]+)(\d+)$/;

/** Collapse runs of consecutive ids with the same prefix: S1 S2 S3 -> "S1-S3". Other ids stay as they are. */
export function compressIds(ids: readonly string[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < ids.length) {
    const first = SIMPLE_ID.exec(ids[i] as string);
    if (!first) {
      parts.push(ids[i] as string);
      i++;
      continue;
    }
    let j = i;
    let last = Number(first[2]);
    while (j + 1 < ids.length) {
      const next = SIMPLE_ID.exec(ids[j + 1] as string);
      if (!next || next[1] !== first[1] || Number(next[2]) !== last + 1) break;
      last = Number(next[2]);
      j++;
    }
    parts.push(j > i ? `${first[1]}${first[2]}-${first[1]}${last}` : (ids[i] as string));
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * Collapse hunk ids: F2.H1 F2.H2 F2.H3 -> "F2.H1-H3", and a run of files that each have only H1
 * -> "F5.H1-F9.H1" (H1 of every file from F5 to F9). Used only for very long lists. An id of another
 * shape is kept as it is, after the collapsed ones.
 */
export function compressHunkIds(ids: readonly string[]): string {
  const byFile = new Map<number, number[]>();
  const others: string[] = [];
  for (const id of ids) {
    const m = /^F(\d+)\.H(\d+)$/.exec(id);
    if (!m) {
      others.push(id);
      continue;
    }
    const file = Number(m[1]);
    byFile.set(file, [...(byFile.get(file) ?? []), Number(m[2])]);
  }
  const parts: string[] = [];
  let run: number[] = [];
  const flushRun = (): void => {
    if (run.length === 1) parts.push(`F${run[0]}.H1`);
    else if (run.length > 1) parts.push(`F${run[0]}.H1-F${run[run.length - 1]}.H1`);
    run = [];
  };
  for (const [file, hunks] of byFile) {
    hunks.sort((a, b) => a - b);
    if (hunks.length === 1 && hunks[0] === 1) {
      if (run.length > 0 && (run[run.length - 1] as number) + 1 !== file) flushRun();
      run.push(file);
      continue;
    }
    flushRun();
    let start = hunks[0] as number;
    let prev = start;
    const emit = (): void => {
      parts.push(start === prev ? `F${file}.H${start}` : `F${file}.H${start}-H${prev}`);
    };
    for (const n of hunks.slice(1)) {
      if (n === prev + 1) prev = n;
      else {
        emit();
        start = n;
        prev = n;
      }
    }
    emit();
  }
  flushRun();
  return [...parts, ...others].join(', ');
}
