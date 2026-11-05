import { describe, expect, it } from 'vitest';
import { publishMeta } from '../../testing/publish.ts';
import {
  buildDescription,
  buildTags,
  buildTitle,
  chapterStamp,
  chaptersQualify,
  DESCRIPTION_MAX_BYTES,
  fitTags,
  MADE_WITH,
  REVIEW_NOTE,
  tagsLength,
  truncateBytes,
  utf8Length,
  youTubeLanguage,
  youTubeText,
} from './description.ts';

describe('chapterStamp', () => {
  it('writes mm:ss and h:mm:ss', () => {
    expect(chapterStamp(0)).toBe('00:00');
    expect(chapterStamp(5.9)).toBe('00:05');
    expect(chapterStamp(65)).toBe('01:05');
    expect(chapterStamp(3725)).toBe('1:02:05');
    expect(chapterStamp(-3)).toBe('00:00');
    expect(chapterStamp(Number.NaN)).toBe('00:00');
  });
});

describe('chaptersQualify', () => {
  const at = (...starts: number[]) => starts.map((startSec) => ({ startSec }));

  it('accepts three or more chapters from 00:00 that last at least ten seconds', () => {
    expect(chaptersQualify(at(0, 10, 20), 30)).toBe(true);
    expect(chaptersQualify(at(0, 12, 30, 55), 90)).toBe(true);
  });

  it('needs at least three chapters', () => {
    expect(chaptersQualify(at(0, 30), 90)).toBe(false);
    expect(chaptersQualify([], 90)).toBe(false);
  });

  it('needs the first chapter at 00:00', () => {
    expect(chaptersQualify(at(5, 20, 40), 90)).toBe(false);
  });

  it('refuses a chapter shorter than ten seconds', () => {
    expect(chaptersQualify(at(0, 9, 30), 90)).toBe(false);
    expect(chaptersQualify(at(0, 30, 35), 90)).toBe(false);
  });

  it('measures the last chapter against the video length', () => {
    expect(chaptersQualify(at(0, 20, 40), 49)).toBe(false);
    expect(chaptersQualify(at(0, 20, 40), 50)).toBe(true);
  });

  it('does not check the last chapter when the length is unknown', () => {
    expect(chaptersQualify(at(0, 20, 40), null)).toBe(true);
  });

  it('refuses chapters that are out of order or repeated', () => {
    expect(chaptersQualify(at(0, 30, 20), 90)).toBe(false);
    expect(chaptersQualify(at(0, 20, 20), 90)).toBe(false);
  });

  it('counts whole seconds, as the timestamps show them', () => {
    expect(chaptersQualify(at(0.4, 10.2, 20.9), 31)).toBe(true);
    expect(chaptersQualify(at(0, 9.9, 20), 30)).toBe(false);
  });
});

