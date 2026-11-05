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
