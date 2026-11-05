import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import type { AssetUrls } from '../core/providers.ts';
import { pageData } from '../testing/publish.ts';
import type { WatchPageData } from './types.ts';
import { buildWatchPage } from './watch-page.ts';

const ORIGIN = 'https://media.example.com';
const SIGNED: AssetUrls = {
  video: `${ORIGIN}/mergestory/v/abc/video.mp4?X-Amz-Expires=3600&X-Amz-Signature=aa11&x-id=GetObject`,
  poster: `${ORIGIN}/mergestory/v/abc/poster.jpg?X-Amz-Expires=3600&X-Amz-Signature=bb22&x-id=GetObject`,
  captions: `${ORIGIN}/mergestory/v/abc/captions.vtt?X-Amz-Expires=3600&X-Amz-Signature=cc33&x-id=GetObject`,
  linkExpiresAt: '2026-11-10T21:45:01.000Z',
};

const decodeEntities = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function inline(html: string, tag: 'script' | 'style'): string {
  const matches = [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))];
  expect(matches).toHaveLength(1);
  return matches[0]?.[1] ?? '';
}

/** Every start tag of the page. Text from the data is escaped, so only tags the builder wrote can match. */
function startTags(html: string): string[] {
  return html.match(/<[a-zA-Z][^>]*>/g) ?? [];
}

function metaCsp(html: string): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  expect(match).not.toBeNull();
  return decodeEntities(match?.[1] ?? '');
}

describe('buildWatchPage structure', () => {
  const html = buildWatchPage(pageData(), SIGNED);

  it('is a complete HTML document that search engines and referrers ignore', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('<meta name="color-scheme" content="dark light">');
    expect(html).toContain('<title>Add retry with backoff - MergeStory</title>');
  });

  it('follows the system light and dark setting', () => {
    expect(html).toContain('prefers-color-scheme:light');
  });

  it('shows the title, summary, repository and change label', () => {
    expect(html).toContain('<h1>Add retry with backoff</h1>');
    expect(html).toContain('Failed calls are retried up to four times.');
    expect(html).toContain('example/weather');
    expect(html).toContain('PR #482');
    expect(html).toContain('Length 2:08');
    expect(html).toContain('<code>3f9c2ab</code>');
  });

  it('has a player with poster and captions that loads only metadata first', () => {
    expect(html).toMatch(/<video id="v" controls playsinline preload="metadata" poster="[^"]+"/);
    expect(html).toContain(`<source src="${SIGNED.video.replace(/&/g, '&amp;')}" type="video/mp4">`);
    expect(html).toMatch(/<track kind="captions" srclang="en" label="English" src="[^"]+" default>/);
  });

  it('writes asset URLs so that they decode to the exact signed URLs', () => {
    expect(decodeEntities(/poster="([^"]+)"/.exec(html)?.[1] ?? '')).toBe(SIGNED.poster);
    expect(decodeEntities(/<source src="([^"]+)"/.exec(html)?.[1] ?? '')).toBe(SIGNED.video);
    expect(decodeEntities(/<track [^>]*src="([^"]+)"/.exec(html)?.[1] ?? '')).toBe(SIGNED.captions);
  });

  it('lists chapters as keyboard-friendly buttons with start times', () => {
    expect(html).toContain(
      '<button type="button" class="chapter" data-start="0"><span class="t">0:00</span><span>Why this change</span></button>',
    );
    expect(html).toContain('data-start="21"><span class="t">0:21</span>');
    expect(html).toContain('data-start="121"><span class="t">2:01</span>');
  });

  it('puts the most severe review items first, with file links when known', () => {
    const page = buildWatchPage(
      pageData({
        checklist: [
          { title: 'Low one', detail: '', severity: 'low', ref: null },
          {
            title: 'High one',
            detail: 'Details here.',
            severity: 'high',
            ref: {
              label: 'src/a.ts:1-2',
              url: 'https://github.com/example/weather/blob/3f9c/src/a.ts#L1-L2',
            },
          },
          { title: 'Info one', detail: '', severity: 'info', ref: null },
          { title: 'Medium one', detail: '', severity: 'medium', ref: null },
        ],
      }),
      SIGNED,
    );
    const order = ['High one', 'Medium one', 'Low one', 'Info one'].map((t) => page.indexOf(t));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toContain(
      '<a class="chip" href="https://github.com/example/weather/blob/3f9c/src/a.ts#L1-L2" target="_blank" rel="noopener noreferrer">src/a.ts:1-2</a>',
    );
    expect(page).toContain('<span class="sev">High</span>');
    expect(page).toContain('type="checkbox"');
  });

  it('counts the narration lines that cite evidence', () => {
    expect(html).toContain('<strong>3 of 4</strong> narration lines cite evidence from the change.');
    expect(html).toContain('<details><summary>Why this change<span class="count">2 lines</span></summary>');
    expect(html).toContain('<span class="none">No evidence cited</span>');
  });

  it('lists what the video could not confirm', () => {
    expect(html).toContain('What the video could not confirm');
    expect(html).toContain('<li>No benchmark was supplied.</li>');
  });

  it('ends with the footer and the link expiry', () => {
    expect(html).toContain(
      'Made with MergeStory 1.0.0 - every change has a story. The video explains the change; it does not replace code review.',
    );
    expect(html).toContain('This link expires on 2026-11-10 21:45 UTC.');
  });
});

