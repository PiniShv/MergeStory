import { describe, expect, it } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import { buildDescriptionSection, buildPrComment, neutralizeMarkdown } from './comment.ts';
import { COMMENT_MARKER, type CommentData, DESCRIPTION_END, DESCRIPTION_START } from './types.ts';

const WATCH_URL =
  'https://media.example.com/mergestory/v/abc/index.html?X-Amz-Expires=3600&X-Amz-Signature=aa11';

function sampleComment(overrides: Partial<CommentData> = {}): CommentData {
  return {
    title: 'Add retry with backoff',
    summary: 'Failed calls are retried up to four times.',
    watchUrl: WATCH_URL,
    posterUrl: 'https://cdn.example.com/mergestory/v/abc/poster.jpg',
    durationSec: 128,
    chapters: [
      { title: 'Why this change', startSec: 0 },
      { title: 'The retry helper', startSec: 21 },
      { title: 'Wrap up', startSec: 121 },
    ],
    checklist: [
      {
        title: 'Retries on POST',
        detail: 'Check the retry limit.',
        severity: 'high',
        ref: {
          label: 'src/client.ts:88-120',
          url: 'https://github.com/example/weather/blob/3f9c/src/client.ts#L88-L120',
        },
      },
      {
        title: 'No test for the abort signal',
        detail: '',
        severity: 'low',
        ref: { label: 'test/retry.test.ts', url: null },
      },
    ],
    headSha: '3f9c2ab1d0e49b7a55c3e2f1a0b9c8d7e6f5a4b3',
    linkExpiresAt: '2026-11-10T21:45:01.000Z',
    visibility: 'private',
    provider: 's3',
    ...overrides,
  };
}

