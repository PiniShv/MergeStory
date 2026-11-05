/**
 * Captions: one cue per narration line (long lines are split), timed from the timeline, and
 * written as WebVTT or SRT. Cue text is the line as written, never the spoken form.
 */
import { maskPrivate } from '../core/secrets.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { CaptionCue, Timeline } from '../core/types.ts';

/** Most words in one cue. */
export const CAPTION_MAX_WORDS = 12;
/** Longest line of a cue, in characters. A cue has at most two lines. */
export const CAPTION_LINE_CHARS = 42;

export interface CaptionOptions {
  /** Mask e-mail addresses (default true, like the privacy setting). */
  maskEmails?: boolean;
}

/**
 * Text as shown to viewers: whitespace collapsed, secrets (and e-mail addresses) masked.
 * Narration lines are already checked upstream; this keeps captions safe on their own.
 */
export function captionText(text: string, options: CaptionOptions = {}): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return maskPrivate(collapsed, { maskEmails: options.maskEmails !== false });
}

/** Split a word list into at most two lines of CAPTION_LINE_CHARS, or null when it cannot fit. */
function wrapLines(words: string[]): string | null {
  const full = words.join(' ');
  if (full.length <= CAPTION_LINE_CHARS) return full;
  let best: { score: number; text: string } | null = null;
  for (let i = 1; i < words.length; i++) {
    const first = words.slice(0, i).join(' ');
    const second = words.slice(i).join(' ');
    if (first.length > CAPTION_LINE_CHARS || second.length > CAPTION_LINE_CHARS) continue;
    // Prefer breaking after punctuation, then the most even split.
    const punctuation = /[.,;:!?]$/.test(words[i - 1] ?? '') ? -6 : 0;
    const score = Math.abs(first.length - second.length) + punctuation;
    if (!best || score < best.score) best = { score, text: `${first}\n${second}` };
  }
  return best?.text ?? null;
}

function chunkFits(words: string[]): boolean {
  return words.length === 1 || (words.length <= CAPTION_MAX_WORDS && wrapLines(words) !== null);
}