describe('buildDescription', () => {
  it('builds summary, chapters, checklist, link and the two fixed lines', () => {
    const text = buildDescription({ meta: publishMeta(), repoIsPublic: true });
    expect(text).toBe(
      [
        'Failed forecast calls are retried with exponential backoff, so short outages no longer fail requests.',
        '',
        'Chapters',
        '00:00 Why this change',
        '00:12 The retry loop',
        '00:30 Tests',
        '00:55 What to review',
        '',
        'Review checklist',
        '- Is the retry limit sensible?',
        '- Are client errors excluded?',
        '',
        'Pull request: https://github.com/example/weather/pull/482',
        '',
        'Made with MergeStory - every change has a story.',
        'This video explains the change; it does not replace code review.',
      ].join('\n'),
    );
  });

  it('always ends with the two fixed lines', () => {
    const text = buildDescription({ meta: publishMeta(), repoIsPublic: false });
    expect(text.endsWith(`${MADE_WITH}\n${REVIEW_NOTE}`)).toBe(true);
    expect(MADE_WITH).toBe('Made with MergeStory - every change has a story.');
    expect(REVIEW_NOTE).toBe('This video explains the change; it does not replace code review.');
  });

  describe('pull request link', () => {
    it('is left out for a private or unknown repository', () => {
      const text = buildDescription({ meta: publishMeta(), repoIsPublic: false });
      expect(text).not.toContain('github.com');
      expect(text).not.toContain('Pull request:');
      expect(text).not.toContain('example/weather');
    });

    it('is left out when there is no link, even for a public repository', () => {
      const text = buildDescription({ meta: publishMeta({ changeUrl: null }), repoIsPublic: true });
      expect(text).not.toContain('Pull request:');
    });

    it('is left out when the address carries credentials or is not http', () => {
      for (const changeUrl of ['https://user:pw@github.com/a/b/pull/1', 'javascript:alert(1)', 'not a url']) {
        const text = buildDescription({ meta: publishMeta({ changeUrl }), repoIsPublic: true });
        expect(text).not.toContain('Pull request:');
      }
    });
  });

  describe('chapters', () => {
    it('uses timestamps only when YouTube will make chapters from them', () => {
      const text = buildDescription({ meta: publishMeta(), repoIsPublic: false });
      expect(text).toContain('00:00 Why this change');
    });

    it('falls back to a plain list when a chapter is too short', () => {
      const text = buildDescription({ meta: publishMeta({ durationSec: 60 }), repoIsPublic: false });
      expect(text).toContain('Chapters\n- Why this change\n- The retry loop\n- Tests\n- What to review');
      expect(text).not.toMatch(/\d\d:\d\d/);
    });

    it('does not check the last chapter against a length that is not a usable number', () => {
      for (const durationSec of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const text = buildDescription({ meta: publishMeta({ durationSec }), repoIsPublic: false });
        expect(text, String(durationSec)).toContain('00:55 What to review');
      }
    });

    it('falls back to a plain list with fewer than three chapters', () => {
      const text = buildDescription({
        meta: publishMeta({
          chapters: [
            { title: 'One', startSec: 0 },
            { title: 'Two', startSec: 40 },
          ],
        }),
        repoIsPublic: false,
      });
      expect(text).toContain('Chapters\n- One\n- Two');
    });

    it('falls back to a plain list when the first chapter does not start at 00:00', () => {
      const text = buildDescription({
        meta: publishMeta({
          chapters: [
            { title: 'One', startSec: 3 },
            { title: 'Two', startSec: 40 },
            { title: 'Three', startSec: 70 },
          ],
          durationSec: 120,
        }),
        repoIsPublic: false,
      });
      expect(text).toContain('- One\n- Two\n- Three');
      expect(text).not.toMatch(/\d\d:\d\d/);
    });

    it('leaves the section out without chapters', () => {
      const text = buildDescription({ meta: publishMeta({ chapters: [] }), repoIsPublic: false });
      expect(text).not.toContain('Chapters');
    });

    it('names an untitled chapter by its number', () => {
      const text = buildDescription({
        meta: publishMeta({
          chapters: [
            { title: '  ', startSec: 0 },
            { title: 'B', startSec: 20 },
            { title: 'C', startSec: 40 },
          ],
        }),
        repoIsPublic: false,
      });
      expect(text).toContain('00:00 Part 1');
    });
  });

  describe('forbidden characters', () => {
    it('never lets < or > through, and keeps the text readable', () => {
      const text = buildDescription({
        meta: publishMeta({
          summary: 'Adds Result<T> and a => b <script>alert(1)</script>',
          chapters: [
            { title: 'List<String>', startSec: 0 },
            { title: 'B > C', startSec: 20 },
            { title: 'D < E', startSec: 40 },
          ],
          checklist: [{ title: 'Check Map<K, V>', severity: 'low' }],
          changeUrl: 'https://github.com/example/weather/pull/1?x=<y>',
        }),
        repoIsPublic: true,
      });
      expect(text).not.toMatch(/[<>]/);
      expect(text).toContain('Result\u2039T\u203a');
      expect(text).toContain('00:00 List\u2039String\u203a');
    });
  });

  describe('length', () => {
    it('stays within 5,000 bytes of UTF-8 for huge input, and keeps the fixed lines', () => {
      const long = 'ü'.repeat(3_000);
      const text = buildDescription({
        meta: publishMeta({
          summary: long,
          chapters: Array.from({ length: 40 }, (_, i) => ({
            title: `${'é'.repeat(100)}${i}`,
            startSec: i * 20,
          })),
          checklist: Array.from({ length: 40 }, (_, i) => ({
            title: `${'日本語'.repeat(60)}${i}`,
            severity: 'low' as const,
          })),
          durationSec: 2_000,
        }),
        repoIsPublic: true,
      });
      expect(utf8Length(text)).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
      expect(text.endsWith(`${MADE_WITH}\n${REVIEW_NOTE}`)).toBe(true);
      expect(text).toContain('Pull request: https://github.com/example/weather/pull/482');
    });

    it('cuts a long summary at a character boundary', () => {
      const text = buildDescription({
        meta: publishMeta({ summary: '日本語'.repeat(1_000), chapters: [], checklist: [] }),
        repoIsPublic: false,
      });
      expect(text).not.toContain('\uFFFD');
      expect(text).toContain('\u2026');
    });

    it('keeps the chapter list valid when it has to be cut short', () => {
      const text = buildDescription({
        meta: publishMeta({
          summary: '',
          checklist: [],
          chapters: Array.from({ length: 20 }, (_, i) => ({
            title: `${'x'.repeat(90)} ${i}`,
            startSec: i * 15,
          })),
          durationSec: 400,
        }),
        repoIsPublic: false,
      });
      const stamped = text.split('\n').filter((line) => /^\d\d:\d\d /.test(line));
      expect(stamped.length).toBeGreaterThanOrEqual(3);
      expect(stamped.length).toBeLessThan(20);
      expect(stamped[0]).toMatch(/^00:00 /);
    });
  });

  it('removes control characters and collapses whitespace', () => {
    const text = buildDescription({
      meta: publishMeta({ summary: 'Line one\n\nLine\u0000 two\u202e  with   gaps' }),
      repoIsPublic: false,
    });
    expect(text.split('\n\n')[0]).toBe('Line one Line two with gaps');
  });

  it('leaves out an empty summary and an empty checklist', () => {
    const text = buildDescription({
      meta: publishMeta({ summary: '   ', checklist: [], chapters: [] }),
      repoIsPublic: false,
    });
    expect(text).toBe(`${MADE_WITH}\n${REVIEW_NOTE}`);
  });
});

