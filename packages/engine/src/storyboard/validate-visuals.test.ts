import { describe, expect, it } from 'vitest';
import { retryFixture } from '../testing/storyboard-fixtures.ts';
import { baseStoryboard, codes, type Json, run, scene } from '../testing/validate.ts';

describe('architecture and flow', () => {
  it('drops edges and steps that point at ids that do not exist', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual = {
      type: 'architecture',
      direction: 'LR',
      nodes: [
        {
          id: 'a',
          label: 'http',
          detail: null,
          kind: 'module',
          status: 'modified',
          beat: 0,
          evidence: [fx.id.component('http')],
        },
        {
          id: 'b',
          label: 'tests',
          detail: null,
          kind: 'test',
          status: 'added',
          beat: 1,
          evidence: [fx.id.component('tests')],
        },
      ],
      edges: [
        { from: 'b', to: 'a', label: 'tests', status: 'unchanged', beat: 1 },
        { from: 'a', to: 'ghost', label: null, status: 'unchanged', beat: 1 },
      ],
    };
    scene(sb, 2).visual = {
      type: 'flow',
      actors: [
        { id: 'client', label: 'ApiClient', kind: 'module' },
        { id: 'retry', label: 'retry helper', kind: 'module' },
      ],
      steps: [
        {
          from: 'client',
          to: 'retry',
          label: 'calls',
          detail: null,
          kind: 'call',
          beat: 0,
          evidence: [fx.id.hunk('src/http/client.ts', 2)],
        },
        {
          from: 'retry',
          to: 'server',
          label: 'sends',
          detail: null,
          kind: 'request',
          beat: 1,
          evidence: [fx.id.hunk('src/http/retry.ts')],
        },
      ],
    };
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const architecture = result.storyboard!.scenes[1]!.visual;
    expect(architecture.type === 'architecture' && architecture.edges).toHaveLength(1);
    const flow = result.storyboard!.scenes[2]!.visual;
    expect(flow.type === 'flow' && flow.steps).toHaveLength(1);
    expect(result.fixes.some((f) => f.includes('"a" -> "ghost"'))).toBe(true);
  });

  it('shows the changed-files overview when a flow has nothing left', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'flow',
      actors: [{ id: 'a', label: 'ApiClient', kind: 'module' }],
      steps: [
        {
          from: 'a',
          to: 'b',
          label: 'calls',
          detail: null,
          kind: 'call',
          beat: 0,
          evidence: [fx.id.hunk('src/http/retry.ts')],
        },
      ],
    };
    const result = await run(sb, fx);
    expect(result.storyboard!.scenes[2]!.visual.type).toBe('files');
    expect(codes(result.warnings)).toContain('visual-fallback');
  });

  it('drops highlighted paths that are not changed files that can be shown', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'files',
      highlightPaths: ['src/http/retry.ts', 'src/missing.ts', '.env'],
      caption: null,
    };
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'files' && visual.highlightPaths).toEqual(['src/http/retry.ts']);
  });
});

describe('screenshots', () => {
  it('rejects a screenshot id that was not supplied, and lists the ones that were', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = { type: 'screenshot', screenshotId: 'SS9', caption: null };
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    const issue = result.errors.find((e) => e.code === 'screenshot-unknown')!;
    expect(issue.path).toBe('scenes[2].visual.screenshotId');
    expect(issue.message).toContain('SS1');
  });

  it('accepts a supplied screenshot', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = { type: 'screenshot', screenshotId: 'SS1', caption: 'The forecast page' };
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
  });

  it('turns a screenshot panel with an unknown id into a bullets panel', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'before-after',
      before: {
        label: 'Before',
        kind: 'screenshot',
        codeRef: null,
        bullets: ['Requests fail on a server error.'],
        terminal: [],
        screenshotId: 'SS9',
      },
      after: {
        label: 'After',
        kind: 'screenshot',
        codeRef: null,
        bullets: ['Requests are retried.'],
        terminal: [],
        screenshotId: 'SS1',
      },
      caption: null,
    };
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'before-after' && [visual.before.kind, visual.after.kind]).toEqual([
      'bullets',
      'screenshot',
    ]);
    expect(codes(result.warnings)).toContain('screenshot-unknown');
  });
});

