import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import {
  frameDirFor,
  frameDirForStep,
  PANEL_CLIP_DELAY_SEC,
  SCENE_CLIP_START_SEC,
  scenePanelStarts,
} from '../core/recording-frames.ts';
import type { CodeLine, RenderPlan, ResolvedVisual } from '../core/render-plan.ts';
import { MASK_CHAR } from '../core/secrets.ts';
import type { Highlight, Scene, Storyboard } from '../core/storyboard-schema.ts';
import { loadTheme } from '../core/theme.ts';
import type { Analysis, CaptionCue, ChangedFile, ChangeSet, ContextInputs } from '../core/types.ts';
import { buildContextInputs } from '../pipeline/inputs.ts';
import { testConfig, testContext } from '../testing/context.ts';
import { ffmpegTo } from '../testing/media.ts';
import { makePng } from '../testing/png.ts';
import { memoryReader, sample, sampleFiles, sampleNarration } from '../testing/sample-change.ts';
import { ENGINE_VERSION } from '../version.ts';
import { buildRenderPlan, changeLabelFor, MAX_FILE_ROWS, repoLabelFor } from './plan.ts';
import type { ExtractedFrames } from './recording-frames.ts';
import { buildTimeline } from './timeline.ts';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-plan-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Options {
  config?: Parameters<typeof testConfig>[0];
  storyboard?: Storyboard;
  changeSet?: ChangeSet;
  analysis?: Analysis;
  inputs?: ContextInputs;
  files?: Record<string, string>;
  cues?: CaptionCue[];
  signal?: AbortSignal;
  frames?: ReadonlyMap<string, ExtractedFrames>;
}

async function build(options: Options = {}): Promise<RenderPlan> {
  const base = sample();
  const storyboard = options.storyboard ?? base.storyboard;
  const config = testConfig(options.config);
  return buildRenderPlan(
    {
      storyboard,
      timeline: buildTimeline(storyboard, sampleNarration(storyboard)),
      cues: options.cues ?? [],
      changeSet: options.changeSet ?? base.changeSet,
      analysis: options.analysis ?? base.analysis,
      inputs: options.inputs ?? base.inputs,
      reader: memoryReader(options.files ?? sampleFiles()),
      config,
      theme: await loadTheme(config.theme),
      frames: options.frames,
    },
    testContext({ config: options.config, home: dir, runDir: dir, signal: options.signal }).ctx,
  );
}

function visualOf<T extends ResolvedVisual['type']>(
  plan: RenderPlan,
  id: string,
  type: T,
): Extract<ResolvedVisual, { type: T }> {
  const scene = plan.scenes.find((s) => s.id === id);
  expect(scene, `scene ${id}`).toBeDefined();
  expect(scene!.visual.type).toBe(type);
  return scene!.visual as Extract<ResolvedVisual, { type: T }>;
}

const lineText = (line: CodeLine): string => line.tokens.map((t) => t.t).join('');

function withScene(storyboard: Storyboard, id: string, change: (scene: Scene) => void): Storyboard {
  const copy = structuredClone(storyboard);
  change(copy.scenes.find((s) => s.id === id)!);
  return copy;
}

