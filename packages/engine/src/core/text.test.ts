import { describe, expect, it } from 'vitest';
import {
  collapseLineRange,
  countWords,
  decodeTextBlob,
  naturalList,
  plural,
  shellQuote,
  splitLines,
  stripInvisible,
  terminalSafe,
  truncate,
} from './text.ts';

describe('plural', () => {
  it('puts the count before the word and adds an "s" unless the count is 1', () => {
    expect(plural(0, 'file')).toBe('0 files');
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(2, 'file')).toBe('2 files');
  });

  it('uses the plural form that is given', () => {
    expect(plural(1, 'dependency', 'dependencies')).toBe('1 dependency');
    expect(plural(3, 'dependency', 'dependencies')).toBe('3 dependencies');
  });
});

describe('naturalList', () => {
  it('joins with commas and "and"', () => {
    expect(naturalList([])).toBe('');
    expect(naturalList(['a'])).toBe('a');
    expect(naturalList(['a', 'b'])).toBe('a and b');
    expect(naturalList(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('splitLines', () => {
  it('splits at every kind of line ending', () => {
    expect(splitLines('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('gives no extra empty line for a final line ending, and none at all for no text', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('', 0)).toBe('');
  });

  it('cuts to the length, ends with an ellipsis and drops the space before it', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate('ab cdef', 4)).toBe('ab…');
    expect(truncate('abc', 0)).toBe('…');
  });

  it('counts characters, so an emoji is never cut in half', () => {
    expect(truncate('😀'.repeat(10), 4)).toBe('😀😀😀…');
    expect(truncate('😀😀😀', 3)).toBe('😀😀😀');
    expect(truncate('a😀b😀c', 4)).toBe('a😀b…');
  });
});

describe('collapseLineRange', () => {
  it('shows a range of one line as that line', () => {
    expect(collapseLineRange('src/retry.ts:8-8')).toBe('src/retry.ts:8');
    expect(collapseLineRange('DEFAULT_RETRY (src/retry.ts:8-8)')).toBe('DEFAULT_RETRY (src/retry.ts:8)');
    expect(collapseLineRange('a.ts:120-120 and b.ts:7-7')).toBe('a.ts:120 and b.ts:7');
  });

  it('leaves real ranges and other labels alone', () => {
    for (const label of [
      'src/retry.ts:8-19',
      'src/retry.ts:8-80',
      'src/retry.ts:18-8',
      'src/client.ts:4-44',
      'src/retry.ts',
      'v1-1',
      '10:10-10:20',
    ]) {
      expect(collapseLineRange(label)).toBe(label);
    }
  });
});

describe('shellQuote', () => {
  it('leaves plain words and paths alone', () => {
    expect(shellQuote('--task-file')).toBe('--task-file');
    expect(shellQuote('/work/tests.json')).toBe('/work/tests.json');
    expect(shellQuote('feature/retry')).toBe('feature/retry');
    expect(shellQuote('/tmp/a-b_c.d/storyboard.json')).toBe('/tmp/a-b_c.d/storyboard.json');
    expect(shellQuote('/srv/mergestory/credentials/youtube.json')).toBe(
      '/srv/mergestory/credentials/youtube.json',
    );
    expect(shellQuote('HEAD~2')).toBe('HEAD~2');
  });

  it('quotes everything else', () => {
    expect(shellQuote('my task.md')).toBe("'my task.md'");
    expect(shellQuote('/srv/some folder/x.json')).toBe("'/srv/some folder/x.json'");
    expect(shellQuote('a;b $(x)')).toBe("'a;b $(x)'");
    expect(shellQuote('$(x)')).toBe("'$(x)'");
    expect(shellQuote('first line\nsecond line')).toBe("'first line\nsecond line'");
    expect(shellQuote('')).toBe("''");
  });

  it('escapes a single quote inside the quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote(`/tmp/it's.json`)).toBe(`'/tmp/it'\\''s.json'`);
  });

  it('quotes a value that starts with # or ~, which a shell would take for a comment or a home folder', () => {
    expect(shellQuote('#42')).toBe("'#42'");
    expect(shellQuote('# fix')).toBe("'# fix'");
    expect(shellQuote('~')).toBe("'~'");
    expect(shellQuote('~/notes.md')).toBe("'~/notes.md'");
    expect(shellQuote('~root')).toBe("'~root'");
  });

  it('leaves # and ~ alone inside a word, where they mean nothing to a shell', () => {
    expect(shellQuote('acme/app#42')).toBe('acme/app#42');
    expect(shellQuote('a~b')).toBe('a~b');
  });
});

/** Every character that must go from text for a terminal or a video, with its code point. */
const HIDDEN: [string, number[]][] = [
  ['C0 controls', Array.from({ length: 0x20 }, (_, i) => i)],
  ['delete and C1 controls', Array.from({ length: 0x21 }, (_, i) => 0x7f + i)],
  ['Arabic letter mark', [0x061c]],
  ['zero-width characters and direction marks', Array.from({ length: 5 }, (_, i) => 0x200b + i)],
  ['directional embeddings and overrides', Array.from({ length: 5 }, (_, i) => 0x202a + i)],
  ['word joiner and invisible operators', Array.from({ length: 5 }, (_, i) => 0x2060 + i)],
  ['directional isolates', Array.from({ length: 4 }, (_, i) => 0x2066 + i)],
  ['byte order mark', [0xfeff]],
  ['tag characters', Array.from({ length: 0x80 }, (_, i) => 0xe0000 + i)],
];

/** The control characters that each mode leaves in the text. */
const KEPT = {
  'tab-newline': [0x09, 0x0a],
  'line-breaks': [0x09, 0x0a, 0x0d],
  'white-space': [0x09, 0x0a, 0x0b, 0x0c, 0x0d],
} as const;

describe('stripInvisible', () => {
  for (const [mode, kept] of Object.entries(KEPT) as [keyof typeof KEPT, readonly number[]][]) {
    it(`removes every control, zero-width, direction and tag character except what "${mode}" keeps`, () => {
      for (const [name, points] of HIDDEN) {
        for (const point of points) {
          const char = String.fromCodePoint(point);
          const expected = kept.includes(point) ? `a${char}b` : 'ab';
          expect(stripInvisible(`a${char}b`, mode), `${name} U+${point.toString(16)}`).toBe(expected);
        }
      }
    });
  }

  it('removes the same characters from text with several of them in it', () => {
    const hostile = `a\u0000b\u0007c​d‮e⁦f﻿g${String.fromCodePoint(0xe0041)}h‍i؜j⁢k`;
    expect(stripInvisible(hostile, 'tab-newline')).toBe('abcdefghijk');
    expect(stripInvisible(hostile, 'line-breaks')).toBe('abcdefghijk');
    expect(stripInvisible(hostile, 'white-space')).toBe('abcdefghijk');
  });

  it('keeps line breaks by default and everything else that people write', () => {
    expect(stripInvisible('one\r\ntwo\tthree')).toBe('one\r\ntwo\tthree');
    expect(stripInvisible('Grüße, 日本語, emoji 🎬, ¡hola! — “quoted” · ½')).toBe(
      'Grüße, 日本語, emoji 🎬, ¡hola! — “quoted” · ½',
    );
    expect(stripInvisible('')).toBe('');
  });
});

describe('terminalSafe', () => {
  it('removes control, direction and zero-width characters but keeps tabs and line breaks', () => {
    // A commit subject that tries to set the clipboard, move the cursor, and reverse the text after it.
    const hostile = 'Add retry \u001b]52;c;aGVsbG8=\u0007logic\u001b[2A\r‮evil\u009b';
    expect(terminalSafe(hostile)).toBe('Add retry ]52;c;aGVsbG8=logic[2Aevil');
    expect(terminalSafe('a\tb\nc​d⁦e﻿f\u0000g\u007fh')).toBe('a\tb\ncdefgh');
    expect(terminalSafe('Grüße, 日本語, emoji 🎬')).toBe('Grüße, 日本語, emoji 🎬');
  });

  it('removes a carriage return, which would move the cursor back and overwrite what was printed', () => {
    expect(terminalSafe('safe text\rmalicious')).toBe('safe textmalicious');
  });
});

describe('decodeTextBlob', () => {
  it('decodes text, dropping a BOM and CRLF', () => {
    expect(decodeTextBlob(Buffer.from('﻿a\r\nb\r\n'))).toBe('a\nb\n');
    expect(decodeTextBlob(Buffer.from('plain'))).toBe('plain');
    expect(decodeTextBlob(Buffer.alloc(0))).toBe('');
  });

  it('refuses binary data, which has a NUL byte near its start', () => {
    expect(decodeTextBlob(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBeNull();
    // Past the first 8000 bytes a NUL does not make a file binary.
    expect(decodeTextBlob(Buffer.concat([Buffer.alloc(9000, 'a'), Buffer.from([0])]))).not.toBeNull();
  });
});

describe('countWords', () => {
  it('counts runs of letters or digits separated by white space', () => {
    expect(countWords('one two  three')).toBe(3);
    expect(countWords('  ')).toBe(0);
    expect(countWords('a — b ...')).toBe(2);
    expect(countWords('v2 über 3.5')).toBe(3);
  });
});