describe('buildTitle', () => {
  it('uses the title as it is when it fits', () => {
    expect(buildTitle(publishMeta())).toBe('Add retry with backoff');
  });

  it('cuts a long title to 100 characters', () => {
    const title = buildTitle({ title: 'a'.repeat(300), changeLabel: 'PR #1' });
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title.endsWith('\u2026')).toBe(true);
  });

  it('counts emoji as two units, the strictest reading of the limit', () => {
    const title = buildTitle({ title: '😀'.repeat(80), changeLabel: 'PR #1' });
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).not.toContain('\uFFFD');
  });

  it('replaces < and >', () => {
    expect(buildTitle({ title: 'Fix <b> tag', changeLabel: '' })).toBe('Fix \u2039b\u203a tag');
  });

  it('falls back to the change label, then to a fixed title', () => {
    expect(buildTitle({ title: ' ', changeLabel: 'PR #7' })).toBe('PR #7');
    expect(buildTitle({ title: '', changeLabel: '' })).toBe('Pull request explainer');
  });
});

describe('tags', () => {
  it('builds short generic tags, and adds the repository name for public repositories only', () => {
    expect(buildTags(publishMeta(), false)).toEqual(['MergeStory', 'pull request', 'code review']);
    expect(buildTags(publishMeta(), true)).toEqual(['MergeStory', 'pull request', 'code review', 'weather']);
  });

  it('counts tags the way YouTube does: commas, and two extra characters for a space', () => {
    expect(tagsLength(['Foo-Baz'])).toBe(7);
    expect(tagsLength(['Foo Baz'])).toBe(9);
    expect(tagsLength(['a', 'b', 'c'])).toBe(5);
  });

  it('keeps the total under 500 characters, drops duplicates and brackets', () => {
    const many = Array.from({ length: 100 }, (_, i) => `tag number ${i}`);
    const fitted = fitTags(['MergeStory', 'mergestory', 'a<b>c', ...many]);
    expect(tagsLength(fitted)).toBeLessThanOrEqual(500);
    expect(fitted.filter((t) => t.toLowerCase() === 'mergestory')).toHaveLength(1);
    expect(fitted.join('')).not.toMatch(/[<>\u2039\u203a]/);
    expect(fitted).toContain('abc');
  });

  it('shortens each tag', () => {
    expect(fitTags(['x'.repeat(100)])[0]?.length).toBeLessThanOrEqual(30);
  });

  it('ignores a repository name that is not a plain name', () => {
    expect(buildTags({ repoLabel: 'example/weather ments' }, true)).toEqual([
      'MergeStory',
      'pull request',
      'code review',
    ]);
  });
});

describe('youTubeLanguage', () => {
  it('accepts language codes and normalises underscores', () => {
    expect(youTubeLanguage('en')).toBe('en');
    expect(youTubeLanguage('pt-BR')).toBe('pt-BR');
    expect(youTubeLanguage('en_US')).toBe('en-US');
  });

  it('rejects anything else', () => {
    expect(youTubeLanguage('english please')).toBeNull();
    expect(youTubeLanguage('')).toBeNull();
    expect(youTubeLanguage(null)).toBeNull();
    expect(youTubeLanguage('x')).toBeNull();
  });
});

describe('truncateBytes and youTubeText', () => {
  it('leaves short text alone and cuts long text with an ellipsis within the byte limit', () => {
    expect(truncateBytes('hello', 10)).toBe('hello');
    const cut = truncateBytes('日本語日本語日本語', 10);
    expect(utf8Length(cut)).toBeLessThanOrEqual(10);
    expect(cut.endsWith('\u2026')).toBe(true);
  });

  it('returns nothing when there is no room even for the ellipsis', () => {
    expect(truncateBytes('abcdef', 2)).toBe('');
  });

  it('turns non-text into an empty string', () => {
    expect(youTubeText(undefined, 10)).toBe('');
    expect(youTubeText({}, 10)).toBe('');
  });
});