describe('buildPrComment', () => {
  const comment = buildPrComment(sampleComment());

  it('starts with the marker, and the marker appears once', () => {
    expect(comment.startsWith(`${COMMENT_MARKER}\n`)).toBe(true);
    expect(comment.split(COMMENT_MARKER)).toHaveLength(2);
  });

  it('has a short heading and the bold watch line', () => {
    expect(comment).toContain('### MergeStory: Add retry with backoff');
    expect(comment).toContain(`**Not sure what changed? [Watch the 2-minute MergeStory](${WATCH_URL})**`);
  });

  it.each([
    [30, '30-second'],
    [75, '75-second'],
    [89, '89-second'],
    [90, '2-minute'],
    [128, '2-minute'],
    [150, '3-minute'],
    [300, '5-minute'],
  ])('describes %s seconds as "%s"', (durationSec, label) => {
    expect(buildPrComment(sampleComment({ durationSec }))).toContain(`[Watch the ${label} MergeStory](`);
  });

  it('falls back to a plain label when the length is unknown', () => {
    expect(buildPrComment(sampleComment({ durationSec: Number.NaN }))).toContain('[Watch the MergeStory](');
  });

  it('lists chapters with timestamps', () => {
    expect(comment).toContain(
      '**Chapters**\n\n- `0:00` Why this change\n- `0:21` The retry helper\n- `2:01` Wrap up',
    );
  });

  it('lists review items with file links when a link is known', () => {
    expect(comment).toContain('**What to review**');
    expect(comment).toContain(
      '- **High:** Retries on POST. Check the retry limit. ([`src/client.ts:88-120`](https://github.com/example/weather/blob/3f9c/src/client.ts#L88-L120))',
    );
    expect(comment).toContain('- **Low:** No test for the abort signal (`test/retry.test.ts`)');
  });

  it('ends with the commit, the disclaimer and the expiry', () => {
    const footer = comment.split('\n').at(-1);
    expect(footer).toBe(
      '<sub>Commit `3f9c2ab`. The video explains the change; it does not replace code review. The link expires on 2026-11-10 21:45 UTC.</sub>',
    );
  });

  it('leaves out the expiry when the link does not expire, and the commit when it is unknown', () => {
    const footer = buildPrComment(sampleComment({ linkExpiresAt: null, headSha: 'main' }))
      .split('\n')
      .at(-1);
    expect(footer).toBe('<sub>The video explains the change; it does not replace code review.</sub>');
  });

  it('shows the poster only for links that anyone can open', () => {
    const poster = '[![MergeStory video preview](https://cdn.example.com/mergestory/v/abc/poster.jpg)]';
    // Signed image links expire, and GitHub's image proxy cannot sign in.
    expect(buildPrComment(sampleComment({ visibility: 'public', linkExpiresAt: null }))).toContain(poster);
    expect(buildPrComment(sampleComment({ visibility: 'unlisted', linkExpiresAt: null }))).toContain(poster);
    expect(buildPrComment(sampleComment({ visibility: 'private' }))).not.toContain('![');
    expect(buildPrComment(sampleComment({ visibility: 'protected', linkExpiresAt: null }))).not.toContain(
      '![',
    );
    expect(buildPrComment(sampleComment({ visibility: 'public', posterUrl: null }))).not.toContain('![');
  });

  describe('footer by link kind', () => {
    const footer = (overrides: Partial<CommentData>): string =>
      buildPrComment(sampleComment(overrides)).split('\n').at(-1) ?? '';

    it('says once that a protected link needs a team sign-in', () => {
      const text = footer({ visibility: 'protected', linkExpiresAt: null });
      expect(text).toBe(
        '<sub>Commit `3f9c2ab`. The video explains the change; it does not replace code review. The link needs a team sign-in.</sub>',
      );
      const whole = buildPrComment(sampleComment({ visibility: 'protected', linkExpiresAt: null }));
      expect(whole.split('team sign-in')).toHaveLength(2);
    });

    it('keeps the expiry date of a private link and does not mention a sign-in', () => {
      const text = footer({ visibility: 'private' });
      expect(text).toContain('The link expires on 2026-11-10 21:45 UTC.');
      expect(text).not.toContain('sign-in');
    });

    it('says that only the owner can watch a private YouTube video', () => {
      const text = footer({ provider: 'youtube', visibility: 'private', linkExpiresAt: null });
      expect(text).toContain('Only the channel owner can watch this video.');
      expect(footer({ provider: 'youtube', visibility: 'unlisted', linkExpiresAt: null })).not.toContain(
        'channel owner',
      );
      expect(footer({ provider: 's3', visibility: 'private' })).not.toContain('channel owner');
    });

    it('says that a Google Drive link opens in Google Drive, and who can open a private one', () => {
      expect(footer({ provider: 'drive', visibility: 'protected', linkExpiresAt: null })).toBe(
        '<sub>Commit `3f9c2ab`. The video explains the change; it does not replace code review. The link needs a team sign-in. Watch on Google Drive.</sub>',
      );
      expect(footer({ provider: 'drive', visibility: 'private', linkExpiresAt: null })).toContain(
        'Watch on Google Drive: only the uploader can open this video.',
      );
      const whole = buildPrComment(
        sampleComment({ provider: 'drive', visibility: 'protected', posterUrl: null }),
      );
      expect(whole).toContain('Watch on Google Drive.');
      expect(whole).not.toContain('preview');
    });

    it('says nothing about expiry or sign-in for a public link', () => {
      const text = footer({ visibility: 'public', linkExpiresAt: null });
      expect(text).not.toContain('expires');
      expect(text).not.toContain('sign-in');
    });

    it('does not promise a sign-in for an unlisted link', () => {
      expect(footer({ visibility: 'unlisted', linkExpiresAt: null })).not.toContain('sign-in');
    });
  });

  it('shows at most five review items, most severe first', () => {
    const severities = ['info', 'low', 'medium', 'high', 'low', 'medium', 'info'] as const;
    const checklist = severities.map((severity, i) => ({
      title: `Item ${i}`,
      detail: '',
      severity,
      ref: null,
    }));
    const lines = buildPrComment(sampleComment({ checklist }))
      .split('\n')
      .filter((l) => l.startsWith('- **'));
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => /\*\*(\w+):/.exec(l)?.[1])).toEqual(['High', 'Medium', 'Medium', 'Low', 'Low']);
  });

  it('shows at most twelve chapters', () => {
    const chapters = Array.from({ length: 20 }, (_, i) => ({ title: `Chapter ${i}`, startSec: i * 5 }));
    const lines = buildPrComment(sampleComment({ chapters })).split('\n');
    expect(lines.filter((l) => /^- `\d+:\d\d`/.test(l))).toHaveLength(12);
    expect(lines).toContain('- and 8 more in the video');
  });

  it('leaves out sections that have nothing to show', () => {
    const bare = buildPrComment(sampleComment({ chapters: [], checklist: [], summary: '' }));
    expect(bare).not.toContain('**Chapters**');
    expect(bare).not.toContain('**What to review**');
  });

  it('encodes characters that would break the link', () => {
    const url = 'https://media.example.com/a(b)c/index.html?x=(1)&y=[2]';
    const out = buildPrComment(sampleComment({ watchUrl: url }));
    expect(out).toContain('(https://media.example.com/a%28b%29c/index.html?x=%281%29&y=%5B2%5D)');
  });

  it('refuses a link that other people cannot open', () => {
    for (const watchUrl of ['file:///tmp/publish/index.html', 'javascript:alert(1)', '', 'index.html']) {
      expect(() => buildPrComment(sampleComment({ watchUrl }))).toThrow(MergeStoryError);
    }
    try {
      buildPrComment(sampleComment({ watchUrl: 'file:///tmp/index.html' }));
    } catch (err) {
      expect((err as MergeStoryError).code).toBe('NOTIFY_FAILED');
    }
  });
});