describe('buildRenderPlan: plan level', () => {
  it('uses the quality preset for size and frame rate', async () => {
    const expected = { draft: [1280, 720, 24], standard: [1920, 1080, 30], high: [1920, 1080, 60] } as const;
    for (const quality of ['draft', 'standard', 'high'] as const) {
      const plan = await build({ config: { quality } });
      expect([plan.width, plan.height, plan.fps]).toEqual(expected[quality]);
    }
  });

  it('takes theme, duration and statistics from the config and the change', async () => {
    const light = await build({ config: { theme: 'light' } });
    expect(light.version).toBe(1);
    expect(light.theme).toBe('light');
    expect(light.colors).toEqual((await loadTheme('paper')).colors);
    const { storyboard, narration, changeSet } = sample();
    expect(light.durationSec).toBe(buildTimeline(storyboard, narration).durationSec);
    expect(light.meta).toEqual({
      title: 'Retry failed forecast requests',
      repoLabel: 'example/weather',
      changeLabel: 'PR #42',
      headShort: '3f9c2ab',
      stats: changeSet.stats,
      engineVersion: ENGINE_VERSION,
    });
  });

  it('never puts a filesystem path in the labels', async () => {
    const changeSet = sample().changeSet;
    changeSet.source = 'local';
    changeSet.pr = null;
    changeSet.repo = {
      host: 'local',
      owner: null,
      name: '/Users/dev/work/weather',
      isPrivate: null,
      defaultBranch: null,
      webUrl: null,
    };
    changeSet.head = { ref: 'feature/retry', sha: 'abcdef1234567890abcdef1234567890abcdef12' };
    const plan = await build({ changeSet });
    expect(plan.meta.repoLabel).toBe('weather');
    expect(plan.meta.changeLabel).toBe('feature/retry');
    expect(plan.outro.lines[0]).toBe('weather · feature/retry');
    const labels = JSON.stringify([plan.meta, plan.outro]);
    expect(labels).not.toMatch(/\/Users|\/home|[A-Za-z]:\\/);
    expect(repoLabelFor({ ...changeSet.repo, name: 'C:\\work\\weather' })).toBe('weather');
    expect(changeLabelFor({ ...changeSet, head: { ref: 'refs/heads/main', sha: 'a'.repeat(40) } })).toBe(
      'main',
    );
    expect(changeLabelFor({ ...changeSet, head: { ref: 'a'.repeat(40), sha: 'a'.repeat(40) } })).toBe(
      'aaaaaaa',
    );
    expect(changeLabelFor({ ...changeSet, head: { ref: '', sha: 'a'.repeat(40) } })).toBe('working changes');
  });

  it('adds captions, chapters and the end card', async () => {
    const cues: CaptionCue[] = [
      { startSec: 1, endSec: 3, text: 'First cue' },
      { startSec: 3, endSec: 3, text: 'Empty span' },
      { startSec: 4, endSec: 5, text: '   ' },
    ];
    const plan = await build({ cues });
    expect(plan.captions).toEqual({ enabled: true, cues: [{ startSec: 1, endSec: 3, text: 'First cue' }] });
    expect((await build({ config: { captions: false } })).captions.enabled).toBe(false);
    expect(plan.chapters).toEqual(plan.scenes.map((s) => ({ title: s.title, startSec: s.startSec })));
    expect(plan.chapters[0]).toEqual({ title: 'The change', startSec: 0 });
    const { storyboard, narration } = sample();
    const timeline = buildTimeline(storyboard, narration);
    expect(plan.outro).toEqual({
      startSec: timeline.outro.startSec,
      durationSec: 3.5,
      tagline: 'Every change has a story.',
      lines: [
        'example/weather · PR #42',
        'Commit 3f9c2ab',
        'This video explains the change. It does not replace code review.',
      ],
    });
  });

  it('is deterministic and serialisable', async () => {
    const first = await build();
    const second = await build();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('stops when the run is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(build({ signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('buildRenderPlan: scenes', () => {
  it('takes timing from the timeline and keeps the narration text on the beats', async () => {
    const plan = await build();
    const { storyboard, narration } = sample();
    const timeline = buildTimeline(storyboard, narration);
    expect(plan.scenes).toHaveLength(storyboard.scenes.length);
    plan.scenes.forEach((scene, i) => {
      const timing = timeline.scenes[i]!;
      expect(scene.id).toBe(storyboard.scenes[i]!.id);
      expect(scene.role).toBe(storyboard.scenes[i]!.role);
      expect(scene.startSec).toBe(timing.startSec);
      expect(scene.durationSec).toBe(timing.durationSec);
      expect(scene.beats.map((b) => [b.index, b.startSec, b.durationSec])).toEqual(
        timing.beats.map((b) => [b.index, b.startSec, b.durationSec]),
      );
      expect(scene.beats.map((b) => b.text)).toEqual(storyboard.scenes[i]!.narration.map((n) => n.text));
    });
    expect(plan.scenes[0]!.transitionIn).toEqual({ type: 'none', durationSec: 0 });
    expect(plan.scenes[1]!.transitionIn).toEqual({ type: 'slide', durationSec: 0.6 });
    expect(plan.scenes[4]!.transitionIn).toEqual({ type: 'wipe', durationSec: 0.7 });
  });

  it('copies title, mission and summary content', async () => {
    const plan = await build();
    expect(visualOf(plan, 's1', 'title')).toEqual({
      type: 'title',
      kicker: 'Pull request #42',
      heading: 'Retry failed forecast requests',
      subheading: 'example/weather',
      chips: ['client', 'retry'],
    });
    expect(visualOf(plan, 's2', 'mission')).toMatchObject({
      problem: 'One failed request meant a failed forecast.',
      points: [
        { text: 'Only 429 and 5xx are retried', beat: 1 },
        { text: 'At most four attempts', beat: 1 },
      ],
    });
    expect(visualOf(plan, 's8', 'summary')).toMatchObject({ closing: 'Review the retry limits.' });
  });

  it('draws the real file list, grouped by component with highlights and trivial flags', async () => {
    const files = visualOf(await build(), 's3', 'files');
    expect(files.totals).toEqual(sample().changeSet.stats);
    expect(files.totals.files).toBe(4);
    expect(files.hiddenCount).toBe(0);
    expect(files.groups.map((g) => g.component)).toEqual(['retry', 'client', 'dependencies']);
    const rows = files.groups.flatMap((g) => g.files);
    expect(rows.map((r) => r.path)).toEqual([
      'src/retry/backoff.ts',
      'src/client.ts',
      'src/client.test.ts',
      'package-lock.json',
    ]);
    expect(rows.map((r) => r.highlighted)).toEqual([true, true, false, false]);
    expect(rows.map((r) => r.trivial)).toEqual([false, false, false, true]);
    expect(rows[0]).toMatchObject({ status: 'added', additions: 26, deletions: 0 });
  });

  it('shows at most 16 file rows and counts the rest', async () => {
    const base = sample();
    const extra: ChangedFile[] = Array.from({ length: 26 }, (_, i) => ({
      ...base.changeSet.files[2]!,
      id: `F${10 + i}`,
      path: `src/generated/file${i}.ts`,
      additions: 1,
      deletions: 0,
    }));
    const changeSet = { ...base.changeSet, files: [...base.changeSet.files, ...extra] };
    changeSet.stats = { files: changeSet.files.length, additions: 100, deletions: 10 };
    const files = visualOf(await build({ changeSet }), 's3', 'files');
    const rows = files.groups.flatMap((g) => g.files);
    expect(rows).toHaveLength(MAX_FILE_ROWS);
    expect(files.hiddenCount).toBe(30 - MAX_FILE_ROWS);
    expect(files.totals.files).toBe(30);
    // Highlighted files always make the cut, trivial files do not.
    expect(rows.map((r) => r.path)).toContain('src/retry/backoff.ts');
    expect(rows.map((r) => r.path)).toContain('src/client.ts');
    expect(rows.map((r) => r.path)).not.toContain('package-lock.json');
    expect(files.groups.at(-1)?.component).toBe('Other');
  });

  it('lays out the architecture diagram', async () => {
    const diagram = visualOf(await build(), 's4', 'architecture');
    expect(diagram.direction).toBe('LR');
    expect(diagram.width).toBeGreaterThan(0);
    expect(diagram.nodes.map((n) => n.id)).toEqual(['client', 'retry', 'http']);
    expect(
      diagram.nodes.every((n) => n.w >= 260 && n.h >= 96 && Number.isFinite(n.x) && Number.isFinite(n.y)),
    ).toBe(true);
    expect(diagram.edges).toHaveLength(2);
    expect(diagram.edges[0]).toMatchObject({
      from: 'client',
      to: 'retry',
      label: 'wraps calls',
      status: 'added',
      beat: 0,
    });
    expect(diagram.edges.every((e) => e.points.length >= 2)).toBe(true);
  });

  it('reads the code of a diff scene from the repository and clamps the focus', async () => {
    const plan = await build();
    const code = visualOf(plan, 's5', 'code');
    expect(code.mode).toBe('diff');
    expect(code.code.path).toBe('src/client.ts');
    expect(code.code.lines.some((l) => l.kind === 'del')).toBe(true);
    expect(code.code.lines.some((l) => l.kind === 'add')).toBe(true);
    expect(code.code.lines.filter((l) => l.kind === 'add').map(lineText)).toContain(
      '  return withRetry(async () => {',
    );
    expect(code.focus).toEqual([
      { startLine: 10, endLine: 10, note: 'Wrapped in withRetry', beat: 0 },
      { startLine: 13, endLine: 13, note: 'Typed error', beat: 1 },
    ]);
    expect(code.code.masked).toBe(false);
  });

  it('drops focus ranges that are not on screen and calls a diff without changes a snippet', async () => {
    const storyboard = withScene(sample().storyboard, 's5', (scene) => {
      if (scene.visual.type !== 'code') throw new Error('unexpected visual');
      scene.visual.focus = [
        { startLine: 1, endLine: 2, note: 'not shown', beat: 0 },
        { startLine: 12, endLine: 40, note: 'clamped', beat: 1 },
      ];
    });
    const code = visualOf(await build({ storyboard }), 's5', 'code');
    expect(code.focus).toEqual([{ startLine: 12, endLine: 16, note: 'clamped', beat: 1 }]);

    const snippet = withScene(sample().storyboard, 's5', (scene) => {
      if (scene.visual.type !== 'code') throw new Error('unexpected visual');
      scene.visual.ref = { path: 'src/client.ts', side: 'head', startLine: 4, endLine: 6 };
      scene.visual.focus = [];
    });
    const resolved = visualOf(await build({ storyboard: snippet }), 's5', 'code');
    expect(resolved.mode).toBe('snippet');
  });

  it('resolves before and after panels: code from the repository, terminal copy marked simulated', async () => {
    const plan = await build();
    const panel = visualOf(plan, 's6', 'before-after');
    if (panel.before.kind !== 'code') throw new Error('expected a code panel');
    expect(panel.before.code.side).toBe('base');
    expect(panel.before.code.lines.map((l) => l.oldNumber)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    if (panel.after.kind !== 'terminal') throw new Error('expected a terminal panel');
    expect(panel.after.terminal).toEqual([
      { kind: 'command', text: 'send("/forecast")', beat: 0 },
      { kind: 'output', text: 'retry 1 after 200 ms', beat: 0 },
      { kind: 'output', text: '200 OK', beat: 0 },
    ]);
    expect(Object.keys(panel.before).sort()).toEqual(['code', 'kind', 'label']);
    expect(Object.keys(panel.after).sort()).toEqual(['kind', 'label', 'terminal']);
    expect(plan.scenes.find((s) => s.id === 's6')!.badges).toEqual([
      { kind: 'simulated', text: 'Simulated output' },
    ]);
  });

  it('copies terminal content', async () => {
    expect(visualOf(await build(), 's7', 'terminal')).toEqual({
      type: 'terminal',
      title: 'npm test',
      lines: [
        { kind: 'command', text: 'npm test', beat: 0 },
        { kind: 'output', text: '42 passed', beat: 0 },
      ],
    });
  });
});

describe('buildRenderPlan: other visual types', () => {
  async function extras(
    inputs: ContextInputs = sample().inputs,
    config?: Options['config'],
  ): Promise<RenderPlan> {
    const board = sample().storyboard;
    const make = (id: string, visual: Scene['visual'], evidence: string[] = []): Scene => ({
      id,
      role: 'review',
      title: id,
      narration: [{ text: `Narration of ${id}`, evidence }],
      visual,
      visualDescription: '',
      transition: 'fade',
      targetSeconds: null,
    });
    const storyboard: Storyboard = {
      ...board,
      scenes: [
        make('check', {
          type: 'checklist',
          items: [
            {
              title: 'Retry limit',
              detail: 'Four attempts',
              severity: 'medium',
              ref: { path: 'src/retry/backoff.ts', side: 'head', startLine: 16, endLine: 27 },
              beat: 0,
              evidence: ['F1'],
            },
            { title: 'Docs', detail: 'None added', severity: 'info', ref: null, beat: 0, evidence: [] },
          ],
        }),
        make('bullets', { type: 'bullets', heading: 'Notes', items: [{ text: 'One', beat: 0 }] }),
        make('flow', {
          type: 'flow',
          actors: [
            { id: 'a', label: 'Client', kind: 'module' },
            { id: 'b', label: 'Server', kind: 'service' },
          ],
          steps: [
            {
              from: 'a',
              to: 'b',
              label: 'GET /forecast',
              detail: null,
              kind: 'request',
              beat: 0,
              evidence: [],
            },
          ],
        }),
        make('browser', {
          type: 'browser',
          url: '/settings',
          pageTitle: 'Settings',
          blocks: [{ kind: 'heading', text: 'Forecast', items: ['a', 'b'], emphasis: true, beat: 0 }],
        }),
        make('shot', {
          type: 'screenshot',
          screenshotId: 'SS1',
          caption: 'The page',
          highlights: [],
          focus: null,
        }),
        make('compare', {
          type: 'before-after',
          before: {
            label: 'Before',
            kind: 'screenshot',
            codeRef: null,
            bullets: [],
            terminal: [],
            screenshotId: 'SS1',
            recordingId: null,
            highlights: [],
          },
          after: {
            label: 'After',
            kind: 'bullets',
            codeRef: null,
            bullets: ['Faster'],
            terminal: [],
            screenshotId: null,
            recordingId: null,
            highlights: [],
          },
          caption: null,
        }),
      ],
    };
    return build({ storyboard, inputs, config });
  }

  const withShot = async (png: Buffer, name = 'shot.png'): Promise<ContextInputs> => {
    const path = join(dir, name);
    await writeFile(path, png);
    return { ...sample().inputs, screenshots: [{ id: 'SS1', path, caption: 'The page', moment: 'after' }] };
  };

  it('copies checklist, bullets, flow and browser content and labels checklist references', async () => {
    const plan = await extras(await withShot(makePng(4, 2)));
    expect(visualOf(plan, 'check', 'checklist').items).toEqual([
      {
        title: 'Retry limit',
        detail: 'Four attempts',
        severity: 'medium',
        refLabel: 'src/retry/backoff.ts:16-27',
        beat: 0,
      },
      { title: 'Docs', detail: 'None added', severity: 'info', refLabel: null, beat: 0 },
    ]);
    expect(visualOf(plan, 'bullets', 'bullets')).toEqual({
      type: 'bullets',
      heading: 'Notes',
      items: [{ text: 'One', beat: 0 }],
    });
    expect(visualOf(plan, 'flow', 'flow').steps[0]).toMatchObject({
      from: 'a',
      to: 'b',
      label: 'GET /forecast',
      kind: 'request',
    });
    expect(visualOf(plan, 'browser', 'browser')).toMatchObject({ url: '/settings', pageTitle: 'Settings' });
    expect(plan.scenes.find((s) => s.id === 'browser')!.badges).toEqual([
      { kind: 'simulated', text: 'Simulated screen' },
    ]);
  });

  it('embeds screenshots as data URLs and labels them as actual', async () => {
    const png = makePng(4, 2);
    const plan = await extras(await withShot(png));
    const shot = visualOf(plan, 'shot', 'screenshot');
    expect(shot.image).toEqual({
      src: `data:image/png;base64,${png.toString('base64')}`,
      width: 4,
      height: 2,
    });
    expect(shot.caption).toBe('The page');
    expect(plan.scenes.find((s) => s.id === 'shot')!.badges).toEqual([
      { kind: 'actual', text: 'Actual screenshot' },
    ]);
    const compare = visualOf(plan, 'compare', 'before-after');
    if (compare.before.kind !== 'screenshot') throw new Error('expected a screenshot panel');
    expect(compare.before.image.width).toBe(4);
    expect(plan.scenes.find((s) => s.id === 'compare')!.badges.map((b) => b.kind)).toEqual(['actual']);
  });

  it('rejects unusable screenshots with a clear error', async () => {
    await expect(extras()).rejects.toMatchObject({
      code: 'STORYBOARD_INVALID',
      message: expect.stringContaining('SS1'),
    });
    await expect(extras(await withShot(Buffer.from('not an image'), 'bad.png'))).rejects.toMatchObject({
      code: 'USAGE',
    });
    const big = Buffer.concat([makePng(4, 2), Buffer.alloc(4 * 1024 * 1024 + 1)]);
    await expect(extras(await withShot(big, 'big.png'))).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('too large'),
    });
  });

  describe('highlights and focus', () => {
    const HIGHLIGHT = { x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'The count', beat: 1 };
    const FOCUS = { x: 0.05, y: 0.1, w: 0.5, h: 0.5 };

    async function marked(over: { highlights?: Highlight[]; focus?: unknown; label?: string | null }) {
      const inputs = await withShot(makePng(4, 2));
      const base = sample().storyboard;
      const make = (id: string, visual: Scene['visual']): Scene => ({
        ...structuredClone(base.scenes[0]!),
        id,
        visual,
      });
      const highlights = over.highlights ?? [{ ...HIGHLIGHT, label: over.label ?? HIGHLIGHT.label }];
      const storyboard: Storyboard = {
        ...base,
        scenes: [
          ...base.scenes,
          make('shot', {
            type: 'screenshot',
            screenshotId: 'SS1',
            caption: null,
            highlights,
            focus: over.focus ?? null,
          } as Scene['visual']),
          make('compare', {
            type: 'before-after',
            before: {
              label: 'Before',
              kind: 'screenshot',
              codeRef: null,
              bullets: [],
              terminal: [],
              screenshotId: 'SS1',
              recordingId: null,
              highlights,
            },
            after: {
              label: 'After',
              kind: 'screenshot',
              codeRef: null,
              bullets: [],
              terminal: [],
              screenshotId: 'SS1',
              recordingId: null,
              highlights: [],
            },
            caption: null,
          }),
        ],
      };
      return build({ storyboard, inputs });
    }

    it('puts the highlights and the focus of a screenshot scene into the plan', async () => {
      const shot = visualOf(await marked({ focus: FOCUS }), 'shot', 'screenshot');
      expect(shot.highlights).toEqual([HIGHLIGHT]);
      expect(shot.focus).toEqual(FOCUS);
    });

    it('puts the highlights of a screenshot panel into the plan, and none for a panel without any', async () => {
      const compare = visualOf(await marked({}), 'compare', 'before-after');
      if (compare.before.kind !== 'screenshot' || compare.after.kind !== 'screenshot') {
        throw new Error('expected screenshot panels');
      }
      expect(compare.before.highlights).toEqual([HIGHLIGHT]);
      expect('highlights' in compare.after).toBe(false);
    });

    it('masks a secret in a label on its own, when the storyboard was not checked first, and adds a badge', async () => {
      const plan = await marked({ label: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
      const [highlight] = visualOf(plan, 'shot', 'screenshot').highlights ?? [];
      expect(highlight?.label).not.toContain('abcdefghijklmnop');
      expect(highlight?.label).toContain(MASK_CHAR);
      expect(plan.scenes.find((s) => s.id === 'shot')!.badges.map((b) => b.kind)).toContain('masked');
    });

    it('keeps a label that is null and turns a beat that is not a whole number into one', async () => {
      const plan = await marked({ highlights: [{ ...HIGHLIGHT, label: null, beat: 1.7 }] });
      expect(visualOf(plan, 'shot', 'screenshot').highlights).toEqual([
        { ...HIGHLIGHT, label: null, beat: 1 },
      ]);
    });

    it('leaves both fields out when there are none, so the plan of an older storyboard does not change', async () => {
      const plan = await marked({ highlights: [], focus: null });
      const shot = visualOf(plan, 'shot', 'screenshot');
      expect(Object.keys(shot).sort()).toEqual(['caption', 'image', 'type']);
      const compare = visualOf(plan, 'compare', 'before-after');
      if (compare.before.kind !== 'screenshot') throw new Error('expected a screenshot panel');
      expect(Object.keys(compare.before).sort()).toEqual(['image', 'kind', 'label']);
      expect(JSON.stringify(plan)).not.toContain('highlights');
    });
  });

  it('gets a wide picture 2560 wide, and an error from making it smaller names the screenshot', async (ctx) => {
    const tools = await resolveFfmpeg(testConfig()).catch(() => null);
    const file = join(dir, 'wide-made.png');
    if (
      tools === null ||
      !(await ffmpegTo(tools.ffmpeg, [
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=3000x1500:rate=1:duration=1',
        '-frames:v',
        '1',
        file,
      ]))
    ) {
      return ctx.skip();
    }
    const inputs = {
      ...sample().inputs,
      screenshots: [{ id: 'SS1', path: file, caption: 'Wide', moment: 'after' as const }],
    };
    const plan = await extras(inputs);
    expect(visualOf(plan, 'shot', 'screenshot').image).toMatchObject({ width: 2560, height: 1280 });

    const broken = join(dir, 'ffmpeg-fails.sh');
    await writeFile(broken, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(extras(inputs, { render: { ffmpegPath: broken } })).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('Screenshot SS1 (wide-made.png)'),
    });
  });
});

describe('buildRenderPlan: recordings', () => {
  const panel = (kind: 'recording' | 'terminal', side: string) => ({
    label: side,
    kind,
    codeRef: null,
    bullets: [],
    terminal: kind === 'terminal' ? [{ kind: 'output' as const, text: 'ok', beat: 0 }] : [],
    screenshotId: null,
    recordingId: kind === 'recording' ? 'RC1' : null,
    highlights: [],
  });
  // The scenes of the sample come first: the recording scene is the next one, and the comparison follows it.
  const RECORDING_SCENE = sample().storyboard.scenes.length + 1;
  const frames = (dirs: string[]): Map<string, ExtractedFrames> =>
    new Map(dirs.map((d) => [d, { dir: d, count: 30, width: 640, height: 360 }]));

  async function recordings(second: 'recording' | 'terminal') {
    const base = sample().storyboard;
    const make = (id: string, visual: Scene['visual']): Scene => ({
      ...structuredClone(base.scenes[0]!),
      id,
      visual,
      narration: [
        { text: 'First, the page.', evidence: ['RC1'] },
        { text: 'Then, the page again.', evidence: ['RC1'] },
      ],
    });
    const storyboard: Storyboard = {
      ...base,
      scenes: [
        ...base.scenes,
        make('rec', {
          type: 'recording',
          recordingId: 'RC1',
          caption: 'The page',
          trim: null,
          speed: 2,
          zoom: null,
          highlights: [],
          focus: null,
        }),
        make('cmp', {
          type: 'before-after',
          before: panel('recording', 'Before'),
          after: panel(second, 'After'),
          caption: null,
        }),
      ],
    };
    return build({
      storyboard,
      frames: frames([
        frameDirFor(RECORDING_SCENE, null),
        frameDirFor(RECORDING_SCENE + 1, 'before'),
        frameDirFor(RECORDING_SCENE + 1, 'after'),
      ]),
    });
  }

  it('resolves a recording scene to a frame set, labelled "Recorded"', async () => {
    const plan = await recordings('terminal');
    const visual = visualOf(plan, 'rec', 'recording');
    expect(visual.frames).toEqual({
      dir: `recording-frames/s-${RECORDING_SCENE}`,
      count: 30,
      fps: 12,
      width: 640,
      height: 360,
      startSec: SCENE_CLIP_START_SEC,
      speed: 2,
    });
    expect(plan.scenes.find((s) => s.id === 'rec')!.badges).toEqual([{ kind: 'actual', text: 'Recorded' }]);
  });

  it('puts the highlights and the focus of a recording scene into the plan, and leaves them out when there are none', async () => {
    const withMarks = (marks: object) => {
      const storyboard = withScene(sample().storyboard, 's1', (scene) => {
        scene.visual = {
          type: 'recording',
          recordingId: 'RC1',
          caption: null,
          trim: null,
          speed: null,
          zoom: null,
          highlights: [],
          focus: null,
          ...marks,
        } as Scene['visual'];
      });
      return build({ storyboard, frames: frames([frameDirFor(1, null)]) });
    };
    const box = { x: 0.2, y: 0.3, w: 0.4, h: 0.1 };
    const marked = visualOf(
      await withMarks({ highlights: [{ ...box, label: 'The error', beat: 0 }], focus: box }),
      's1',
      'recording',
    );
    expect(marked.highlights).toEqual([{ ...box, label: 'The error', beat: 0 }]);
    expect(marked.focus).toEqual(box);
    const plain = visualOf(await withMarks({}), 's1', 'recording');
    expect(Object.keys(plain).sort()).toEqual(['caption', 'frames', 'type']);
  });

  it('starts a recording panel when the panel appears, and keeps the badge of a simulated side', async () => {
    const plan = await recordings('terminal');
    const scene = plan.scenes.find((s) => s.id === 'cmp')!;
    const compare = visualOf(plan, 'cmp', 'before-after');
    if (compare.before.kind !== 'recording') throw new Error('expected a recording panel');
    expect(compare.before.frames.speed).toBe(1);
    expect(compare.before.frames.startSec).toBeCloseTo(
      scenePanelStarts(scene).before + PANEL_CLIP_DELAY_SEC,
      3,
    );
    expect(scene.badges.map((b) => b.text)).toEqual(['Simulated output', 'Recorded']);
  });

  it('keeps every frame out of the plan that is written to disk', async () => {
    const plan = await recordings('recording');
    expect(plan.media).toBeUndefined();
    expect(JSON.stringify(plan)).not.toMatch(/data:image\/jpeg/);
  });

  it('stops when the frames were not extracted', async () => {
    const storyboard = withScene(sample().storyboard, 's1', (scene) => {
      scene.visual = {
        type: 'recording',
        recordingId: 'RC1',
        caption: null,
        trim: null,
        speed: null,
        zoom: null,
        highlights: [],
        focus: null,
      };
    });
    await expect(build({ storyboard })).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('buildRenderPlan: a reproduction', () => {
  const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  const REPRO_SCENE = sample().storyboard.scenes.length + 1;
  const repro = (): NonNullable<ContextInputs['repro']> => ({
    title: 'The basket total is wrong',
    environment: 'Chrome 140 on a laptop',
    steps: [
      { text: 'Open the basket page', screenshotId: null, recordingId: null, result: null },
      { text: `Type 2 and 3, token ${secret}`, screenshotId: 'SS1', recordingId: null, result: 'bug' },
      { text: 'The page says 23 items', screenshotId: null, recordingId: 'RC1', result: 'actual' },
    ],
  });

  async function reproRun(steps: { step: number; beat: number }[], inputs?: Partial<ContextInputs>) {
    const base = sample().storyboard;
    const path = join(dir, 'repro-shot.png');
    await writeFile(path, makePng(4, 2));
    const scene: Scene = {
      ...structuredClone(base.scenes[0]!),
      id: 'rp',
      role: 'reproduction',
      visual: { type: 'repro', steps },
      narration: [
        { text: 'In the reproduction, the page opens.', evidence: ['REPRO.1'] },
        { text: 'Then the total is wrong.', evidence: ['REPRO.2'] },
      ],
    };
    return build({
      storyboard: { ...base, scenes: [...base.scenes, scene] },
      inputs: {
        ...sample().inputs,
        repro: repro(),
        screenshots: [{ id: 'SS1', path, caption: 'The page', moment: 'before' }],
        ...inputs,
      },
      frames: new Map([
        [
          frameDirForStep(REPRO_SCENE, 3),
          { dir: frameDirForStep(REPRO_SCENE, 3), count: 1, width: 320, height: 180 },
        ],
      ]),
    });
  }
  const all = [
    { step: 1, beat: 0 },
    { step: 2, beat: 1 },
    { step: 3, beat: 1 },
  ];

  it('takes the words, results and pictures from the supplied reproduction, in the order of the storyboard', async () => {
    const plan = await reproRun([
      { step: 3, beat: 1 },
      { step: 1, beat: 0 },
    ]);
    const visual = visualOf(plan, 'rp', 'repro');
    expect(visual.title).toBe('The basket total is wrong');
    expect(visual.environment).toBe('Chrome 140 on a laptop');
    expect(visual.steps.map((s) => [s.number, s.text, s.result, s.beat])).toEqual([
      [3, 'The page says 23 items', 'actual', 1],
      [1, 'Open the basket page', null, 0],
    ]);
    expect(visual.steps[1]!.thumb).toBeNull();
  });

  it('holds the text of a reproduction file without hidden characters', async () => {
    const { repro: clean } = await buildContextInputs(
      {
        repro: {
          title: 'Basket \u202eshows\u200b 23',
          environment: 'win\u0000dow',
          steps: [{ text: 'Open\u202e the basket\u200b page' }],
        },
      },
      dir,
      testConfig(),
    );
    const plan = await reproRun([{ step: 1, beat: 0 }], { repro: clean });
    const visual = visualOf(plan, 'rp', 'repro');
    expect([visual.title, visual.environment, visual.steps[0]?.text]).toEqual([
      'Basket shows 23',
      'window',
      'Open the basket page',
    ]);
  });

  it('masks a secret in a step and says so with a badge', async () => {
    const plan = await reproRun(all);
    const visual = visualOf(plan, 'rp', 'repro');
    expect(visual.steps[1]!.text).not.toContain(secret);
    expect(visual.steps[1]!.text).toContain(MASK_CHAR);
    expect(plan.scenes.find((s) => s.id === 'rp')!.badges.map((b) => b.text)).toContain(
      'Sensitive data masked',
    );
    expect(JSON.stringify(plan)).not.toContain(secret);
  });

  it('draws a screenshot as it is, and a recording as the one frame of its own folder', async () => {
    const plan = await reproRun(all);
    const visual = visualOf(plan, 'rp', 'repro');
    expect(visual.steps[1]!.thumb).toMatchObject({ kind: 'screenshot', image: { width: 4, height: 2 } });
    expect(visual.steps[2]!.thumb).toEqual({
      kind: 'recording',
      frames: {
        dir: `recording-frames/s-${REPRO_SCENE}.step-3`,
        count: 1,
        width: 320,
        height: 180,
        fps: 12,
        startSec: 0,
        speed: 1,
      },
    });
  });

  it('labels the scene as reported steps, with an actual screenshot and a recording', async () => {
    const plan = await reproRun(all);
    expect(plan.scenes.find((s) => s.id === 'rp')!.badges).toEqual([
      { kind: 'actual', text: 'Actual screenshot' },
      { kind: 'actual', text: 'Recorded' },
      { kind: 'reported', text: 'Reported steps' },
      { kind: 'masked', text: 'Sensitive data masked' },
    ]);
    const words = await reproRun([{ step: 1, beat: 0 }]);
    expect(words.scenes.find((s) => s.id === 'rp')!.badges).toEqual([
      { kind: 'reported', text: 'Reported steps' },
    ]);
  });

  it('stops when no reproduction was supplied, or a step does not exist', async () => {
    await expect(reproRun(all, { repro: null })).rejects.toMatchObject({
      code: 'STORYBOARD_INVALID',
      hint: expect.stringContaining('--repro-file'),
    });
    await expect(reproRun([{ step: 4, beat: 0 }])).rejects.toMatchObject({
      code: 'STORYBOARD_INVALID',
      message: expect.stringContaining('step 4'),
    });
  });
});

describe('buildRenderPlan: refs and badges', () => {
  it('shows a code reference of one line without a range', async () => {
    const storyboard = withScene(sample().storyboard, 's5', (scene) => {
      if (scene.visual.type === 'code') {
        scene.visual.ref.endLine = scene.visual.ref.startLine;
        scene.visual.focus = [];
      }
    });
    const refs = (await build({ storyboard })).scenes.find((s) => s.id === 's5')!.refs;
    expect(refs[0]).toBe('src/client.ts:8');
    expect(refs.some((r) => /:(\d+)-\1$/.test(r))).toBe(false);
  });

  it('lists the scene code reference first, then cited files, hunks and symbols, at most three', async () => {
    const plan = await build();
    expect(plan.scenes.find((s) => s.id === 's1')!.refs).toEqual([]);
    // s4 cites M1 (a component, not listed), F2 and F1 through narration and nodes.
    expect(plan.scenes.find((s) => s.id === 's4')!.refs).toEqual(['src/client.ts', 'src/retry/backoff.ts']);
    // s5: its own code reference, then the hunk it cites (same label, listed once).
    expect(plan.scenes.find((s) => s.id === 's5')!.refs).toEqual(['src/client.ts:8-16']);
    expect(plan.scenes.find((s) => s.id === 's6')!.refs).toEqual(['src/client.ts:8-14', 'src/client.ts']);

    const storyboard = withScene(sample().storyboard, 's3', (scene) => {
      scene.narration = [{ text: 'Many files.', evidence: ['F1', 'F2', 'F2.H1', 'S1'] }];
    });
    expect((await build({ storyboard })).scenes.find((s) => s.id === 's3')!.refs).toEqual([
      'src/retry/backoff.ts',
      'src/client.ts',
      'src/client.ts:8-16',
    ]);
  });

  it('marks simulated visuals and reported test results', async () => {
    const plan = await build();
    const badges = (id: string) => plan.scenes.find((s) => s.id === id)!.badges;
    expect(badges('s1')).toEqual([]);
    expect(badges('s5')).toEqual([]);
    expect(badges('s6')).toEqual([{ kind: 'simulated', text: 'Simulated output' }]);
    expect(badges('s7')).toEqual([
      { kind: 'simulated', text: 'Simulated output' },
      { kind: 'reported', text: 'Reported results' },
    ]);
  });
});

describe('buildRenderPlan: privacy', () => {
  const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

  it('masks secrets in code and says so with a badge', async () => {
    const files = sampleFiles();
    files['head:src/client.ts'] = files['head:src/client.ts']!.replace(
      "import { request } from './http.ts';",
      `const token = '${secret}';`,
    );
    const plan = await build({
      files,
      storyboard: withScene(sample().storyboard, 's5', (scene) => {
        if (scene.visual.type !== 'code') throw new Error('unexpected visual');
        scene.visual.ref = { path: 'src/client.ts', side: 'head', startLine: 1, endLine: 4 };
        scene.visual.mode = 'snippet';
        scene.visual.focus = [];
      }),
    });
    const scene = plan.scenes.find((s) => s.id === 's5')!;
    const code = visualOf(plan, 's5', 'code').code;
    expect(code.masked).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(code.lines.map(lineText).join('\n')).toContain(MASK_CHAR.repeat(8));
    expect(scene.badges).toContainEqual({ kind: 'masked', text: 'Sensitive data masked' });
  });

  it('masks secrets and e-mail addresses in narration, captions and on-screen text', async () => {
    const storyboard = structuredClone(sample().storyboard);
    storyboard.scenes[0]!.narration[0]!.text = `Use the key ${secret} and mail dev@example.com.`;
    storyboard.title = `Title with ${secret}`;
    if (storyboard.scenes[1]!.visual.type !== 'mission') throw new Error('unexpected visual');
    storyboard.scenes[1]!.visual.goal = 'Write to ops@example.com';
    const cues: CaptionCue[] = [{ startSec: 1, endSec: 2, text: `Caption ${secret}` }];
    const plan = await build({ storyboard, cues });
    const json = JSON.stringify(plan);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('dev@example.com');
    expect(json).not.toContain('ops@example.com');
    expect(plan.scenes[0]!.badges).toContainEqual({ kind: 'masked', text: 'Sensitive data masked' });

    const open = await build({ storyboard, config: { privacy: { maskEmails: false } } });
    expect(JSON.stringify(open)).toContain('dev@example.com');
    expect(JSON.stringify(open)).not.toContain(secret);
  });

  it('masks an e-mail address in a cited path everywhere it is shown', async () => {
    const path = 'docs/jane.doe@corp.example.com/notes.ts';
    const shown = 'docs/j•••@corp.example.com/notes.ts';
    const changeSet = sample().changeSet;
    changeSet.files.push({
      id: 'F5',
      path,
      oldPath: null,
      status: 'added',
      additions: 2,
      deletions: 0,
      binary: false,
      language: 'typescript',
      patchTruncated: false,
      sensitive: false,
      hunks: [],
    });
    changeSet.stats.files += 1;
    const ref = { path, side: 'head' as const, startLine: 1, endLine: 2 };
    let storyboard = withScene(sample().storyboard, 's5', (scene) => {
      if (scene.visual.type !== 'code') throw new Error('unexpected visual');
      scene.visual.ref = ref;
      scene.visual.mode = 'snippet';
      scene.visual.focus = [];
    });
    storyboard = withScene(storyboard, 's7', (scene) => {
      scene.visual = {
        type: 'checklist',
        items: [{ title: 'Notes', detail: 'Read them', severity: 'info', ref, beat: 0, evidence: [] }],
      };
    });
    const files = { ...sampleFiles(), [`head:${path}`]: 'export const a = 1;\nexport const b = 2;\n' };

    const plan = await build({ changeSet, storyboard, files });
    const rows = visualOf(plan, 's3', 'files').groups.flatMap((group) =>
      group.files.map((file) => file.path),
    );
    expect(rows).toContain(shown);
    expect(visualOf(plan, 's5', 'code').code.path).toBe(shown);
    const scene = plan.scenes.find((s) => s.id === 's5')!;
    expect(scene.refs[0]).toBe(`${shown}:1-2`);
    expect(scene.badges).toContainEqual({ kind: 'masked', text: 'Sensitive data masked' });
    expect(visualOf(plan, 's7', 'checklist').items[0]!.refLabel).toBe(`${shown}:1-2`);
    expect(JSON.stringify(plan)).not.toContain('jane.doe');

    const open = await build({ changeSet, storyboard, files, config: { privacy: { maskEmails: false } } });
    expect(visualOf(open, 's5', 'code').code.path).toBe(path);
  });

  it('shows no code for sensitive files', async () => {
    const changeSet = sample().changeSet;
    changeSet.files.push({
      id: 'F5',
      path: 'config/.env',
      oldPath: null,
      status: 'added',
      additions: 2,
      deletions: 0,
      binary: false,
      language: null,
      patchTruncated: false,
      sensitive: true,
      hunks: [],
    });
    const storyboard = withScene(sample().storyboard, 's5', (scene) => {
      if (scene.visual.type !== 'code') throw new Error('unexpected visual');
      scene.visual.ref = { path: 'config/.env', side: 'head', startLine: 1, endLine: 2 };
      scene.visual.focus = [];
    });
    const reader = { 'head:config/.env': 'API_KEY=abcdef123456\n' };
    const plan = await build({ changeSet, storyboard, files: { ...sampleFiles(), ...reader } });
    const code = visualOf(plan, 's5', 'code');
    expect(JSON.stringify(code)).not.toContain('abcdef');
    expect(code.code.masked).toBe(true);
    expect(plan.scenes.find((s) => s.id === 's5')!.badges).toContainEqual({
      kind: 'masked',
      text: 'Sensitive data masked',
    });
  });
});