describe('recordings', () => {
  const recording = (durationSec: number) => ({
    id: 'RC1',
    path: '/nonexistent/flow.mp4',
    caption: 'Checkout flow',
    moment: 'after' as const,
    durationSec,
    width: 1280,
    height: 720,
    codec: 'h264',
  });
  const visual = (extra: Json = {}): Json => ({
    type: 'recording',
    recordingId: 'RC1',
    caption: null,
    trim: null,
    speed: null,
    zoom: null,
    ...extra,
  });
  /** Validate a recording visual on a 12.5 s clip, then validate the accepted result again. */
  async function check(extra: Json, durationSec = 12.5) {
    const fx = retryFixture({ inputs: { recordings: [recording(durationSec)] } });
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = visual(extra);
    const result = await run(sb, fx);
    if (result.storyboard) {
      const again = await run(result.storyboard, fx);
      expect(again.fixes).toEqual([]);
      expect(again.warnings).toEqual([]);
      expect(again.storyboard).toEqual(result.storyboard);
    }
    const shown = result.storyboard?.scenes[2]?.visual;
    return { result, shown: shown?.type === 'recording' ? shown : null };
  }
  const panel = (kind: string, recordingId: string | null) => ({
    label: 'After',
    kind,
    codeRef: null,
    bullets: ['Requests are retried.'],
    terminal: [],
    screenshotId: null,
    recordingId,
  });

  it('accepts a supplied recording as it is, with no fix', async () => {
    const { result, shown } = await check({
      trim: { start: 1, end: 5 },
      speed: 2,
      zoom: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(result.errors).toEqual([]);
    expect(result.fixes).toEqual([]);
    expect(shown?.trim).toEqual({ start: 1, end: 5 });
  });

  it('rejects an id that was not supplied, and lists the ones that were', async () => {
    const { result } = await check({ recordingId: 'RC9' });
    expect(result.storyboard).toBeNull();
    const issue = result.errors.find((e) => e.code === 'recording-unknown')!;
    expect(issue.path).toBe('scenes[2].visual.recordingId');
    expect(issue.message).toContain('RC1');
    const none = retryFixture();
    const sb = baseStoryboard(none);
    scene(sb, 2).visual = visual();
    expect((await run(sb, none)).errors[0]?.message).toContain('no recordings were supplied');
  });

  it('turns a recording panel with an unknown id into a bullets panel', async () => {
    const fx = retryFixture({ inputs: { recordings: [recording(12.5)] } });
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'before-after',
      before: panel('recording', 'RC9'),
      after: panel('recording', 'RC1'),
      caption: null,
    };
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const shown = result.storyboard!.scenes[2]!.visual;
    expect(shown.type === 'before-after' && [shown.before.kind, shown.after.kind]).toEqual([
      'bullets',
      'recording',
    ]);
    expect(codes(result.warnings)).toContain('recording-unknown');
    const again = await run(result.storyboard, fx);
    expect(again.fixes).toEqual([]);
  });

  it('puts a trim in order, and cuts the part that lies outside the clip', async () => {
    const swapped = await check({ trim: { start: 8, end: 3 } });
    expect(swapped.shown?.trim).toEqual({ start: 3, end: 8 });
    expect(swapped.result.warnings).toEqual([]);
    expect(swapped.result.fixes).toHaveLength(1);

    const partly = await check({ trim: { start: -2, end: 20 } });
    expect(partly.shown?.trim).toEqual({ start: 0, end: 12.5 });
    expect(codes(partly.result.warnings)).toEqual(['recording-trim-out-of-range']);
    expect(partly.result.fixes).toHaveLength(1);
  });

  it('refuses a trim with nothing of the clip inside it', async () => {
    for (const trim of [
      { start: 13, end: 20 },
      { start: -5, end: -1 },
      { start: 12.4, end: 30 },
    ]) {
      const { result } = await check({ trim });
      expect(result.storyboard).toBeNull();
      expect(codes(result.errors)).toEqual(['recording-trim-out-of-range']);
      expect(result.errors[0]?.path).toBe('scenes[2].visual.trim');
    }
  });

  it('shortens a window longer than the clip limit from its end', async () => {
    const limit = retryFixture().config.inputs.maxClipSeconds;
    const trimmed = await check({ trim: { start: 5, end: 50 } }, 60);
    expect(trimmed.shown?.trim).toEqual({ start: 5, end: 5 + limit });
    expect(codes(trimmed.result.warnings)).toEqual(['recording-too-long']);
    expect(trimmed.result.fixes).toHaveLength(1);

    // No trim at all: the whole clip is too long, so a trim from its start is written.
    const whole = await check({}, 60);
    expect(whole.shown?.trim).toEqual({ start: 0, end: limit });
    expect(codes(whole.result.warnings)).toEqual(['recording-too-long']);

    // A fractional start does not make the repaired window too long again.
    const fractional = await check({ trim: { start: 0.1, end: 40 } }, 60);
    expect(fractional.shown?.trim?.start).toBe(0.1);
  });

  it('puts speed and zoom into their ranges, with a fix and no code', async () => {
    const { result, shown } = await check({ speed: 9, zoom: { x: 0.8, y: -1, w: 0.5, h: 0 } });
    expect(shown?.speed).toBe(4);
    expect(shown?.zoom).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.05 });
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toHaveLength(2);
    expect((await check({ speed: 0.1 })).shown?.speed).toBe(0.5);
  });

  it('cleans the caption like a screenshot caption', async () => {
    const { shown } = await check({ caption: 'See https://phish.attacker.dev/x' });
    expect(shown?.caption).toBeNull();
  });
});

