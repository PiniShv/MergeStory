/** A small WebVTT reader, used to put captions into a local watch page. */
import type { CaptionCue } from '../core/types.ts';

const TIMING =
  /^\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})(?:\s|$)/;

function toSeconds(stamp: string): number {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  const [seconds = 0, minutes = 0, hours = 0] = parts.reverse();
  return hours * 3600 + minutes * 60 + seconds;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>' };

/** Undo the escaping that toWebVtt does (&, < and >), in one pass so that "&amp;lt;" gives "&lt;". */
function unescapeCueText(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_, name: string) => ENTITIES[name] ?? '');
}

/**
 * Read the cues of a WebVTT file. Identifiers and cue settings are ignored, and blocks that
 * are not cues (header, notes, styles) or are malformed are skipped. The text is returned as it was
 * before toWebVtt escaped it, so the cues of a file that MergeStory wrote read the same as the
 * cues that were written.
 */
export function parseVtt(source: string, maxCues = 2000): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const block of source.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    // A cue may start with one identifier line before its timing line.
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0 || at > 1) continue;
    const timing = TIMING.exec(lines[at] ?? '');
    if (!timing?.[1] || !timing[2]) continue;
    const text = unescapeCueText(
      lines
        .slice(at + 1)
        .join('\n')
        .trim(),
    );
    const startSec = toSeconds(timing[1]);
    const endSec = toSeconds(timing[2]);
    if (!text || !(endSec > startSec)) continue;
    cues.push({ startSec, endSec, text });
    if (cues.length >= maxCues) break;
  }
  return cues;
}