describe('neutralizeMarkdown', () => {
  const hostile =
    '@octocat @acme/reviewers see #123, GH-45 and owner/repo#9 <script>alert(1)</script> <img src=x onerror=alert(1)> ' +
    '[click](javascript:alert(1)) ![pixel](http://evil.example/p.png) https://evil.example/x www.evil.example ' +
    '<!-- mergestory:comment --> `code` **bold** _it_ ~~gone~~ | cell | mail someone@example.com &#64;ghost &lt;b&gt;';
  const out = neutralizeMarkdown(hostile, 1000);

  it('breaks @mentions with a zero-width space', () => {
    expect(out).toContain('@\u200Boctocat');
    expect(out).toContain('@\u200Bacme/reviewers');
    expect(out).not.toMatch(/@(?!\u200B)/);
  });

  it('breaks issue and pull request references', () => {
    expect(out).not.toMatch(/#\d/);
    expect(out).not.toMatch(/GH-\d/i);
    expect(out).toContain('#\u200B123');
    expect(out).toContain('GH-\u200B45');
  });

  it('removes HTML tags and comments', () => {
    expect(out).not.toContain('<');
    expect(out).not.toContain('<!--');
    expect(out).not.toContain(COMMENT_MARKER);
    expect(out).not.toMatch(/onerror=alert\(1\)>/);
  });

  it('cannot form links or images', () => {
    expect(out).not.toContain('](');
    expect(out).not.toContain('![');
    expect(out).not.toContain('http://');
    expect(out).not.toContain('https://');
    expect(out).not.toMatch(/www\./i);
  });

  it('cannot start emphasis, code, strikethrough, tables or entities', () => {
    expect(out).not.toMatch(/(^|[^\\])[`*_~|]/);
    expect(out).not.toMatch(/(^|[^\\])&#/);
    expect(out).toContain('\\&\\#\u200B64;ghost');
  });

  it('masks e-mail addresses', () => {
    expect(out).not.toContain('someone');
  });

  it('escapes what is left of markup, so generics stay readable', () => {
    expect(neutralizeMarkdown('Map<string, number> and a < b > c', 100)).toBe(
      'Map&lt;string, number&gt; and a &lt; b &gt; c',
    );
  });

  it('keeps plain text as it is', () => {
    expect(neutralizeMarkdown('Retry failed calls with backoff', 100)).toBe(
      'Retry failed calls with backoff',
    );
  });

  it('stops text from opening a list or a heading', () => {
    expect(neutralizeMarkdown('- item', 50)).toBe('\\- item');
    expect(neutralizeMarkdown('+ item', 50)).toBe('\\+ item');
    expect(neutralizeMarkdown('1. item', 50)).toBe('1\\. item');
    expect(neutralizeMarkdown('# heading', 50)).toBe('\\# heading');
    expect(neutralizeMarkdown('> quote', 50)).toBe('&gt; quote');
  });

  it('puts everything on one line and caps the length before escaping', () => {
    expect(neutralizeMarkdown('line one\n\n## line two', 100)).not.toContain('\n');
    expect(neutralizeMarkdown('a'.repeat(1000), 50)).toBe(`${'a'.repeat(49)}…`);
    expect(neutralizeMarkdown('*'.repeat(200), 10)).toBe(`${'\\*'.repeat(9)}…`);
  });

  it('turns other types into an empty string', () => {
    expect(neutralizeMarkdown(undefined, 10)).toBe('');
    expect(neutralizeMarkdown({ a: 1 }, 10)).toBe('');
  });
});

describe('buildPrComment with hostile text', () => {
  const hostile =
    '@octocat #123 <script>alert(1)</script> [x](javascript:alert(1)) <!-- mergestory:comment -->';
  const comment = buildPrComment(
    sampleComment({
      title: hostile,
      summary: hostile,
      chapters: [{ title: hostile, startSec: 3 }],
      checklist: [
        {
          title: hostile,
          detail: hostile,
          severity: 'high',
          ref: { label: `\`${hostile}\``, url: 'javascript:alert(1)' },
        },
      ],
    }),
  );

  // Inline code renders literally and never pings anyone, so it is left out of these checks.
  const outsideCode = comment.replace(/`[^`\n]*`/g, '``');

  it('pings nobody and links to nothing', () => {
    expect(outsideCode).not.toMatch(/@(?!\u200B)/);
    expect(outsideCode).not.toMatch(/#\d/);
    expect(outsideCode).not.toContain('](javascript:');
    expect(outsideCode).not.toMatch(/\]\(\s*javascript/i);
  });

  it('lets no HTML through, except the footer tag the builder writes itself', () => {
    expect(comment).not.toMatch(/<script/i);
    expect(comment.replace(COMMENT_MARKER, '').replace(/<\/?sub>/g, '')).not.toContain('<');
  });

  it('keeps the marker unique', () => {
    expect(comment.split(COMMENT_MARKER)).toHaveLength(2);
  });

  it('keeps a refused file link as plain code text', () => {
    expect(comment).not.toMatch(/\[`[^`]*`\]\(javascript/);
  });

  it('keeps every field short', () => {
    const long = 'x'.repeat(5000);
    const out = buildPrComment(sampleComment({ title: long, summary: long }));
    expect(out.length).toBeLessThan(3000);
  });
});