describe('highlights and focus', () => {
  const box = (extra: Json = {}): Json => ({
    x: 0.1,
    y: 0.2,
    w: 0.3,
    h: 0.2,
    label: null,
    beat: 0,
    ...extra,
  });
  const recording = {
    id: 'RC1',
    path: '/nonexistent/flow.mp4',
    caption: 'Checkout flow',
    moment: 'after' as const,
    durationSec: 10,
    width: 1280,
    height: 720,
    codec: 'h264',
  };
  const panel = (kind: string, extra: Json = {}): Json => ({
    label: 'After',
    kind,
    codeRef: null,
    bullets: ['Requests are retried.'],
    terminal: [],
    screenshotId: kind === 'screenshot' ? 'SS1' : null,
    recordingId: null,
    ...extra,
  });

  /** Validate a visual in scene 2, then the accepted result again: a repair must not need a second repair. */
  async function check(visual: Json, config: Json = {}) {
    const fx = retryFixture({
      config,
      inputs: {
        recordings: [recording],
        screenshots: [{ id: 'SS1', path: '/nonexistent/page.png', caption: 'The page', moment: 'after' }],
      },
    });
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = visual;
    const result = await run(sb, fx);
    if (result.storyboard) {
      const again = await run(result.storyboard, fx);
      expect(again.fixes).toEqual([]);
      expect(again.warnings).toEqual([]);
      expect(again.storyboard).toEqual(result.storyboard);
    }
    return { result, shown: result.storyboard?.scenes[2]?.visual as Json | undefined };
  }
  const screenshot = (extra: Json = {}): Json => ({
    type: 'screenshot',
    screenshotId: 'SS1',
    caption: null,
    ...extra,
  });
  const beforeAfter = (before: Json, after: Json): Json => ({
    type: 'before-after',
    before,
    after,
    caption: null,
  });

  it('accepts boxes and a focus that lie inside the picture, with no fix', async () => {
    const { result, shown } = await check(
      screenshot({
        highlights: [box({ label: 'The count', beat: 1 }), box({ x: 0.7, w: 0.3 })],
        focus: { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toEqual([]);
    expect(shown?.highlights).toHaveLength(2);
    expect(shown?.highlights[0].label).toBe('The count');
  });

  it('keeps the first four boxes of a screenshot and of a recording, and says so', async () => {
    const five = Array.from({ length: 5 }, (_, i) => box({ x: i / 10, label: `Box ${i}` }));
    for (const visual of [
      screenshot({ highlights: five }),
      {
        type: 'recording',
        recordingId: 'RC1',
        caption: null,
        trim: null,
        speed: null,
        zoom: null,
        highlights: five,
      },
    ]) {
      const { result, shown } = await check(visual);
      expect(shown?.highlights.map((h: Json) => h.label)).toEqual(['Box 0', 'Box 1', 'Box 2', 'Box 3']);
      expect(result.fixes).toEqual([
        'scenes[2].visual.highlights: kept the first 4 of 5 highlights (the limit is 4)',
      ]);
      expect(result.warnings).toEqual([]);
    }
  });

  it('moves a box inside the picture: sides first, then the corner', async () => {
    const { result, shown } = await check(
      screenshot({
        highlights: [
          box({ x: 0.9, y: 0.95, w: 0.3, h: 0.2 }),
          box({ x: -0.5, y: -1, w: 0, h: -3 }),
          box({ x: 0, y: 0, w: 4, h: 1 }),
        ],
      }),
    );
    expect(shown?.highlights.map(({ x, y, w, h }: Json) => ({ x, y, w, h }))).toEqual([
      { x: 0.7, y: 0.8, w: 0.3, h: 0.2 },
      { x: 0, y: 0, w: 0.02, h: 0.02 },
      { x: 0, y: 0, w: 1, h: 1 },
    ]);
    const moved = 'moved the highlight inside the picture (x, y, w and h are fractions from 0 to 1)';
    expect(result.fixes).toEqual([
      `scenes[2].visual.highlights[0]: ${moved}`,
      `scenes[2].visual.highlights[1]: ${moved} and made it at least 0.02 of the picture wide and high`,
      `scenes[2].visual.highlights[2]: ${moved}`,
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('moves a focus inside the picture and makes it at least a fifth of each side', async () => {
    const { result, shown } = await check(screenshot({ focus: { x: 0.9, y: -2, w: 0.5, h: 0.01 } }));
    expect(shown?.focus).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.2 });
    expect(result.fixes).toEqual([
      'scenes[2].visual.focus: moved the focus inside the picture (x, y, w and h are fractions from 0 to 1) and made it at least 0.2 of the picture wide and high',
    ]);
    expect(result.warnings).toEqual([]);
    const recorded = await check({
      type: 'recording',
      recordingId: 'RC1',
      caption: null,
      trim: null,
      speed: null,
      zoom: null,
      focus: { x: 0.5, y: 0.5, w: 0.75, h: 0.75 },
    });
    expect(recorded.shown?.focus).toEqual({ x: 0.25, y: 0.25, w: 0.75, h: 0.75 });
  });

  it('leaves a box or a focus that ends exactly on the right or bottom edge as it is, with no fix', async () => {
    // 1 - 0.8 is not exactly 0.2 in floating point: a rounding error is not a move.
    const edge = { x: 0.2, y: 0.1, w: 0.8, h: 0.9 };
    const { result, shown } = await check(
      screenshot({ highlights: [box(edge), box({ x: 0.1, y: 0.07, w: 0.9, h: 0.93 })], focus: edge }),
    );
    expect(result.fixes).toEqual([]);
    expect(shown?.highlights[0]).toMatchObject(edge);
    expect(shown?.highlights[1]).toMatchObject({ x: 0.1, y: 0.07, w: 0.9, h: 0.93 });
    expect(shown?.focus).toEqual(edge);
    // A box that is really outside is still moved.
    const outside = await check(screenshot({ focus: { x: 0.3, y: 0.1, w: 0.8, h: 0.9 } }));
    expect(outside.shown?.focus.x).toBeCloseTo(0.2);
    expect(outside.result.fixes).toHaveLength(1);
  });

  it('says that a side was raised when nothing moved and nothing was outside', async () => {
    const { result, shown } = await check(
      screenshot({
        highlights: [box({ x: 0.1, y: 0.1, w: 0.01, h: 0.01 })],
        focus: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      }),
    );
    expect(shown?.highlights[0]).toMatchObject({ x: 0.1, y: 0.1, w: 0.02, h: 0.02 });
    expect(result.fixes).toEqual([
      'scenes[2].visual.highlights[0]: made the highlight at least 0.02 of the picture wide and high',
      'scenes[2].visual.focus: made the focus at least 0.2 of the picture wide and high',
    ]);
  });

  it('cuts a label by whole characters, so no emoji is cut in half and the limit counts characters', async () => {
    const letters = 'a'.repeat(38);
    const emoji = '\u{1F600}'.repeat(3);
    const cut = await check(screenshot({ highlights: [box({ label: `${letters}${emoji}` })] }));
    const label = cut.shown?.highlights[0].label as string;
    expect(label).toBe(`${letters}\u{1F600}…`);
    expect(label).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    // 25 emoji are 25 characters: no warning, no cut.
    const many = '\u{1F600}'.repeat(25);
    const kept = await check(screenshot({ highlights: [box({ label: many })] }));
    expect(kept.shown?.highlights[0].label).toBe(many);
    expect(kept.result.warnings).toEqual([]);
  });

  it('never shortens a label to just the ellipsis', async () => {
    for (const label of [`   ${'x'.repeat(60)}`, `a ${'x'.repeat(60)}`]) {
      const { shown } = await check(screenshot({ highlights: [box({ label })] }));
      const result = shown?.highlights[0].label as string;
      expect(result.length).toBeGreaterThan(2);
      expect(result.endsWith('…')).toBe(true);
    }
  });

  it('cleans a label like a caption: a web address goes, and a label with nothing left is null', async () => {
    const { shown } = await check(
      screenshot({
        highlights: [
          box({ label: 'See https://phish.attacker.dev/x' }),
          box({ label: '   ' }),
          box({ label: 'The count' }),
        ],
      }),
    );
    expect(shown?.highlights.map((h: Json) => h.label)).toEqual([null, null, 'The count']);
  });

  it('shortens a label of more than 40 characters at a word, with a warning and a fix', async () => {
    const label = 'The item count is wrong after the second removal';
    const { result, shown } = await check(screenshot({ highlights: [box({ label })] }));
    const shortened = shown?.highlights[0].label as string;
    expect(shortened).toBe('The item count is wrong after the…');
    expect(shortened.length).toBeLessThanOrEqual(40);
    expect(codes(result.warnings)).toEqual(['highlight-label-too-long']);
    expect(result.warnings[0]?.path).toBe('scenes[2].visual.highlights[0].label');
    expect(result.fixes).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('cuts a long label on the 40th character when it has no space to cut at, and keeps a 40 character label', async () => {
    const word = 'x'.repeat(60);
    const cut = await check(screenshot({ highlights: [box({ label: word })] }));
    expect(cut.shown?.highlights[0].label).toBe(`${'x'.repeat(39)}…`);
    const exact = 'a'.repeat(39) + 'b';
    const kept = await check(screenshot({ highlights: [box({ label: exact })] }));
    expect(kept.shown?.highlights[0].label).toBe(exact);
    expect(kept.result.warnings).toEqual([]);
    // A space right after the 39th character: the cut falls there and keeps the whole last word.
    const edge = `${'a'.repeat(10)} ${'b'.repeat(28)} ccc`;
    const edged = await check(screenshot({ highlights: [box({ label: edge })] }));
    expect(edged.shown?.highlights[0].label).toBe(`${'a'.repeat(10)} ${'b'.repeat(28)}…`);
  });

  it('puts the beat of a box into the narration of its scene', async () => {
    const { result, shown } = await check(screenshot({ highlights: [box({ beat: 7 })] }));
    expect(shown?.highlights[0].beat).toBe(1);
    expect(result.fixes).toEqual([
      'scenes[2].visual: 1 beat index pointed outside the 2 narration lines and was clamped',
    ]);
  });

  it('draws the boxes of a screenshot panel and moves them inside', async () => {
    const { result, shown } = await check(
      beforeAfter(
        panel('screenshot', { highlights: [box({ x: 0.95 })] }),
        panel('screenshot', { highlights: [box({ label: 'The count' })] }),
      ),
    );
    expect(shown?.before.highlights[0].x).toBe(0.7);
    expect(shown?.after.highlights[0].label).toBe('The count');
    expect(result.fixes).toHaveLength(1);
    expect(result.fixes[0]).toContain('scenes[2].visual.before.highlights[0]');
  });

  it('removes the boxes of a panel that does not show a screenshot', async () => {
    const { result, shown } = await check(
      beforeAfter(panel('bullets', { highlights: [box()] }), panel('screenshot', { highlights: [box()] })),
    );
    expect(shown?.before.highlights).toEqual([]);
    expect(shown?.after.highlights).toHaveLength(1);
    expect(result.fixes).toEqual([
      'scenes[2].visual.before: removed the highlights of a panel that does not show a screenshot',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('removes the boxes of a screenshot panel that turns into a bullets panel', async () => {
    const { result, shown } = await check(
      beforeAfter(
        panel('screenshot', { screenshotId: 'SS9', highlights: [box()] }),
        panel('screenshot', { highlights: [box()] }),
      ),
    );
    expect(shown?.before.kind).toBe('bullets');
    expect(shown?.before.highlights).toEqual([]);
    expect(codes(result.warnings)).toEqual(['screenshot-unknown']);
  });

  it('keeps the first four boxes of a panel', async () => {
    const five = Array.from({ length: 5 }, (_, i) => box({ x: i / 10 }));
    const { result, shown } = await check(
      beforeAfter(panel('screenshot', { highlights: five }), panel('screenshot')),
    );
    expect(shown?.before.highlights).toHaveLength(4);
    expect(result.fixes).toEqual([
      'scenes[2].visual.before.highlights: kept the first 4 of 5 highlights (the limit is 4)',
    ]);
  });

  it('repairs a box and a long label of a recording', async () => {
    const { result, shown } = await check({
      type: 'recording',
      recordingId: 'RC1',
      caption: null,
      trim: null,
      speed: null,
      zoom: null,
      highlights: [box({ x: 1.5, label: 'The item count is wrong after the second removal' })],
    });
    expect(shown?.highlights[0].x).toBe(0.7);
    expect(shown?.highlights[0].label).toBe('The item count is wrong after the…');
    expect(codes(result.warnings)).toEqual(['highlight-label-too-long']);
    expect(result.fixes).toHaveLength(2);
  });

  it('cleans the label of a screenshot panel and shortens a long one', async () => {
    const { result, shown } = await check(
      beforeAfter(
        panel('screenshot', { highlights: [box({ label: 'See https://phish.attacker.dev/x' })] }),
        panel('screenshot', {
          highlights: [box({ label: 'The item count is wrong after the second removal' })],
        }),
      ),
    );
    expect(shown?.before.highlights[0].label).toBeNull();
    expect(shown?.after.highlights[0].label).toBe('The item count is wrong after the…');
    expect(result.warnings.map((w) => w.path)).toContain('scenes[2].visual.after.highlights[0].label');
    expect(codes(result.warnings)).toContain('highlight-label-too-long');
  });

  it('removes the boxes of a recording, terminal and code panel', async () => {
    for (const kind of ['recording', 'terminal', 'code']) {
      const { result, shown } = await check(
        beforeAfter(
          panel(kind, {
            highlights: [box()],
            recordingId: kind === 'recording' ? 'RC1' : null,
            terminal: kind === 'terminal' ? [{ kind: 'output', text: 'Retrying after 200 ms', beat: 0 }] : [],
            codeRef:
              kind === 'code' ? { path: 'src/http/retry.ts', side: 'head', startLine: 1, endLine: 5 } : null,
          }),
          panel('screenshot'),
        ),
      );
      expect(result.errors).toEqual([]);
      expect(shown?.before.highlights).toEqual([]);
      expect(result.fixes).toContain(
        'scenes[2].visual.before: removed the highlights of a panel that does not show a screenshot',
      );
    }
  });

  it('masks a secret and an e-mail address in a label, and keeps the address when masking it is off', async () => {
    const secret = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const visual = (): Json =>
      screenshot({
        highlights: [box({ label: `Key ${secret}` }), box({ x: 0.5, label: 'Mail jane.doe@example.com' })],
      });
    const masked = await check(visual());
    const [key, mail] = masked.shown?.highlights.map((h: Json) => h.label as string) ?? [];
    expect(key).not.toContain(secret);
    expect(mail).not.toContain('jane.doe');
    const open = await check(visual(), { privacy: { maskEmails: false } });
    const [openKey, openMail] = open.shown?.highlights.map((h: Json) => h.label as string) ?? [];
    expect(openKey).not.toContain(secret);
    expect(openMail).toContain('jane.doe@example.com');
  });
});

describe('reproduction', () => {
  const repro = (steps = 8) => ({
    title: 'Basket count',
    environment: 'Chrome',
    steps: Array.from({ length: steps }, (_, i) => ({
      text: `Step ${i + 1}`,
      screenshotId: null,
      recordingId: null,
      result: null,
    })),
  });
  const visual = (...steps: [number, number?][]): Json => ({
    type: 'repro',
    steps: steps.map(([step, beat = 0]) => ({ step, beat })),
  });
  /** Validate a repro visual over a reproduction of `count` steps, then validate the accepted result again. */
  async function check(shown: Json, count = 8) {
    const fx = retryFixture({ inputs: { repro: repro(count) } });
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = shown;
    const result = await run(sb, fx);
    if (result.storyboard) {
      const again = await run(result.storyboard, fx);
      expect(again.fixes).toEqual([]);
      expect(again.warnings).toEqual([]);
      expect(again.storyboard).toEqual(result.storyboard);
    }
    const out = result.storyboard?.scenes[2]?.visual;
    return { result, steps: out?.type === 'repro' ? out.steps : null };
  }

  it('accepts steps of the supplied reproduction as they are, with no fix', async () => {
    const { result, steps } = await check(visual([1, 0], [2, 1], [5, 1]));
    expect(result.errors).toEqual([]);
    expect(result.fixes).toEqual([]);
    expect(steps).toEqual([
      { step: 1, beat: 0 },
      { step: 2, beat: 1 },
      { step: 5, beat: 1 },
    ]);
  });

  it('is an error when no reproduction was supplied, and says how to supply one', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = visual([1]);
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    expect(codes(result.errors)).toEqual(['repro-unknown']);
    expect(result.errors[0]?.path).toBe('scenes[2].visual.steps');
    expect(result.errors[0]?.message).toContain('--repro-file');
    expect(result.errors[0]?.message).toContain('repro.json');
  });

  it('drops a step that the reproduction does not have, with a fix and a warning', async () => {
    const { result, steps } = await check(visual([1], [9], [0], [3]), 3);
    expect(steps?.map((s) => s.step)).toEqual([1, 3]);
    expect(codes(result.warnings)).toEqual(['repro-step-unknown', 'repro-step-unknown']);
    expect(result.warnings[0]?.path).toBe('scenes[2].visual.steps[1].step');
    expect(result.warnings[0]?.message).toContain('has 3 steps');
    expect(result.fixes).toHaveLength(2);
  });

  it('drops a step that is listed twice, keeping the first', async () => {
    const { result, steps } = await check(visual([2, 0], [3, 1], [2, 1]));
    expect(steps).toEqual([
      { step: 2, beat: 0 },
      { step: 3, beat: 1 },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toEqual(['scenes[2].visual.steps[2]: dropped step 2 because it is listed twice']);
  });

  it('puts steps out of order into the order of the reproduction', async () => {
    const { result, steps } = await check(visual([3, 1], [1, 0], [2, 1]));
    expect(steps?.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toEqual(['scenes[2].visual.steps: put the steps in the order of the reproduction']);
  });

  it('keeps the first 6 steps, counted after the steps that do not exist are dropped', async () => {
    const { result, steps } = await check(visual([1], [2], [3], [4], [5], [6], [7]));
    expect(steps?.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.fixes).toEqual(['scenes[2].visual.steps: kept the first 6 of 7 steps (the limit is 6)']);
    const withGap = await check(visual([20], [1], [2], [3], [4], [5], [6]));
    expect(withGap.steps?.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('is an error when no step is left', async () => {
    for (const shown of [visual(), visual([9], [10])]) {
      const { result } = await check(shown, 3);
      expect(result.storyboard).toBeNull();
      expect(codes(result.errors)).toEqual(['repro-unknown']);
      expect(result.errors[0]?.message).toContain('steps from 1 to 3');
    }
  });

  it('keeps the beat of a step inside the narration of its scene', async () => {
    const { result, steps } = await check(visual([1, 7], [2, 1]));
    expect(steps).toEqual([
      { step: 1, beat: 1 },
      { step: 2, beat: 1 },
    ]);
    expect(result.fixes).toHaveLength(1);
  });
});

describe('simulated visuals', () => {
  const terminal = (): Json => ({
    type: 'terminal',
    title: 'Example run',
    lines: [
      { kind: 'command', text: 'curl /forecast', beat: 0 },
      { kind: 'output', text: 'Retrying after 200 ms', beat: 1 },
    ],
  });

  it('needs narration that cites a file, hunk or symbol', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = terminal();
    scene(sb, 2).narration = [
      { text: 'A failing request is tried again.', evidence: ['PR'] },
      { text: 'The task asked for this.', evidence: ['TASK'] },
    ];
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    expect(result.errors.find((e) => e.code === 'simulated-unbacked')!.path).toBe('scenes[2].visual');
  });

  it('does not take a reproduction as backing for a terminal', async () => {
    const fx = retryFixture({
      inputs: {
        repro: {
          title: 'Basket',
          environment: null,
          steps: [{ text: 'Open it', screenshotId: null, recordingId: null, result: null }],
        },
      },
    });
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = terminal();
    scene(sb, 2).narration = [{ text: 'In the reproduction, the page opens.', evidence: ['REPRO.1'] }];
    const result = await run(sb, fx);
    expect(result.errors.find((e) => e.code === 'simulated-unbacked')!.path).toBe('scenes[2].visual');
  });

  it('accepts a terminal when the narration cites the code that does it', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = terminal();
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
  });

  it('applies the same rule to a terminal panel in a before and after view', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'before-after',
      before: {
        label: 'Before',
        kind: 'bullets',
        codeRef: null,
        bullets: ['One try only.'],
        terminal: [],
        screenshotId: null,
      },
      after: {
        label: 'After',
        kind: 'terminal',
        codeRef: null,
        bullets: [],
        terminal: [{ kind: 'output', text: 'Retrying after 200 ms', beat: 0 }],
        screenshotId: null,
      },
      caption: null,
    };
    scene(sb, 2).narration = [{ text: 'The task asked for this.', evidence: ['TASK'] }];
    const result = await run(sb, fx);
    expect(codes(result.errors)).toContain('simulated-unbacked');
  });

  it('shows only a path in a browser address', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'browser',
      url: 'https://app.example.com/settings/cities?tab=plan',
      pageTitle: 'Forecast',
      blocks: [{ kind: 'heading', text: 'Forecast', items: [], emphasis: false, beat: 0 }],
    };
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'browser' && visual.url).toBe('/settings/cities?tab=plan');
    expect(result.fixes.some((f) => f.includes('never a host'))).toBe(true);

    for (const [given, expected] of [
      ['localhost:3000/forecast', '/forecast'],
      ['forecast', '/forecast'],
      ['/already/a/path', '/already/a/path'],
      ['//cdn.example.com/x', '/x'],
      ['user:pw@host.example.com/y', '/y'],
      ['index.html', '/index.html'],
    ] as const) {
      const again = baseStoryboard(fx);
      scene(again, 2).visual = { ...scene(sb, 2).visual, url: given };
      const checked = await run(again, fx);
      const v = checked.storyboard!.scenes[2]!.visual;
      expect(v.type === 'browser' && v.url).toBe(expected);
    }
  });

  it('replaces an address that carries a web address, a claim or an invented name with the root path', async () => {
    const fx = retryFixture();
    const browser = (url: string): Json => ({
      type: 'browser',
      url,
      pageTitle: 'Forecast',
      blocks: [{ kind: 'heading', text: 'Forecast', items: [], emphasis: false, beat: 0 }],
    });
    for (const [url, code] of [
      ['/redirect?next=https://login.bad-actor.dev/signin', 'url-in-text'],
      ['/api/retryBudget', 'unknown-identifier'],
      ['/tests-passing', 'unverified-claim'],
    ] as const) {
      const sb = baseStoryboard(fx);
      scene(sb, 2).visual = browser(url);
      const result = await run(sb, fx);
      expect(result.errors).toEqual([]);
      const visual = result.storyboard!.scenes[2]!.visual;
      expect(visual.type === 'browser' && visual.url).toBe('/');
      expect(result.warnings).toContainEqual(expect.objectContaining({ path: 'scenes[2].visual.url', code }));
    }
  });

  it('keeps the first twelve terminal lines and the first eight browser blocks, and says so', async () => {
    const fx = retryFixture();
    const check = async (visual: Json) => {
      const sb = baseStoryboard(fx);
      scene(sb, 2).visual = visual;
      const result = await run(sb, fx);
      expect(result.errors).toEqual([]);
      return result;
    };
    const lines = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ kind: 'output', text: `Attempt ${i + 1}`, beat: i % 2 }));
    const texts = (list: { text: string }[]) => list.map((item) => item.text);

    const terminal = await check({ type: 'terminal', title: 'Example run', lines: lines(15) });
    const shown = terminal.storyboard!.scenes[2]!.visual;
    expect(shown.type === 'terminal' && texts(shown.lines)).toEqual(texts(lines(12)));
    expect(terminal.fixes.some((f) => f.includes('kept the first 12 of 15 terminal lines'))).toBe(true);

    const panel = await check({
      type: 'before-after',
      before: {
        label: 'Before',
        kind: 'bullets',
        codeRef: null,
        bullets: ['One try only.'],
        terminal: [],
        screenshotId: null,
      },
      after: {
        label: 'After',
        kind: 'terminal',
        codeRef: null,
        bullets: [],
        terminal: lines(14),
        screenshotId: null,
      },
      caption: null,
    });
    const after = panel.storyboard!.scenes[2]!.visual;
    expect(after.type === 'before-after' && texts(after.after.terminal)).toEqual(texts(lines(12)));
    expect(panel.fixes.some((f) => f.includes('kept the first 12 of 14 terminal lines'))).toBe(true);

    const blocks = Array.from({ length: 11 }, (_, i) => ({
      kind: 'text',
      text: `Block ${i + 1}`,
      items: [],
      emphasis: false,
      beat: i % 2,
    }));
    const browser = await check({ type: 'browser', url: '/forecast', pageTitle: 'Forecast', blocks });
    const page = browser.storyboard!.scenes[2]!.visual;
    expect(page.type === 'browser' && texts(page.blocks)).toEqual(texts(blocks.slice(0, 8)));
    expect(browser.fixes.some((f) => f.includes('kept the first 8 of 11 blocks'))).toBe(true);
  });

  it('keeps an ordinary path, and a path that names code from the change', async () => {
    const fx = retryFixture();
    for (const url of ['/settings/cities?tab=plan', '/delayFor/preview']) {
      const sb = baseStoryboard(fx);
      scene(sb, 2).visual = {
        type: 'browser',
        url,
        pageTitle: 'Forecast',
        blocks: [{ kind: 'heading', text: 'Forecast', items: [], emphasis: false, beat: 0 }],
      };
      const result = await run(sb, fx);
      const visual = result.storyboard!.scenes[2]!.visual;
      expect(visual.type === 'browser' && visual.url).toBe(url);
    }
  });
});

describe('logs', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the run`);
  const log = {
    id: 'L1',
    path: '/nonexistent/run.log',
    caption: 'Run of the checks',
    lines,
  };
  const visual = (extra: Json = {}): Json => ({
    type: 'log',
    logId: 'L1',
    startLine: 10,
    endLine: 20,
    focus: [{ startLine: 12, endLine: 13, note: 'The count', beat: 0 }],
    caption: null,
    ...extra,
  });
  /** Validate a log visual in scene 2, then validate the accepted result again: nothing may change. */
  async function check(extra: Json, narrationEvidence: string[] = ['L1.12-13']) {
    const fx = retryFixture({ inputs: { logs: [log] } });
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = visual(extra);
    scene(sb, 2).narration = [
      { text: 'The run printed the count.', evidence: narrationEvidence },
      {
        text: 'It matches the new function.',
        evidence: [fx.id.hunk('src/http/retry.ts')],
      },
    ];
    const result = await run(sb, fx);
    if (result.storyboard) {
      const again = await run(result.storyboard, fx);
      expect(again.fixes).toEqual([]);
      expect(again.warnings).toEqual([]);
      expect(again.storyboard).toEqual(result.storyboard);
    }
    const shown = result.storyboard?.scenes[2]?.visual;
    return { result, shown: shown?.type === 'log' ? shown : null };
  }

  it('accepts lines of a supplied log, and a line range of the log in the narration, with no fix', async () => {
    const { result, shown } = await check({});
    expect(result.errors).toEqual([]);
    expect(result.fixes).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(shown).toMatchObject({ startLine: 10, endLine: 20 });
    expect(shown?.focus).toHaveLength(1);
  });

  it('rejects an id that was not supplied, and lists the ones that were', async () => {
    const { result } = await check({ logId: 'L9' });
    expect(result.storyboard).toBeNull();
    const issue = result.errors.find((e) => e.code === 'log-unknown')!;
    expect(issue.path).toBe('scenes[2].visual.logId');
    expect(issue.message).toBe('"L9" is not a supplied log; use one of L1');
    const none = retryFixture();
    const sb = baseStoryboard(none);
    scene(sb, 2).visual = visual();
    expect((await run(sb, none)).errors.find((e) => e.code === 'log-unknown')?.message).toContain(
      'no logs were supplied',
    );
  });

  it('puts the start and the end in order, with a fix and no warning', async () => {
    const { result, shown } = await check({ startLine: 20, endLine: 10 });
    expect(shown).toMatchObject({ startLine: 10, endLine: 20 });
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toEqual(['scenes[2].visual: put startLine and endLine in order']);
  });

  it('cuts a range that sticks out of the log, with a warning and a fix', async () => {
    const { result, shown } = await check({
      startLine: -3,
      endLine: 70,
      focus: [],
    });
    expect(shown).toMatchObject({ startLine: 1, endLine: 18 });
    // -3 to 70 is cut to the log (1 to 60) first, then to 18 lines.
    expect(codes(result.warnings)).toEqual(['log-range-out-of-range', 'log-too-long']);
    const edge = await check({ startLine: 55, endLine: 70, focus: [] });
    expect(edge.shown).toMatchObject({ startLine: 55, endLine: 60 });
    expect(codes(edge.result.warnings)).toEqual(['log-range-out-of-range']);
    expect(edge.result.fixes).toEqual(['scenes[2].visual: cut the lines to 55 to 60, inside the log']);
  });

  it('refuses a range that lies fully outside the log', async () => {
    for (const range of [
      { startLine: 61, endLine: 70 },
      { startLine: -5, endLine: 0 },
    ]) {
      const { result } = await check({ ...range, focus: [] });
      expect(result.storyboard).toBeNull();
      expect(codes(result.errors)).toEqual(['log-range-out-of-range']);
      expect(result.errors[0]?.path).toBe('scenes[2].visual.startLine');
      expect(result.errors[0]?.message).toContain('which has 60 lines');
    }
  });

  it('shortens a range of more than 18 lines from its end, and cuts the focus to what is left', async () => {
    const { result, shown } = await check({
      startLine: 10,
      endLine: 40,
      focus: [
        { startLine: 12, endLine: 13, note: null, beat: 0 },
        { startLine: 30, endLine: 35, note: null, beat: 1 },
        { startLine: 25, endLine: 40, note: null, beat: 1 },
      ],
    });
    expect(shown).toMatchObject({ startLine: 10, endLine: 27 });
    expect(codes(result.warnings)).toEqual(['log-too-long']);
    expect(shown?.focus.map((f) => [f.startLine, f.endLine])).toEqual([
      [12, 13],
      [25, 27],
    ]);
    expect(result.fixes).toEqual([
      'scenes[2].visual: shortened the lines from the end to 10 to 27 (the limit is 18 lines)',
      'scenes[2].visual.focus[1]: dropped the focus range 30-35 because it is outside the lines shown (10-27)',
      'scenes[2].visual.focus[2]: focus range 25-40 was changed to 25-27 to fit the lines shown',
    ]);
  });

  it('accepts exactly 18 lines', async () => {
    const { result } = await check({ startLine: 10, endLine: 27, focus: [] });
    expect(result.fixes).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('cleans the notes and the caption like those of code', async () => {
    const { result, shown } = await check({
      caption: 'See https://phish.attacker.dev/x for this.',
      focus: [
        {
          startLine: 12,
          endLine: 13,
          note: 'Visit https://phish.attacker.dev/x now',
          beat: 0,
        },
      ],
    });
    expect(shown?.caption).toBeNull();
    expect(shown?.focus[0]?.note).toBeNull();
    expect(codes(result.warnings)).toContain('url-in-text');
  });

  it('does not mask the id of the log: an id is matched exactly, as the other ids are', async () => {
    const { result } = await check({ logId: 'jane.doe@example.com' });
    expect(result.errors.find((e) => e.code === 'log-unknown')?.message).toContain(
      '"jane.doe@example.com" is not a supplied log',
    );
  });

  it('removes a cited range that is outside the log, with the usual fix text', async () => {
    const { result } = await check({ focus: [] }, ['L1.12-13', 'L1.50-70', 'L1.0-2']);
    expect(result.storyboard?.scenes[2]?.narration[0]?.evidence).toEqual(['L1.12-13']);
    expect(result.fixes).toContain(
      'scenes[2].narration[0].evidence: removed unknown evidence ids "L1.50-70", "L1.0-2"',
    );
  });

  it('is not backing evidence for a simulated visual', async () => {
    const fx = retryFixture({ inputs: { logs: [log] } });
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'terminal',
      title: 'Run',
      lines: [{ kind: 'command', text: 'npm test', beat: 0 }],
    };
    scene(sb, 2).narration = [{ text: 'The run printed the count.', evidence: ['L1', 'L1.12-13'] }];
    expect(codes((await run(sb, fx)).errors)).toContain('simulated-unbacked');
  });
});
