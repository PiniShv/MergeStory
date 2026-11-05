import { describe, expect, it } from 'vitest';
import { makeStoryboard, makeTimeline } from '../testing/narration.ts';
import {
  buildCaptionCues,
  CAPTION_LINE_CHARS,
  CAPTION_MAX_WORDS,
  captionText,
  splitCaptionText,
  toSrt,
  toWebVtt,
} from './captions.ts';

const LONG =
  'This change adds retry logic to the weather client, so failed requests back off exponentially. ' +
  'The client gives up after five attempts and reports the last error, which keeps the caller simple and predictable.';

describe('splitCaptionText', () => {
  it('keeps a short line in one cue', () => {
    expect(splitCaptionText('A short line.')).toEqual([{ text: 'A short line.', words: 3 }]);
  });

  it('wraps a line of up to 84 characters onto two balanced lines', () => {
    const [chunk] = splitCaptionText('The client retries failed requests with a growing delay.');
    expect(chunk?.text.split('\n')).toHaveLength(2);
    for (const line of chunk?.text.split('\n') ?? [])
      expect(line.length).toBeLessThanOrEqual(CAPTION_LINE_CHARS);
  });

  it('splits long lines into cues of at most 12 words and two lines of 42 characters', () => {
    const chunks = splitCaptionText(LONG);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.words).toBeLessThanOrEqual(CAPTION_MAX_WORDS);
      const lines = chunk.text.split('\n');
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(CAPTION_LINE_CHARS);
    }
    expect(chunks.map((c) => c.text.replace(/\n/g, ' ')).join(' ')).toBe(LONG);
  });

  it('keeps cues inside sentences, cuts at commas, and avoids a one-word last cue', () => {
    const chunks = splitCaptionText(LONG);
    const texts = chunks.map((c) => c.text.replace(/\n/g, ' '));
    const sentenceEnd = texts.findIndex((t) => t.endsWith('exponentially.'));
    expect(sentenceEnd).toBeGreaterThanOrEqual(0);
    expect(texts[sentenceEnd + 1]?.startsWith('The client')).toBe(true);
    expect(texts[0]?.endsWith('client,')).toBe(true);
    expect(chunks[chunks.length - 1]?.words).toBeGreaterThan(2);
  });

  it('lets short sentences share one cue', () => {
    const chunks = splitCaptionText('It works. Tests pass. Ship it.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.words).toBe(6);
  });

  it('never loses words, even for very long words', () => {
    const text = `Look at ${'x'.repeat(60)} and more words after it to force a split into several cues here`;
    const chunks = splitCaptionText(text);
    expect(chunks.map((c) => c.text.replace(/\n/g, ' ')).join(' ')).toBe(text);
  });

  it('returns nothing for empty text', () => {
    expect(splitCaptionText('')).toEqual([]);
  });
});

describe('captionText', () => {
  it('collapses whitespace and keeps the text as written', () => {
    expect(captionText('  Calls  `fetchWithRetry`,\n e.g. twice. ')).toBe(
      'Calls `fetchWithRetry`, e.g. twice.',
    );
  });

  it('masks secrets and e-mail addresses', () => {
    const key = `sk-ant-${'a1B2c3D4'.repeat(4)}`;
    expect(captionText(`The key ${key} leaked`)).not.toContain('sk-ant');
    expect(captionText('Mail ana@example.com now')).toBe('Mail a•••@example.com now');
    expect(captionText('Mail ana@example.com now', { maskEmails: false })).toBe('Mail ana@example.com now');
  });
});