describe('buildDescriptionSection', () => {
  const section = buildDescriptionSection(sampleComment());
  const lines = section.split('\n');

  it('is wrapped in the description markers with nothing around them', () => {
    expect(lines[0]).toBe(DESCRIPTION_START);
    expect(lines.at(-1)).toBe(DESCRIPTION_END);
    expect(section).toBe(section.trim());
  });

  it('has two to four lines between the markers', () => {
    expect(lines.length - 2).toBeGreaterThanOrEqual(2);
    expect(lines.length - 2).toBeLessThanOrEqual(4);
    expect(buildDescriptionSection(sampleComment({ summary: '' })).split('\n').length - 2).toBe(2);
  });

  it('links to the video and keeps the disclaimer', () => {
    expect(section).toContain(`[Watch the 2-minute MergeStory](${WATCH_URL})`);
    expect(section).toContain('The video explains the change; it does not replace code review.');
    expect(section).toContain('The link expires on 2026-11-10 21:45 UTC.');
  });

  it('neutralises the summary', () => {
    const hostile = buildDescriptionSection(
      sampleComment({ summary: '@octocat <script>x</script> #12 <!-- mergestory:end -->' }),
    );
    expect(hostile).not.toMatch(/@(?!\u200B)/);
    expect(hostile).not.toMatch(/<script/i);
    expect(hostile.split(DESCRIPTION_END)).toHaveLength(2);
    expect(hostile.split(DESCRIPTION_START)).toHaveLength(2);
  });

  it('refuses a link that other people cannot open', () => {
    expect(() => buildDescriptionSection(sampleComment({ watchUrl: 'file:///tmp/index.html' }))).toThrow(
      MergeStoryError,
    );
  });

  it('says that a protected link needs a team sign-in', () => {
    const protectedSection = buildDescriptionSection(
      sampleComment({ visibility: 'protected', linkExpiresAt: null }),
    );
    expect(protectedSection).toContain('The link needs a team sign-in.');
    expect(protectedSection).not.toContain('expires');
    expect(section).not.toContain('sign-in');
  });
});
