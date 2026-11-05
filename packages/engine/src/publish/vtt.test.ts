import { describe, expect, it } from 'vitest';
import { toWebVtt } from '../narration/captions.ts';
import { parseVtt } from './vtt.ts';

describe('parseVtt', () => {
  it('reads cues with their timing and text', () => {
    const cues = parseVtt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:04.500\nFirst line.\n\n00:00:05.000 --> 00:00:09.250\nSecond line.\n',
    );
    expect(cues).toEqual([
      { startSec: 1, endSec: 4.5, text: 'First line.' },
      { startSec: 5, endSec: 9.25, text: 'Second line.' },
    ]);
  });

  it('handles short timestamps, hours, commas and Windows line endings', () => {
    const cues = parseVtt(
      'WEBVTT\r\n\r\n01:02.500 --> 01:04,000\r\nShort\r\n\r\n1:00:00.000 --> 1:00:02.000\r\nLong\r\n',
    );
    expect(cues).toEqual([
      { startSec: 62.5, endSec: 64, text: 'Short' },
      { startSec: 3600, endSec: 3602, text: 'Long' },
    ]);
  });

  it('ignores identifiers and cue settings', () => {
    const cues = parseVtt('WEBVTT\n\nintro\n00:00:00.000 --> 00:00:02.000 align:start position:10%\nHello\n');
    expect(cues).toEqual([{ startSec: 0, endSec: 2, text: 'Hello' }]);
  });

  it('keeps multi-line text', () => {
    expect(parseVtt('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nOne\nTwo\n')[0]?.text).toBe('One\nTwo');
  });

  it('skips the header, notes, styles and malformed blocks', () => {
    const source = [
      'WEBVTT - title',
      '',
      'NOTE a comment --> with an arrow',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'not a cue',
      '',
      '00:00:05.000 --> 00:00:04.000',
      'ends before it starts',
      '',
      '00:00:06.000 --> 00:00:07.000',
      '',
      '00:00:08.000 --> 00:00:09.000',
      'kept',
    ].join('\n');
    expect(parseVtt(source)).toEqual([{ startSec: 8, endSec: 9, text: 'kept' }]);
  });

  it('returns nothing for an empty or hostile file', () => {
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt('WEBVTT\n')).toEqual([]);
    expect(parseVtt('<script>alert(1)</script>')).toEqual([]);
  });

  it('stops at the cue limit', () => {
    const many = Array.from(
      { length: 50 },
      (_, i) =>
        `00:00:${String(i).padStart(2, '0')}.000 --> 00:00:${String(i).padStart(2, '0')}.500\nLine ${i}`,
    );
    expect(parseVtt(`WEBVTT\n\n${many.join('\n\n')}`, 10)).toHaveLength(10);
  });
});

describe('parseVtt and toWebVtt', () => {
  it('give back the cues that were written, including &, < and >', () => {
    const cues = [
      { startSec: 0, endSec: 2.5, text: 'This change makes retries safe & automatic.' },
      {
        startSec: 2.5,
        endSec: 6,
        text: 'It checks status < 600 && status >= 500,\nand returns Promise<void>.',
      },
      { startSec: 6, endSec: 9, text: 'R&D wrote "&amp;", "&lt;" and "&gt;" in the notes.' },
    ];
    expect(toWebVtt(cues)).toContain('safe &amp; automatic');
    expect(parseVtt(toWebVtt(cues))).toEqual(cues);
  });

  it('does not unescape twice', () => {
    expect(parseVtt('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n&amp;lt; and &amp;amp;\n')[0]?.text).toBe(
      '&lt; and &amp;',
    );
  });

  it('leaves text that is not one of the three escapes alone', () => {
    const text = parseVtt('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nA &copy; B &#38; C &amp D\n')[0]?.text;
    expect(text).toBe('A &copy; B &#38; C &amp D');
  });
});