describe('buildWatchPage presentation', () => {
  const html = buildWatchPage(pageData(), SIGNED);

  it('shows how many lines cite evidence as a meter as well as a number', () => {
    expect(html).toContain('<progress class="meter" max="4" value="3" aria-hidden="true"></progress>');
    expect(html).toContain('<strong>3 of 4</strong>');
  });

  it('marks the section about what could not be confirmed as a caution', () => {
    expect(html).toContain('<section class="card warn" aria-labelledby="h-unsure">');
  });

  it('keeps the playing chapter in view inside its own list, without scrolling the page', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(script).toContain('function reveal');
    expect(script).toContain('scrollTop');
    expect(script).not.toContain('scrollIntoView');
    expect(script).not.toMatch(/window\.scroll|scrollTo\(/);
  });

  it('styles the chapters as a strip on narrow screens and as a list beside the video on wide ones', () => {
    const css = inline(html, 'style');
    expect(css).toContain('@media (min-width:980px)');
    expect(css).toContain('@media (max-width:759px)');
    expect(css).toContain('scroll-snap-type');
  });

  it('has a dark and a light palette with readable text on both', () => {
    const css = inline(html, 'style');
    const dark = /:root\{color-scheme:dark light;([^}]*)\}/.exec(css)?.[1] ?? '';
    const light = /@media \(prefers-color-scheme:light\)\{:root\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const colour = (block: string, name: string) =>
      new RegExp(`--${name}:(#[0-9a-fA-F]{6})`).exec(block)?.[1] ?? '';
    const luminance = (hex: string) => {
      const channel = (i: number) => {
        const v = Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return ((hi as number) + 0.05) / ((lo as number) + 0.05);
    };
    expect(dark).toContain('--accent-2:');
    expect(light).toContain('--accent-2:');
    // Body text, muted text, links and the severity colours against the page background, in both palettes.
    for (const [block, bg] of [
      [dark, colour(dark, 'bg')],
      [light, colour(light, 'bg')],
    ] as const) {
      for (const name of ['text', 'text-2', 'muted', 'accent', 'accent-2', 'info', 'low', 'medium', 'high']) {
        expect(contrast(colour(block, name), bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('buildWatchPage options', () => {
  it('shows the expiry that the publisher gives, and none for links that do not expire', () => {
    const data = pageData();
    expect(buildWatchPage(data, { ...SIGNED, linkExpiresAt: '2026-12-01T00:00:00Z' })).toContain(
      'This link expires on 2026-12-01 00:00 UTC.',
    );
    expect(buildWatchPage(data, { ...SIGNED, linkExpiresAt: null })).not.toContain('This link expires');
  });

  it('omits the poster and captions when there are none', () => {
    const page = buildWatchPage(pageData(), { ...SIGNED, poster: null, captions: null });
    expect(page).not.toContain('poster=');
    expect(page).not.toContain('<track');
    expect(metaCsp(page)).toContain("img-src 'none'");
  });

  it('can leave the caption track off until the viewer turns it on', () => {
    expect(buildWatchPage(pageData({ captionsDefault: false }), SIGNED)).toMatch(/<track [^>]*src="[^"]+">/);
    expect(buildWatchPage(pageData({ captionsDefault: false }), SIGNED)).not.toMatch(/<track [^>]*default>/);
  });

  it('labels the caption track with the language of the narration', () => {
    const track = (language?: string) =>
      /<track [^>]*>/.exec(buildWatchPage(pageData({ language }), SIGNED))?.[0] ?? '';
    expect(track()).toContain('srclang="en" label="English"');
    expect(track('de')).toContain('srclang="de" label="German"');
    expect(track('pt-BR')).toContain('srclang="pt-BR"');
    for (const bad of ['', 'e', '"><script>', 'english language', 'xx', 'en-<b>']) {
      expect(track(bad)).toContain('srclang="en" label="English"');
    }
  });

  describe('captions carried by the page', () => {
    const local = { video: 'video.mp4', poster: 'poster.jpg', captions: 'captions.vtt', linkExpiresAt: null };
    const cues = [
      { startSec: 0, endSec: 2.5, text: 'First line.' },
      { startSec: 2.5, endSec: 5, text: 'Second line.' },
    ];
    const withCues = (data: WatchPageData, extra: object = { captionCues: cues }) =>
      buildWatchPage(data, { ...local, ...extra } as typeof local);

    it('puts the cues in the page instead of linking a caption file', () => {
      const page = withCues(pageData());
      expect(page).not.toContain('<track');
      expect(page).toContain(
        '<script type="application/json" id="cues" data-lang="en" data-label="English" data-show="true">[[0,2.5,"First line."],[2.5,5,"Second line."]]</script>',
      );
      expect(page).toContain("video.addTextTrack('captions'");
    });

    it('keeps the cues off until asked when the captions are drawn into the video', () => {
      expect(withCues(pageData({ captionsDefault: false }))).toContain('data-show="false"');
    });

    it('names the language of the cues', () => {
      expect(withCues(pageData({ language: 'de' }))).toContain('data-lang="de" data-label="German"');
    });

    it('cannot be closed or commented out by the text of a cue', () => {
      const hostile = [{ startSec: 0, endSec: 1, text: '</script><script>alert(1)</script><!-- & \u2028' }];
      const page = withCues(pageData(), { captionCues: hostile });
      const block = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
      expect(block).not.toMatch(/[<>&]/);
      expect(JSON.parse(block)[0][2]).toBe(hostile[0]?.text.replace(/\s+/g, ' ').trim());
      expect(page.match(/<script\b/g)).toHaveLength(2);
      expect(page).not.toMatch(/<script>alert/);
    });

    it('drops malformed cues and falls back to the caption file when none are left', () => {
      const bad = [
        { startSec: -1, endSec: 2, text: 'negative' },
        { startSec: 3, endSec: 3, text: 'empty span' },
        { startSec: Number.NaN, endSec: 4, text: 'nan' },
        { startSec: 1, endSec: 2, text: '' },
        { startSec: 1, endSec: 2, text: 42 },
        null,
        'cue',
      ];
      const page = withCues(pageData(), { captionCues: bad });
      expect(page).toContain('<track kind="captions"');
      expect(page).not.toContain('id="cues"');
      expect(withCues(pageData(), { captionCues: [] })).toContain('<track kind="captions"');
      expect(withCues(pageData(), { captionCues: 'nope' })).toContain('<track kind="captions"');
    });

    it('leaves the CSP alone, because the cues are data and not code', () => {
      const page = withCues(pageData());
      expect(metaCsp(page)).not.toContain('unsafe-inline');
      expect(metaCsp(page)).toContain(
        `script-src 'sha256-${createHash('sha256')
          .update(
            inline(page.replace(/<script type="application\/json"[\s\S]*?<\/script>/, ''), 'script'),
            'utf8',
          )
          .digest('base64')}'`,
      );
    });

    it('does nothing without a caption file', () => {
      const urls: AssetUrls = {
        video: 'video.mp4',
        poster: null,
        captions: null,
        linkExpiresAt: null,
        captionCues: cues,
      };
      const page = buildWatchPage(pageData(), urls);
      expect(page).not.toContain('id="cues"');
      expect(page).not.toContain('<track');
    });
  });

  it('works with relative file names for a local copy', () => {
    const page = buildWatchPage(pageData(), {
      video: 'video.mp4',
      poster: 'poster.jpg',
      captions: 'captions.vtt',
      linkExpiresAt: null,
    });
    expect(page).toContain('<source src="video.mp4" type="video/mp4">');
    expect(page).toContain('poster="poster.jpg"');
    expect(page).toContain('src="captions.vtt"');
    expect(metaCsp(page)).toContain("media-src 'self'");
    expect(metaCsp(page)).toContain("img-src 'self'");
  });

  it('shows the chapters section only when there are chapters', () => {
    const none = buildWatchPage(pageData({ chapters: [] }), SIGNED);
    expect(none).not.toContain('class="card chapters"');
    expect(none).toContain('<div class="stage"><div>');
    expect(buildWatchPage(pageData(), SIGNED)).toContain('<div class="stage has-chapters"><div>');
  });

  it('sorts chapters by start time and names unnamed ones', () => {
    const page = buildWatchPage(
      pageData({
        chapters: [
          { title: 'Second', startSec: 30 },
          { title: '', startSec: 10 },
        ],
      }),
      SIGNED,
    );
    expect(page.indexOf('Chapter 1')).toBeGreaterThan(-1);
    expect(page.indexOf('Chapter 1')).toBeLessThan(page.indexOf('Second'));
  });

  it('mentions simulated visuals only when the video has them', () => {
    expect(buildWatchPage(pageData({ hasSimulatedVisuals: true }), SIGNED)).toContain(
      'Some visuals are simulated.',
    );
    expect(buildWatchPage(pageData({ hasSimulatedVisuals: false }), SIGNED)).not.toContain('simulated');
  });

  it('says how the storyboard and the voice were made', () => {
    const llm = buildWatchPage(pageData(), SIGNED);
    expect(llm).toContain('Written by the language model example-model-1.');
    expect(llm).toContain('Kokoro (local)');
    expect(
      buildWatchPage(pageData({ generator: { llm: null, tts: 'openai' }, storyboardSource: 'llm' }), SIGNED),
    ).toContain('Written by a language model.');
    expect(buildWatchPage(pageData({ storyboardSource: 'agent' }), SIGNED)).toContain(
      'Written by a coding agent.',
    );
    const heuristic = buildWatchPage(
      pageData({ storyboardSource: 'heuristic', generator: { llm: null, tts: 'none' } }),
      SIGNED,
    );
    expect(heuristic).toContain('Built offline from the diff, without a language model.');
    expect(heuristic).toContain('No narration (silent video)');
  });

  it('says so when no narration lines are listed', () => {
    const page = buildWatchPage(pageData({ claims: [] }), SIGNED);
    expect(page).toContain('The narration lines and their evidence are not listed for this video.');
    expect(page).not.toContain('narration lines cite');
  });

  it('says so when nothing was flagged for review', () => {
    expect(buildWatchPage(pageData({ checklist: [] }), SIGNED)).toContain(
      'MergeStory did not flag anything specific.',
    );
  });

  it('caps very long lists and says how many lines are hidden', () => {
    const claims = Array.from({ length: 450 }, (_, i) => ({
      chapter: 'Big chapter',
      text: `Line ${i}`,
      evidence: [{ label: 'F1', url: null }],
    }));
    const page = buildWatchPage(pageData({ claims }), SIGNED);
    expect(page).toContain('<strong>450 of 450</strong>');
    expect(page).toContain('50 more lines are not shown.');
    expect(page).toContain('Line 399');
    expect(page).not.toContain('Line 400<');
  });

  it('refuses asset URLs that are not http(s) URLs or plain file names', () => {
    for (const video of [
      'javascript:alert(1)',
      'data:video/mp4;base64,AAAA',
      '//evil.example/v.mp4',
      '../v.mp4',
      '',
    ]) {
      expect(() => buildWatchPage(pageData(), { ...SIGNED, video, poster: null, captions: null })).toThrow(
        MergeStoryError,
      );
    }
    expect(() =>
      buildWatchPage(pageData(), { ...SIGNED, poster: 'javascript:alert(1)', captions: null }),
    ).toThrow(/invalid poster URL/);
    expect(() =>
      buildWatchPage(pageData(), { ...SIGNED, poster: null, captions: 'data:text/vtt,WEBVTT' }),
    ).toThrow(/invalid captions URL/);
  });
});

describe('buildWatchPage is self-contained', () => {
  const html = buildWatchPage(pageData(), SIGNED);

  it('only mentions URLs of the assets it was given', () => {
    const found = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => decodeEntities(m[0]));
    expect(found.length).toBeGreaterThan(0);
    for (const url of found) expect(url.startsWith(ORIGIN)).toBe(true);
  });

  it('loads nothing from anywhere else', () => {
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/@import|url\((?!#)/i);
    expect(html).not.toMatch(
      /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|eval\(|localStorage|document\.cookie/,
    );
  });

  it('has exactly one inline script and one inline style', () => {
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html.match(/<style\b/g)).toHaveLength(1);
    expect(startTags(html).filter((tag) => /\sstyle=|\son[a-z]+=/i.test(tag))).toEqual([]);
  });

  it('has a content security policy that only allows the asset origin and its own inline code', () => {
    const csp = metaCsp(html);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`media-src ${ORIGIN}`);
    expect(csp).toContain(`img-src ${ORIGIN}`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/\*/);
  });

  it('pins the inline style and script by hash', () => {
    const csp = metaCsp(html);
    const hash = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
    expect(csp).toContain(`style-src ${hash(inline(html, 'style'))}`);
    expect(csp).toContain(`script-src ${hash(inline(html, 'script'))}`);
  });

  it('produces the same page for the same input', () => {
    expect(buildWatchPage(pageData(), SIGNED)).toBe(html);
  });

  it('does not allow origins of links that point elsewhere', () => {
    const page = buildWatchPage(
      pageData({
        changeUrl: 'https://github.com/example/weather/pull/482',
        checklist: [
          {
            title: 'x',
            detail: '',
            severity: 'low',
            ref: { label: 'a.ts', url: 'https://github.com/example/weather/blob/1/a.ts' },
          },
        ],
      }),
      SIGNED,
    );
    expect(page).toContain(
      'href="https://github.com/example/weather/pull/482" target="_blank" rel="noopener noreferrer"',
    );
    expect(metaCsp(page)).not.toContain('github.com');
  });
});

describe('buildWatchPage treats its text as hostile', () => {
  const evil = '<script>alert(1)</script>';
  const data = pageData({
    title: `Fix ${evil} bug`,
    summary: `<img src=x onerror=alert(1)> "quoted" & 'single'`,
    repoLabel: `acme/<b>forecast</b>`,
    changeLabel: `PR #1 <iframe src=//evil.example>`,
    changeUrl: 'javascript:alert(document.domain)',
    chapters: [{ title: `</button><script>alert(2)</script>`, startSec: 5 }],
    checklist: [
      {
        title: `"><svg onload=alert(3)>`,
        detail: `<a href="javascript:alert(4)">click</a>`,
        severity: '"><script>alert(5)</script>' as 'high',
        ref: { label: `<img src=x onerror=alert(6)>`, url: 'javascript:alert(7)' },
      },
    ],
    claims: [
      {
        chapter: `</summary><script>alert(8)</script>`,
        text: `" onmouseover="alert(9)`,
        evidence: [
          { label: `<script>alert(10)</script>`, url: 'data:text/html,<script>alert(11)</script>' },
          { label: 'ok.ts', url: 'https://user:secret@evil.example/x' },
          { label: 'again.ts', url: '//evil.example/y' },
        ],
      },
    ],
    uncertainties: [`<script>alert(12)</script>`],
    generator: { llm: `<script>alert(13)</script>`, tts: `<script>alert(14)</script>` },
    engineVersion: `<script>alert(15)</script>`,
    generatedAt: `<script>alert(16)</script>`,
    headSha: `<script>alert(18)</script>`,
  });
  const html = buildWatchPage(data, { ...SIGNED, linkExpiresAt: `<script>alert(17)</script>` });

  it('never lets markup from the data through', () => {
    expect(html).not.toMatch(/<script>alert/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<svg onload/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<b>forecast/i);
    expect(html).not.toContain('</button><script>');
    expect(html.match(/<script\b/g)).toHaveLength(1);
  });

  it('shows the text in escaped form', () => {
    expect(html).toContain('Fix &lt;script&gt;alert(1)&lt;/script&gt; bug');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; &#39;single&#39;');
  });

  it('never creates an attribute or an event handler from the data', () => {
    expect(startTags(html).filter((tag) => /\sstyle=|\son[a-z]+=/i.test(tag))).toEqual([]);
    expect(startTags(html).some((tag) => /onmouseover|onerror|onload/i.test(tag))).toBe(false);
  });

  it('only links to validated http(s) URLs', () => {
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/href="data:/i);
    expect(html).not.toContain('evil.example/x');
    expect(html).not.toContain('secret@');
    expect(html).not.toContain('//evil.example/y');
    // The label of a link that was refused stays on the page as plain text.
    expect(html).toContain('<span class="chip">ok.ts</span>');
    expect(html).toContain('<span class="chip">again.ts</span>');
  });

  it('ignores unknown severities and invalid dates', () => {
    expect(html).toContain('class="check sev-info"');
    expect(html).not.toContain('This link expires');
    expect(html).not.toContain('<dt>Generated</dt>');
    expect(html).not.toContain('<dt>Commit</dt>');
  });

  it('removes characters that disguise text', () => {
    const page = buildWatchPage(pageData({ title: 'evil\u202Etxt.exe\u200B' }), SIGNED);
    expect(page).toContain('<h1>eviltxt.exe</h1>');
  });

  it('cuts overlong text', () => {
    const page = buildWatchPage(pageData({ title: 'T'.repeat(5000), summary: 'S'.repeat(5000) }), SIGNED);
    expect(page).toContain(`<h1>${'T'.repeat(199)}…</h1>`);
    expect(page.length).toBeLessThan(60_000);
  });

  it('survives data of the wrong type', () => {
    const broken = {
      ...pageData(),
      chapters: null,
      checklist: 'no',
      claims: undefined,
      uncertainties: 7,
    } as unknown as WatchPageData;
    expect(() => buildWatchPage(broken, SIGNED)).not.toThrow();
  });
});
