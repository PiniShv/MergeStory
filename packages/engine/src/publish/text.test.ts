import { describe, expect, it } from 'vitest';
import {
  cleanText,
  escapeAttribute,
  escapeHtml,
  formatDate,
  formatDateTime,
  formatTimestamp,
  htmlText,
  safeAssetUrl,
  safeHttpUrl,
  shortSha,
} from './text.ts';

describe('cleanText', () => {
  it('collapses whitespace into single spaces', () => {
    expect(cleanText('  one \n\n two\t three  ')).toBe('one two three');
  });

  it('removes control, zero-width, direction and tag characters', () => {
    const hostile = `a\u0000b\u0007c\u200Bd\u202Ee\u2066f\uFEFFg${String.fromCodePoint(0xe0041)}h`;
    expect(cleanText(hostile)).toBe('abcdefgh');
  });

  it('removes the same hidden characters as the terminal and the video do, joiners included', () => {
    expect(cleanText('👨\u200D💻')).toBe('👨💻');
    expect(cleanText('a\u200Cb\u200Dc\u061Cd\u2062e')).toBe('abcde');
  });

  it('treats the white space controls as white space, not as hidden characters', () => {
    expect(cleanText('a\u000Bb\u000Cc\rd')).toBe('a b c d');
  });

  it('turns anything that is not text into an empty string', () => {
    expect(cleanText(undefined)).toBe('');
    expect(cleanText(null)).toBe('');
    expect(cleanText({})).toBe('');
    expect(cleanText(42)).toBe('42');
  });

  it('caps the length by characters and marks the cut', () => {
    expect(cleanText('abcdefghij', 5)).toBe('abcd…');
    expect(cleanText('😀'.repeat(10), 4)).toBe('😀😀😀…');
    expect(cleanText('short', 50)).toBe('short');
  });
});

describe('escaping', () => {
  it('escapes the characters that matter in HTML', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('escapes attribute values without touching single quotes', () => {
    expect(escapeAttribute(`default-src 'none'; a="b" & <c>`)).toBe(
      `default-src 'none'; a=&quot;b&quot; &amp; &lt;c&gt;`,
    );
  });

  it('cleans before it escapes', () => {
    expect(htmlText('  <b>\u202E hi </b> ')).toBe('&lt;b&gt; hi &lt;/b&gt;');
  });
});

describe('safeHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(safeHttpUrl('https://github.com/acme/app/pull/1')).toBe('https://github.com/acme/app/pull/1');
    expect(safeHttpUrl('http://localhost:9000/a.mp4')).toBe('http://localhost:9000/a.mp4');
  });

  it('leaves a signed URL exactly as it is', () => {
    const signed =
      'https://media.acct.r2.cloudflarestorage.com/v/abc/video.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261103%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261103T120000Z&X-Amz-Expires=3600&X-Amz-Signature=c19ecd1b&X-Amz-SignedHeaders=host&x-id=GetObject';
    expect(safeHttpUrl(signed)).toBe(signed);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/x',
    '//evil.example/x',
    '/relative/path',
    'video.mp4',
    'https://user:pass@example.com/x',
    '',
    '   ',
  ])('rejects %j', (value) => {
    expect(safeHttpUrl(value)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
  });
});

describe('safeAssetUrl', () => {
  it('accepts http(s) URLs and plain relative paths', () => {
    expect(safeAssetUrl('https://cdn.example.com/v/a/video.mp4')).toBe(
      'https://cdn.example.com/v/a/video.mp4',
    );
    expect(safeAssetUrl('video.mp4')).toBe('video.mp4');
    expect(safeAssetUrl('media/video.mp4')).toBe('media/video.mp4');
  });

  it.each([
    '../video.mp4',
    'a/../b.mp4',
    './video.mp4',
    '/video.mp4',
    '//evil.example/video.mp4',
    '\\\\evil\\share\\video.mp4',
    'a/%2e%2e/b.mp4',
    '.hidden',
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    'file:///tmp/video.mp4',
    'video.mp4?x=1',
    'video mp4',
  ])('rejects %j', (value) => {
    expect(safeAssetUrl(value)).toBeNull();
  });
});

describe('formatting', () => {
  it('formats timestamps as m:ss and h:mm:ss', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(9.9)).toBe('0:09');
    expect(formatTimestamp(75)).toBe('1:15');
    expect(formatTimestamp(3600)).toBe('1:00:00');
    expect(formatTimestamp(3725)).toBe('1:02:05');
    expect(formatTimestamp(-5)).toBe('0:00');
    expect(formatTimestamp(Number.NaN)).toBe('0:00');
  });

  it('formats dates in UTC and rejects bad input', () => {
    expect(formatDate('2026-11-03T23:59:59+00:00')).toBe('2026-11-03');
    expect(formatDateTime('2026-11-10T21:45:01.000Z')).toBe('2026-11-10 21:45 UTC');
    expect(formatDate('not a date')).toBeNull();
    expect(formatDateTime(null)).toBeNull();
  });

  it('shortens commit ids and refuses other text', () => {
    expect(shortSha('3F9C2AB1D0E49B7A55C3')).toBe('3f9c2ab');
    expect(shortSha('main')).toBeNull();
    expect(shortSha('abc')).toBeNull();
    expect(shortSha(undefined)).toBeNull();
  });
});