/** How well a cut after `words[position - 1]` reads: sentence ends are best, then clause breaks. */
function boundaryBonus(words: string[], position: number): number {
  const word = words[position - 1] ?? '';
  if (/[.!?]["')\]]?$/.test(word)) return 3;
  if (/[,;:—–]["')\]]?$/.test(word)) return 2;
  return 0;
}

/** Cut positions that split `words` into `parts` pieces of similar size, preferring punctuation. */
function cutPositions(words: string[], parts: number): number[] {
  const cuts: number[] = [];
  let previous = 0;
  for (let k = 1; k < parts; k++) {
    const ideal = Math.round((k * words.length) / parts);
    const latest = words.length - (parts - k);
    let best = Math.min(Math.max(previous + 1, ideal), latest);
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let position = ideal - 2; position <= ideal + 2; position++) {
      if (position <= previous || position > latest) continue;
      const score = boundaryBonus(words, position) - Math.abs(position - ideal);
      if (score > bestScore) {
        bestScore = score;
        best = position;
      }
    }
    cuts.push(best);
    previous = best;
  }
  return cuts;
}

interface CaptionChunk {
  /** Cue text, with a line break when it needs two lines. */
  text: string;
  words: number;
}

/** Split words into the fewest balanced pieces that each fit, preferring punctuation for the cuts. */
function splitBalanced(words: string[]): string[][] {
  for (let parts = Math.max(1, Math.ceil(words.length / CAPTION_MAX_WORDS)); parts <= words.length; parts++) {
    const groups: string[][] = [];
    let from = 0;
    for (const cut of [...cutPositions(words, parts), words.length]) {
      groups.push(words.slice(from, cut));
      from = cut;
    }
    if (groups.every((g) => g.length > 0 && chunkFits(g))) return groups;
  }
  return words.map((w) => [w]);
}

const SENTENCE_BREAK = /(?<=[.!?]["')\]]?)\s+(?=["'([]?[\p{Lu}\d])/u;

/**
 * Split one caption line into cues of at most 12 words and two lines of 42 characters.
 * Cues follow sentence boundaries where they can: short sentences share a cue, long ones are
 * cut at the most natural pause.
 */
export function splitCaptionText(text: string): CaptionChunk[] {
  const sentences = text
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.split(' ').filter(Boolean))
    .filter((words) => words.length > 0);
  const groups: string[][] = [];
  let current: string[] = [];
  for (const sentence of sentences) {
    const merged = [...current, ...sentence];
    if (current.length > 0 && !chunkFits(merged)) {
      groups.push(current);
      current = sentence;
    } else {
      current = merged;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups
    .flatMap((group) => (chunkFits(group) ? [group] : splitBalanced(group)))
    .map((g) => ({ text: wrapLines(g) ?? g.join(' '), words: g.length }));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Spread the chunks over the beat in proportion to their word counts. */
function timeChunks(chunks: CaptionChunk[], startSec: number, durationSec: number): CaptionCue[] {
  const total = chunks.reduce((sum, c) => sum + c.words, 0);
  const duration = Math.max(durationSec, 0.1);
  const cues: CaptionCue[] = [];
  let used = 0;
  for (const chunk of chunks) {
    cues.push({
      startSec: round3(startSec + (duration * used) / total),
      endSec: round3(startSec + (duration * (used + chunk.words)) / total),
      text: chunk.text,
    });
    used += chunk.words;
  }
  return cues;
}

/** Make sure a cue does not start before the previous one ends. */
function resolveOverlaps(cues: CaptionCue[]): CaptionCue[] {
  for (let i = 1; i < cues.length; i++) {
    const previous = cues[i - 1] as CaptionCue;
    const current = cues[i] as CaptionCue;
    if (current.startSec < previous.endSec) {
      previous.endSec = round3(Math.max(previous.startSec + 0.05, current.startSec));
    }
  }
  return cues;
}

/**
 * One cue per narration line, split into chunks of at most 12 words and two lines of 42
 * characters, timed in proportion to word counts across the beat. Beat times are absolute.
 * E-mail addresses are masked unless `options.maskEmails` is false.
 */
export function buildCaptionCues(
  storyboard: Storyboard,
  timeline: Timeline,
  options: CaptionOptions = {},
): CaptionCue[] {
  const timed = new Map(timeline.scenes.map((scene) => [scene.sceneId, scene]));
  const cues: CaptionCue[] = [];
  for (const scene of storyboard.scenes) {
    const slots = timed.get(scene.id);
    if (!slots) continue;
    scene.narration.forEach((line, index) => {
      const beat = slots.beats.find((b) => b.index === index);
      const text = captionText(line.text, options);
      if (!beat || !text) return;
      cues.push(...timeChunks(splitCaptionText(text), beat.startSec, beat.durationSec));
    });
  }
  cues.sort((a, b) => a.startSec - b.startSec);
  return resolveOverlaps(cues);
}

function timestamp(seconds: number, separator: '.' | ','): string {
  const total = Math.round(Math.max(0, seconds) * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(h)}:${two(m)}:${two(s)}${separator}${String(ms).padStart(3, '0')}`;
}

function cueTimes(cue: CaptionCue, separator: '.' | ','): string {
  const end = Math.max(cue.endSec, cue.startSec + 0.001);
  return `${timestamp(cue.startSec, separator)} --> ${timestamp(end, separator)}`;
}

function escapeVtt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** WebVTT file: header, then one block per cue. Markup characters in the text are escaped. */
export function toWebVtt(cues: CaptionCue[]): string {
  if (cues.length === 0) return 'WEBVTT\n';
  const blocks = cues.map((cue) => `${cueTimes(cue, '.')}\n${escapeVtt(cue.text)}`);
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/** SubRip file: numbered cues with comma milliseconds. */
export function toSrt(cues: CaptionCue[]): string {
  return cues.map((cue, i) => `${i + 1}\n${cueTimes(cue, ',')}\n${cue.text}\n`).join('\n');
}