describe('buildCaptionCues', () => {
  it('makes one cue per short line, at the beat times', () => {
    const storyboard = makeStoryboard({ s1: ['First line.', 'Second line.'], s2: ['Third line.'] });
    const timeline = makeTimeline(storyboard, 2, 0.5);
    const cues = buildCaptionCues(storyboard, timeline);
    expect(cues).toEqual([
      { startSec: 0.5, endSec: 2.5, text: 'First line.' },
      { startSec: 2.5, endSec: 4.5, text: 'Second line.' },
      { startSec: 5.5, endSec: 7.5, text: 'Third line.' },
    ]);
  });

  it('times the chunks of a long line in proportion to their words across the beat', () => {
    const storyboard = makeStoryboard({ s1: [LONG] });
    const timeline = makeTimeline(storyboard, 10, 1);
    const cues = buildCaptionCues(storyboard, timeline);
    const chunks = splitCaptionText(LONG);
    const total = chunks.reduce((sum, c) => sum + c.words, 0);
    expect(cues).toHaveLength(chunks.length);
    expect(cues[0]?.startSec).toBe(1);
    expect(cues[cues.length - 1]?.endSec).toBeCloseTo(11, 3);
    let used = 0;
    chunks.forEach((chunk, i) => {
      expect(cues[i]?.startSec).toBeCloseTo(1 + (10 * used) / total, 3);
      expect(cues[i]?.endSec).toBeCloseTo(1 + (10 * (used + chunk.words)) / total, 3);
      used += chunk.words;
    });
    for (let i = 1; i < cues.length; i++)
      expect(cues[i]?.startSec).toBeCloseTo(cues[i - 1]?.endSec as number, 3);
  });

  it('uses the line as written, not the spoken form', () => {
    const storyboard = makeStoryboard({ s1: ['Calls `fetchWithRetry` in src/client.ts, e.g. 340ms.'] });
    const cues = buildCaptionCues(storyboard, makeTimeline(storyboard));
    expect(
      cues
        .map((c) => c.text)
        .join(' ')
        .replace(/\n/g, ' '),
    ).toBe('Calls `fetchWithRetry` in src/client.ts, e.g. 340ms.');
  });

  it('skips lines without a beat and scenes without a timeline entry', () => {
    const storyboard = makeStoryboard({ s1: ['One.', 'Two.'], s2: ['Three.'] });
    const timeline = makeTimeline(storyboard);
    timeline.scenes[0]?.beats.pop();
    timeline.scenes.pop();
    expect(buildCaptionCues(storyboard, timeline).map((c) => c.text)).toEqual(['One.']);
  });

  it('keeps cues from overlapping', () => {
    const storyboard = makeStoryboard({ s1: ['First line here.'], s2: ['Second line here.'] });
    const timeline = makeTimeline(storyboard, 2, 0.5);
    const second = timeline.scenes[1]?.beats[0];
    if (second) second.startSec = 1.5; // starts before the first beat ends (2.5)
    const cues = buildCaptionCues(storyboard, timeline);
    expect(cues[0]?.endSec).toBeLessThanOrEqual(cues[1]?.startSec as number);
  });

  it('masks e-mail addresses unless told not to', () => {
    const storyboard = makeStoryboard({ s1: ['Ask ana@example.com.'] });
    const timeline = makeTimeline(storyboard);
    expect(buildCaptionCues(storyboard, timeline)[0]?.text).toBe('Ask a•••@example.com.');
    expect(buildCaptionCues(storyboard, timeline, { maskEmails: false })[0]?.text).toBe(
      'Ask ana@example.com.',
    );
  });
});

describe('toWebVtt', () => {
  it('writes the header, timestamps with milliseconds and blank lines between cues', () => {
    const vtt = toWebVtt([
      { startSec: 0.5, endSec: 2.25, text: 'First line' },
      { startSec: 3661.5, endSec: 3662, text: 'Line one\nLine two' },
    ]);
    expect(vtt).toBe(
      'WEBVTT\n\n00:00:00.500 --> 00:00:02.250\nFirst line\n\n01:01:01.500 --> 01:01:02.000\nLine one\nLine two\n',
    );
  });

  it('escapes characters that WebVTT treats as markup', () => {
    const vtt = toWebVtt([{ startSec: 0, endSec: 1, text: 'a < b & c --> d' }]);
    expect(vtt).toContain('a &lt; b &amp; c --&gt; d');
  });

  it('rounds to milliseconds and never writes an empty cue', () => {
    expect(toWebVtt([{ startSec: 1.9996, endSec: 1.9996, text: 'x' }])).toContain(
      '00:00:02.000 --> 00:00:02.001',
    );
  });

  it('is just a header without cues', () => {
    expect(toWebVtt([])).toBe('WEBVTT\n');
  });
});

describe('toSrt', () => {
  it('numbers the cues and uses comma milliseconds', () => {
    const srt = toSrt([
      { startSec: 0.5, endSec: 2.25, text: 'First line' },
      { startSec: 3, endSec: 4, text: 'Second\nthird' },
    ]);
    expect(srt).toBe(
      '1\n00:00:00,500 --> 00:00:02,250\nFirst line\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\nthird\n',
    );
  });

  it('does not escape text', () => {
    expect(toSrt([{ startSec: 0, endSec: 1, text: 'a < b & c' }])).toContain('a < b & c');
  });
});
