/** Splitting long text into pieces a speech engine accepts, at natural pauses. */

function pack(parts: string[], maxChars: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    const joined = current ? `${current} ${part}` : part;
    if (current && joined.length > maxChars) {
      out.push(current);
      current = part;
    } else {
      current = joined;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Split text into pieces of at most `maxChars` characters. Cuts fall after sentence ends where
 * possible, then after commas, then between words; a single word longer than the limit is cut.
 */
export function splitForSynthesis(text: string, maxChars: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const pieces: string[] = [];
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if (sentence.length <= maxChars) {
      pieces.push(sentence);
      continue;
    }
    for (const clause of pack(sentence.split(/(?<=[,;:])\s+/), maxChars)) {
      if (clause.length <= maxChars) {
        pieces.push(clause);
        continue;
      }
      for (const run of pack(clause.split(' '), maxChars)) {
        for (let i = 0; i < run.length; i += maxChars) pieces.push(run.slice(i, i + maxChars));
      }
    }
  }
  return pack(pieces, maxChars);
}
