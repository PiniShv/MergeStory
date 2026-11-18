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
