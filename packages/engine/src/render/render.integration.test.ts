/**
 * Integration tests: real browser, real FFmpeg. They skip themselves when either is missing.
 *
 * Most tests use a tiny stand-in runtime whose frames are a pure function of the frame number, so
 * they check the renderer (order, timing, colour, segments, audio, clean-up) without depending on
 * the scene templates. One test renders with the real runtime.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import { toMergeStoryError } from '../core/errors.ts';
import { runCommand } from '../core/process.ts';
import {
  frameDirFor,
  PANEL_CLIP_DELAY_SEC,
  RECORDING_FPS,
  scenePanelStarts,
} from '../core/recording-frames.ts';
import type { RenderPlan } from '../core/render-plan.ts';
import { loadTheme } from '../core/theme.ts';
import type { ProgressEvent } from '../core/types.ts';
import { testConfig, testContext } from '../testing/context.ts';
import { makeClip, probeMedia } from '../testing/media.ts';
import { memoryReader, sample, sampleFiles, sampleNarration } from '../testing/sample-change.ts';
import { detectImage } from '../visuals/image.ts';
import { buildRenderPlan, buildTimeline } from '../visuals/index.ts';
import { extractFrames } from '../visuals/recording-frames.ts';
import { locateBrowser } from './browser.ts';
import {
  BROWSER_ARGS,
  type BrowserLauncher,
  ChromiumRenderer,
  renderStillFrames,
} from './chromium-renderer.ts';
import { buildPageHtml, PlanPage } from './page.ts';

const tools = await resolveFfmpeg(testConfig()).catch(() => null);
const browser = await locateBrowser(testConfig()).catch(() => null);
const available = tools !== null && browser !== null;

/** The gray level the stand-in runtime draws for a frame; frames 20 to 39 look the same. */
const shownFrame = (frame: number): number => (frame >= 20 && frame < 40 ? 20 : frame);
const levelOf = (frame: number): number => 16 + ((shownFrame(frame) * 7) % 200);

const STUB_RUNTIME = `
(function () {
  var plan = null, node = null, last = -1;
  window.__MERGESTORY__ = {
    load: function (p) {
      plan = p;
      document.body.style.margin = '0';
      node = document.createElement('div');
      node.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0';
      document.body.appendChild(node);
      return Promise.resolve();
    },
    seek: function (t) {
      var frame = Math.round(t * plan.fps);
      var shown = frame >= 20 && frame < 40 ? 20 : frame;
      var level = 16 + (shown * 7) % 200;
      var dirty = shown !== last;
      last = shown;
      node.style.background = 'rgb(' + level + ',' + level + ',' + level + ')';
      return { dirty: dirty };
    }
  };
})();
`;

/** Few frames per second keep the tests quick; segments are still four seconds long. */
const STUB_FPS = 12;

function stubPlan(durationSec: number, fps = STUB_FPS, width = 320, height = 180): RenderPlan {
  return {
    version: 1,
    width,
    height,
    fps,
    durationSec,
    theme: 'dark',
    meta: {
      title: 'Stub',
      repoLabel: 'acme/demo',
      changeLabel: 'PR #1',
      headShort: 'abc1234',
      stats: { files: 1, additions: 1, deletions: 0 },
      engineVersion: '0.0.0',
    },
    captions: { enabled: true, cues: [] },
    chapters: [],
    scenes: [],
    outro: {
      startSec: Math.max(0, durationSec - 1),
      durationSec: 1,
      tagline: 'Every change has a story.',
      lines: [],
    },
  };
}

/** A minimal plan for the real runtime: a title scene followed by the end card. */
function minimalPlan(durationSec: number, width: number, height: number, fps: number): RenderPlan {
  return {
    version: 1,
    width,
    height,
    fps,
    durationSec,
    theme: 'dark',
    meta: {
      title: 'Retry failed forecasts',
      repoLabel: 'example/weather',
      changeLabel: 'PR #42',
      headShort: '3f9c2ab',
      stats: { files: 3, additions: 40, deletions: 6 },
      engineVersion: '1.0.0',
    },
    captions: { enabled: true, cues: [{ startSec: 0.8, endSec: 1.8, text: 'Forecast calls now retry.' }] },
    chapters: [{ title: 'The change', startSec: 0 }],
    scenes: [
      {
        id: 's1',
        role: 'mission',
        title: 'The change',
        startSec: 0,
        durationSec: durationSec - 0.5,
        transitionIn: { type: 'none', durationSec: 0 },
        beats: [{ index: 0, startSec: 0.8, durationSec: 1, text: 'Forecast calls now retry.' }],
        visual: {
          type: 'title',
          kicker: 'Pull request #42',
          heading: 'Retry failed forecast requests',
          subheading: 'example/weather',
          chips: ['client', 'retry'],
        },
        refs: [],
        badges: [],
      },
    ],
    outro: {
      startSec: durationSec - 0.5,
      durationSec: 0.5,
      tagline: 'Every change has a story.',
      lines: [
        'example/weather · PR #42',
        'Commit 3f9c2ab',
        'This video explains the change. It does not replace code review.',
      ],
    },
  };
}

describe.skipIf(!available)('rendering with a real browser and FFmpeg', () => {
  let dir: string;
  let n = 0;
  const config = testConfig({ quality: 'draft' });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-render-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function outDir(): Promise<string> {
    const path = join(dir, `run-${n++}`);
    await mkdir(path, { recursive: true });
    return path;
  }

  async function grayFrames(video: string, width: number, height: number): Promise<Buffer[]> {
    const result = await runCommand(tools!.ffmpeg, [
      ...['-hide_banner', '-loglevel', 'error', '-i', video],
      ...['-vf', 'scale=in_range=tv:out_range=full:flags=accurate_rnd,format=gray'],
      ...['-f', 'rawvideo', 'pipe:1'],
    ]);
    const size = width * height;
    const frames: Buffer[] = [];
    for (let offset = 0; offset + size <= result.stdoutBuffer.length; offset += size)
      frames.push(result.stdoutBuffer.subarray(offset, offset + size));
    return frames;
  }

  async function tone(seconds: number, name: string): Promise<string> {
    const path = join(dir, name);
    await runCommand(tools!.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-ac',
      '1',
      path,
    ]);
    return path;
  }

  const stubRenderer = (options: { workers?: number; config?: ReturnType<typeof testConfig> } = {}) =>
    new ChromiumRenderer(options.config ?? config, { runtimeJs: STUB_RUNTIME, workers: options.workers });

  it('renders every frame in order, across segments and parallel browsers', async () => {
    const plan = stubPlan(14); // 168 frames: segments of 48, 48, 48 and 24
    const out = await outDir();
    const events: ProgressEvent[] = [];
    const ctx = testContext({ config, home: out, runDir: out, onProgress: (e) => events.push(e) }).ctx;
    const result = await stubRenderer({ workers: 2 }).render(
      { plan, audioPath: null, outDir: out, quality: 'draft' },
      ctx,
    );

    expect(result).toMatchObject({ width: 320, height: 180, fps: STUB_FPS, frames: 168, reusedFrames: 19 });
    expect(result.videoPath).toBe(join(out, 'video.mp4'));
    expect(result.posterPath).toBe(join(out, 'poster.jpg'));
    expect(result.durationSec).toBeCloseTo(14, 1);
    expect(result.sizeBytes).toBe((await stat(result.videoPath)).size);

    const frames = await grayFrames(result.videoPath, 320, 180);
    expect(frames).toHaveLength(168);
    for (let i = 0; i < frames.length; i++) {
      const centre = frames[i]![90 * 320 + 160]!;
      expect(Math.abs(centre - levelOf(i)), `frame ${i}`).toBeLessThanOrEqual(4);
    }

    // The poster is the frame 1.5 s in (this plan has no title scene).
    const poster = await readFile(result.posterPath!);
    expect(detectImage(poster)).toMatchObject({ mime: 'image/jpeg', width: 320, height: 180 });
    const decoded = await runCommand(tools!.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      result.posterPath!,
      '-vf',
      'format=gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    expect(Math.abs(decoded.stdoutBuffer[90 * 320 + 160]! - levelOf(1.5 * STUB_FPS))).toBeLessThanOrEqual(4);

    // Progress: only 'render' events, never decreasing, at least 2% apart until the end.
    const progress = events.filter((e) => e.status === 'progress');
    expect(progress.length).toBeGreaterThan(5);
    expect(progress.every((e) => e.stage === 'render')).toBe(true);
    const values = progress.map((e) => e.progress!);
    expect(values.at(-1)).toBe(1);
    for (let i = 1; i < values.length - 1; i++)
      expect(values[i]! - values[i - 1]!).toBeGreaterThanOrEqual(0.02 - 1e-9);

    // Nothing but the two outputs is left behind.
    expect((await readdir(out)).sort()).toEqual(['poster.jpg', 'video.mp4']);
  }, 90_000);

  it('gives the same video whatever the number of browsers, and whether or not unchanged frames are reused', async () => {
    const plan = stubPlan(10); // 120 frames: three segments
    const render = async (workers: number, reuse: boolean) => {
      const out = await outDir();
      const cfg = testConfig({ quality: 'draft', render: { reuseStaticFrames: reuse } });
      const result = await stubRenderer({ workers, config: cfg }).render(
        { plan, audioPath: null, outDir: out, quality: 'draft' },
        testContext({ config: cfg, home: out, runDir: out }).ctx,
      );
      return { result, bytes: await readFile(result.videoPath) };
    };
    const single = await render(1, true);
    const parallel = await render(3, true);
    const everyFrame = await render(2, false);
    expect(single.result.reusedFrames).toBe(19);
    expect(everyFrame.result.reusedFrames).toBe(0);
    expect(parallel.bytes.equals(single.bytes)).toBe(true);
    expect(everyFrame.bytes.equals(single.bytes)).toBe(true);
  }, 120_000);

  it('restarts a browser that dies and still produces the same video', async () => {
    const plan = stubPlan(14);
    const run = async (launch?: BrowserLauncher) => {
      const out = await outDir();
      const renderer = new ChromiumRenderer(config, { runtimeJs: STUB_RUNTIME, workers: 1, launch });
      const result = await renderer.render(
        { plan, audioPath: null, outDir: out, quality: 'draft' },
        testContext({ config, home: out, runDir: out }).ctx,
      );
      return { result, bytes: await readFile(result.videoPath) };
    };
    const clean = await run();
    let launches = 0;
    const crashing: BrowserLauncher = async (executablePath) => {
      const instance = await chromium.launch({ executablePath, headless: true, args: BROWSER_ARGS });
      launches++;
      if (launches === 1) setTimeout(() => void instance.close(), 150); // the first browser dies mid-render
      return instance;
    };
    const recovered = await run(crashing);
    expect(launches).toBeGreaterThanOrEqual(2);
    expect(recovered.result.frames).toBe(168);
    expect(recovered.bytes.equals(clean.bytes)).toBe(true);
  }, 120_000);

  it('adds the narration, padded or cut to the video length', async () => {
    const plan = stubPlan(4);
    for (const [seconds, name] of [
      [1, 'short.wav'],
      [7, 'long.wav'],
    ] as const) {
      const out = await outDir();
      const audioPath = await tone(seconds, name);
      const result = await stubRenderer().render(
        { plan, audioPath, outDir: out, quality: 'draft' },
        testContext({ config, home: out, runDir: out }).ctx,
      );
      const media = await probeMedia(tools!.ffprobe, result.videoPath);
      const video = media.streams.find((s) => s.type === 'video')!;
      const audio = media.streams.find((s) => s.type === 'audio')!;
      expect(audio).toMatchObject({ codec: 'aac', sampleRate: 48000 });
      expect(video.pixFmt).toBe('yuv420p');
      expect(media.durationSec).toBeCloseTo(4, 1);
      expect(result.durationSec).toBeCloseTo(4, 1);
    }
  }, 90_000);

  it('makes a silent video when there is no audio track', async () => {
    const out = await outDir();
    const result = await stubRenderer().render(
      { plan: stubPlan(2), audioPath: null, outDir: out, quality: 'draft' },
      testContext({ config, home: out, runDir: out }).ctx,
    );
    const media = await probeMedia(tools!.ffprobe, result.videoPath);
    expect(media.streams.map((s) => s.type)).toEqual(['video']);
  }, 60_000);

  it('stops when the run is cancelled, and cleans up', async () => {
    const out = await outDir();
    const controller = new AbortController();
    const ctx = testContext({
      config,
      home: out,
      runDir: out,
      signal: controller.signal,
      onProgress: (e) => {
        if (e.status === 'progress' && (e.progress ?? 0) >= 0.1) controller.abort();
      },
    }).ctx;
    await expect(
      stubRenderer({ workers: 2 }).render(
        { plan: stubPlan(14), audioPath: null, outDir: out, quality: 'draft' },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(await readdir(out)).toEqual([]);

    const already = new AbortController();
    already.abort();
    const out2 = await outDir();
    await expect(
      stubRenderer().render(
        { plan: stubPlan(2), audioPath: null, outDir: out2, quality: 'draft' },
        testContext({ config, home: out2, runDir: out2, signal: already.signal }).ctx,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(await readdir(out2)).toEqual([]);
  }, 90_000);

  it('stops at once when the run is cancelled while the browser no longer answers', async () => {
    const out = await outDir();
    const controller = new AbortController();
    let closed = false;
    // A browser that never answers: only closing it ends what waits on it.
    const hanging: BrowserLauncher = async () => {
      let giveUp: (reason: Error) => void = () => undefined;
      const never = new Promise<never>((_resolve, reject) => {
        giveUp = reject;
      });
      setTimeout(() => controller.abort(), 100);
      return {
        newContext: () => never,
        close: async () => {
          closed = true;
          giveUp(new Error('Target page, context or browser has been closed'));
        },
      } as unknown as Browser;
    };
    const started = performance.now();
    await expect(
      new ChromiumRenderer(config, { runtimeJs: STUB_RUNTIME, workers: 1, launch: hanging }).render(
        { plan: stubPlan(2), audioPath: null, outDir: out, quality: 'draft' },
        testContext({ config, home: out, runDir: out, signal: controller.signal }).ctx,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(closed).toBe(true);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(await readdir(out)).toEqual([]);
  }, 30_000);

  it('stops at once when the run is cancelled while a browser never starts', async () => {
    const out = await outDir();
    const controller = new AbortController();
    const never: BrowserLauncher = () => {
      setTimeout(() => controller.abort(), 100);
      return new Promise<Browser>(() => undefined);
    };
    const started = performance.now();
    await expect(
      new ChromiumRenderer(config, { runtimeJs: STUB_RUNTIME, workers: 1, launch: never }).render(
        { plan: stubPlan(2), audioPath: null, outDir: out, quality: 'draft' },
        testContext({ config, home: out, runDir: out, signal: controller.signal }).ctx,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(await readdir(out)).toEqual([]);
  }, 30_000);

  it('closes a browser that only starts after the run was cancelled', async () => {
    const out = await outDir();
    const controller = new AbortController();
    let closed = false;
    const late: BrowserLauncher = () => {
      setTimeout(() => controller.abort(), 50);
      return new Promise<Browser>((resolve) => {
        setTimeout(
          () =>
            resolve({
              close: async () => {
                closed = true;
              },
            } as unknown as Browser),
          300,
        );
      });
    };
    await expect(
      new ChromiumRenderer(config, { runtimeJs: STUB_RUNTIME, workers: 1, launch: late }).render(
        { plan: stubPlan(2), audioPath: null, outDir: out, quality: 'draft' },
        testContext({ config, home: out, runDir: out, signal: controller.signal }).ctx,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    // The browser arrives 300 ms after the start. Nobody waits for it, and it is closed all the same.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(closed).toBe(true);
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'leaves no video when the run is cancelled in the last step, after the video is assembled',
    async () => {
      const out = await outDir();
      // An ffprobe that says it started and then never answers: the render waits in its last check.
      const marker = join(dir, `probe-started-${n}`);
      const slowProbe = join(dir, `slow-ffprobe-${n}.sh`);
      await writeFile(slowProbe, `#!/bin/sh\n: > '${marker}'\nexec sleep 60\n`, { mode: 0o755 });
      const slow = testConfig({ quality: 'draft', render: { ffprobePath: slowProbe } });
      const controller = new AbortController();
      const rendering = new ChromiumRenderer(slow, { runtimeJs: STUB_RUNTIME, workers: 1 })
        .render(
          { plan: stubPlan(2), audioPath: null, outDir: out, quality: 'draft' },
          testContext({ config: slow, home: out, runDir: out, signal: controller.signal }).ctx,
        )
        .then(
          () => 'finished',
          // The stop can surface as the cancel of the last program, which callers report as ABORTED too.
          (error: unknown) => toMergeStoryError(error).code,
        );
      for (let waited = 0; waited < 60_000 && !(await stat(marker).catch(() => null)); waited += 50)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await stat(marker).catch(() => null)).not.toBeNull();
      // The video is assembled by now. A stop here must still leave nothing in the folder.
      controller.abort();
      expect(await rendering).toBe('ABORTED');
      expect(await readdir(out)).toEqual([]);
    },
    90_000,
  );

  it('reports a failing runtime with the reason, and cleans up', async () => {
    const failing = STUB_RUNTIME.replace(
      'var frame = Math.round',
      'if (t > 1) throw new Error("template exploded"); var frame = Math.round',
    );
    const out = await outDir();
    const renderer = new ChromiumRenderer(config, { runtimeJs: failing, workers: 1 });
    await expect(
      renderer.render(
        { plan: stubPlan(4), audioPath: null, outDir: out, quality: 'draft' },
        testContext({ config, home: out, runDir: out }).ctx,
      ),
    ).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: expect.stringContaining('template exploded'),
    });
    expect(await readdir(out)).toEqual([]);
  }, 60_000);

  it('keeps the video when the poster cannot be captured, and returns no poster', async () => {
    // Only the poster page starts by seeking to 1.5 s, so only the poster fails.
    const noPoster = STUB_RUNTIME.replace(
      'var frame = Math.round',
      'if (last === -1 && t === 1.5) throw new Error("poster exploded"); var frame = Math.round',
    );
    const out = await outDir();
    const harness = testContext({ config, home: out, runDir: out });
    const result = await new ChromiumRenderer(config, { runtimeJs: noPoster, workers: 1 }).render(
      { plan: stubPlan(14), audioPath: null, outDir: out, quality: 'draft' },
      harness.ctx,
    );
    expect(result.posterPath).toBeNull();
    expect(result.frames).toBe(168);
    expect((await stat(result.videoPath)).size).toBeGreaterThan(0);
    expect(await readdir(out)).toEqual(['video.mp4']);
  }, 120_000);

  it('tells the user what to do when the browser fails because of its sandbox', async () => {
    const launch: BrowserLauncher = async () => {
      throw new Error('No usable sandbox! Update your kernel.');
    };
    const out = await outDir();
    await expect(
      renderStillFrames(stubPlan(4), [0], out, testContext({ config, home: out, runDir: out }).ctx, {
        runtimeJs: STUB_RUNTIME,
        launch,
      }),
    ).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      hint: expect.stringContaining('sandbox'),
    });
  }, 60_000);

  it('rejects plans the encoder cannot use, and a missing audio file', async () => {
    const out = await outDir();
    const ctx = testContext({ config, home: out, runDir: out }).ctx;
    const render = (plan: RenderPlan, audioPath: string | null = null) =>
      stubRenderer().render({ plan, audioPath, outDir: out, quality: 'draft' }, ctx);
    await expect(render(stubPlan(2, 24, 321, 180))).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: expect.stringContaining('even'),
    });
    await expect(render(stubPlan(2, 0))).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    await expect(render(stubPlan(0))).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    await expect(render(stubPlan(2), join(dir, 'missing.wav'))).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: expect.stringContaining('audio'),
    });
  }, 60_000);

  it('renders single frames to PNG files', async () => {
    const out = join(await outDir(), 'stills');
    const plan = stubPlan(6);
    const files = await renderStillFrames(
      plan,
      [0, 1.5, 3.25],
      out,
      testContext({ config, home: out, runDir: out }).ctx,
      {
        runtimeJs: STUB_RUNTIME,
      },
    );
    expect(files.map((f) => f.slice(out.length + 1))).toEqual([
      'frame-0000.00.png',
      'frame-0001.50.png',
      'frame-0003.25.png',
    ]);
    for (const file of files) {
      expect(detectImage(await readFile(file))).toMatchObject({ mime: 'image/png', width: 320, height: 180 });
    }
    await expect(
      renderStillFrames(plan, [-1], out, testContext({ config, home: out, runDir: out }).ctx, {
        runtimeJs: STUB_RUNTIME,
      }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  }, 60_000);

  describe('network access', () => {
    let server: Server;
    let hits: string[];
    let origin: string;
    beforeAll(async () => {
      hits = [];
      server = createServer((request, response) => {
        hits.push(request.url ?? '');
        response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const callingOut = (url: string) =>
      STUB_RUNTIME.replace(
        'plan = p;',
        `plan = p; try { fetch('${url}/fetch'); var i = new Image(); i.src = '${url}/image.png'; var s = document.createElement('script'); s.src = '${url}/script.js'; document.head.appendChild(s); } catch (e) {}`,
      );

    it('makes no request at all from a rendered page', async () => {
      const out = await outDir();
      const renderer = new ChromiumRenderer(config, { runtimeJs: callingOut(origin), workers: 1 });
      await renderer.render(
        { plan: stubPlan(1), audioPath: null, outDir: out, quality: 'draft' },
        testContext({ config, home: out, runDir: out }).ctx,
      );
      expect(hits).toEqual([]);
    }, 60_000);

    it('blocks requests even if the page policy were missing', async () => {
      const instance = await chromium.launch({ executablePath: browser!.path, headless: true });
      try {
        const html = buildPageHtml({ runtimeJs: callingOut(origin), fontsCss: '' }).replace(
          /<meta http-equiv="Content-Security-Policy"[^>]*>/,
          '',
        );
        expect(html).not.toContain('Content-Security-Policy');
        const page = await PlanPage.open(instance, stubPlan(1), html);
        await page.seek(0);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(hits).toEqual([]);
        expect(page.blockedRequests).toBeGreaterThan(0);
        await page.close();
      } finally {
        await instance.close();
      }
    }, 60_000);
  });

  describe('with the real runtime', () => {
    it('renders a two-second plan with narration: yuv420p, limited range, audio, poster', async () => {
      const out = await outDir();
      const audioPath = await tone(1.2, 'narration.wav');
      const plan = minimalPlan(2, 1280, 720, 24);
      const events: ProgressEvent[] = [];
      const result = await new ChromiumRenderer(config).render(
        { plan, audioPath, outDir: out, quality: 'draft' },
        testContext({ config, home: out, runDir: out, onProgress: (e) => events.push(e) }).ctx,
      );
      const media = await probeMedia(tools!.ffprobe, result.videoPath);
      const video = media.streams.find((s) => s.type === 'video')!;
      const audio = media.streams.find((s) => s.type === 'audio')!;
      expect(media.durationSec).toBeGreaterThan(1.9);
      expect(media.durationSec).toBeLessThan(2.1);
      expect(video).toMatchObject({
        codec: 'h264',
        width: 1280,
        height: 720,
        pixFmt: 'yuv420p',
        colorRange: 'tv',
        colorSpace: 'bt709',
        colorTransfer: 'bt709',
        colorPrimaries: 'bt709',
        frameRate: '24/1',
      });
      expect(audio).toMatchObject({ codec: 'aac', sampleRate: 48000 });
      expect(result).toMatchObject({ width: 1280, height: 720, fps: 24, frames: 48 });
      expect(result.sizeBytes).toBeGreaterThan(10_000);
      expect(detectImage(await readFile(result.posterPath!))).toMatchObject({
        mime: 'image/jpeg',
        width: 1280,
        height: 720,
      });
      expect(events.some((e) => e.stage === 'render')).toBe(true);
      expect((await readdir(out)).sort()).toEqual(['poster.jpg', 'video.mp4']);
    }, 90_000);

    it('gives the same video whichever browser draws which segment', async () => {
      // A plan built from the sample change: scenes, code, diagram and transitions across segment borders.
      const base = sample();
      const timeline = buildTimeline(base.storyboard, sampleNarration(base.storyboard));
      const built = await buildRenderPlan(
        {
          storyboard: base.storyboard,
          timeline,
          cues: [],
          changeSet: base.changeSet,
          analysis: base.analysis,
          inputs: base.inputs,
          reader: memoryReader(sampleFiles()),
          config,
          theme: await loadTheme('midnight'),
        },
        testContext({ config, home: dir, runDir: dir }).ctx,
      );
      const plan: RenderPlan = { ...built, width: 640, height: 360, fps: 12, durationSec: 10 };
      const render = async (workers: number) => {
        const out = await outDir();
        const renderer = new ChromiumRenderer(config, { workers });
        const result = await renderer.render(
          { plan, audioPath: null, outDir: out, quality: 'draft' },
          testContext({ config, home: out, runDir: out }).ctx,
        );
        return readFile(result.videoPath);
      };
      const single = await render(1);
      const parallel = await render(3);
      expect(parallel.equals(single)).toBe(true);
    }, 120_000);

    describe('a recording', () => {
      const FPS = 12;
      const SECONDS = 10;
      /** A clip of six seconds whose picture changes all the time, cut into frames, and a plan that shows it from 0.5 s. */
      async function recordingRun() {
        const out = await outDir();
        const clip = join(dir, `clip-${n}.mp4`);
        expect(await makeClip(tools!.ffmpeg, clip, { seconds: 6, size: '640x360' })).toBe(true);
        const dirName = 'recording-frames/s-1';
        const made = await extractFrames(tools!.ffmpeg, {
          recording: {
            id: 'RC1',
            path: clip,
            caption: '',
            moment: 'other',
            durationSec: 6,
            width: 640,
            height: 360,
            codec: 'h264',
          },
          trim: { start: 0, end: 6 },
          zoom: null,
          box: { width: 640, height: 300 },
          outDir: join(out, dirName),
        });
        const base = minimalPlan(SECONDS, 640, 360, FPS);
        const plan: RenderPlan = {
          ...base,
          scenes: [
            {
              ...base.scenes[0]!,
              durationSec: SECONDS - 0.5,
              visual: {
                type: 'recording',
                caption: null,
                frames: { dir: dirName, ...made, fps: RECORDING_FPS, startSec: 0.5, speed: 1 },
              },
            },
          ],
        };
        return { out, plan, made };
      }

      const renderWith = async (plan: RenderPlan, out: string, workers: number) =>
        readFile(
          (
            await new ChromiumRenderer(config, { workers }).render(
              { plan, audioPath: null, outDir: out, quality: 'draft' },
              testContext({ config, home: out, runDir: out }).ctx,
            )
          ).videoPath,
        );

      it('shows different pictures of the clip over time, and sends each page only the frames it can show', async () => {
        const { out, plan, made } = await recordingRun();
        expect(made.count).toBeGreaterThan(60);
        const opened: { media: number; page: PlanPage }[] = [];
        const original = PlanPage.open.bind(PlanPage);
        const spy = vi.spyOn(PlanPage, 'open').mockImplementation(async (b, p, html, logger) => {
          const page = await original(b, p, html, logger);
          opened.push({
            media: Object.values(p.media ?? {}).reduce((sum, set) => sum + Object.keys(set).length, 0),
            page,
          });
          return page;
        });
        let video: string;
        try {
          video = (
            await new ChromiumRenderer(config, { workers: 1 }).render(
              { plan, audioPath: null, outDir: out, quality: 'draft' },
              testContext({ config, home: out, runDir: out }).ctx,
            )
          ).videoPath;
        } finally {
          spy.mockRestore();
        }
        const frames = await grayFrames(video, 640, 360);
        // The middle of the picture, where the clip is: the progress bar and the clock around it change anyway.
        const at = (t: number): Buffer =>
          Buffer.concat(
            Array.from({ length: 140 }, (_, row) => {
              const start = (110 + row) * 640 + 160;
              return frames[Math.round(t * FPS)]!.subarray(start, start + 320);
            }),
          );
        // Mean difference per pixel: the encoder is lossy, so a picture that rests is close, not equal.
        const apart = (a: number, b: number): number => {
          const [x, y] = [at(a), at(b)];
          return x.reduce((sum, value, i) => sum + Math.abs(value - y[i]!), 0) / x.length;
        };
        expect(apart(1.5, 3)).toBeGreaterThan(5);
        expect(apart(3, 5)).toBeGreaterThan(5);
        // After the clip the scene rests on its last picture.
        expect(apart(8.5, 9.5)).toBeLessThan(1.5);

        // Three segments and a poster. The first two get the part of the clip that plays in them; the last and the poster, one frame.
        const counts = opened.map((o) => o.media);
        expect(counts).toHaveLength(4);
        expect(counts.filter((c) => c === 1)).toHaveLength(2);
        expect(Math.max(...counts)).toBeLessThan(made.count);
        // Every frame goes to about one page, not to all four.
        expect(counts.reduce((a, b) => a + b, 0)).toBeLessThan(made.count + 8);
        // Nothing was requested over the network.
        expect(opened.map((o) => o.page.blockedRequests)).toEqual(counts.map(() => 0));
        expect(opened.flatMap((o) => o.page.pageErrors)).toEqual([]);
      }, 120_000);

      it('gives the same video for one browser and for three', async () => {
        const { out, plan } = await recordingRun();
        const single = await renderWith(plan, out, 1);
        const parallel = await renderWith(plan, out, 3);
        expect(parallel.equals(single)).toBe(true);
      }, 120_000);

      it('names a frame file that is missing', async () => {
        const { out, plan } = await recordingRun();
        await rm(join(out, 'recording-frames/s-1/f-00001.jpg'));
        await expect(renderWith(plan, out, 1)).rejects.toMatchObject({
          code: 'RENDER_FAILED',
          message: expect.stringContaining('recording-frames/s-1/f-00001.jpg'),
        });
      }, 60_000);
    });

    describe('recordings in a later scene', () => {
      const FPS = 12;
      const W = 640;
      const H = 360;
      const clipOf = async (name: string, luma: string): Promise<string> => {
        const path = join(dir, `${name}-${n++}.mp4`);
        const made = await runCommand(
          tools!.ffmpeg,
          [
            ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=12:duration=6'],
            ...['-vf', `format=yuv420p,geq=lum='${luma}':cb=128:cr=128`],
            ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', path],
          ],
          { allowFailure: true, timeoutMs: 60_000 },
        );
        return made.code === 0 ? path : '';
      };
      const cut = async (
        path: string,
        out: string,
        dirName: string,
        box: { width: number; height: number },
      ) => ({
        dir: dirName,
        ...(await extractFrames(tools!.ffmpeg, {
          recording: {
            id: 'RC1',
            path,
            caption: '',
            moment: 'other',
            durationSec: 6,
            width: 320,
            height: 240,
            codec: 'h264',
          },
          trim: { start: 0, end: 6 },
          zoom: null,
          box,
          outDir: join(out, dirName),
        })),
      });

      it('plays each clip from its own start, on scene time, in a scene that is not the first', async () => {
        // The brightness of a clip rises with its time (up) or falls with it (down), so the picture tells the clip time.
        const up = await clipOf('up', '16+36*T');
        const down = await clipOf('down', '220-36*T');
        expect(up).not.toBe('');
        expect(down).not.toBe('');
        const out = await outDir();
        const base = minimalPlan(13, W, H, FPS);
        const title = { ...base.scenes[0]!, durationSec: 2 };
        const beats = [
          { index: 0, startSec: 6.8, durationSec: 1, text: 'Before.' },
          { index: 1, startSec: 8.4, durationSec: 1, text: 'After.' },
        ];
        const compare = {
          ...title,
          id: 's3',
          role: 'under-the-hood' as const,
          startSec: 6,
          durationSec: 6,
          beats,
          transitionIn: { type: 'none' as const, durationSec: 0 },
        };
        const starts = scenePanelStarts(compare);
        const panelFrames = async (side: 'before' | 'after', clip: string, startSec: number) => ({
          ...(await cut(clip, out, frameDirFor(3, side), { width: 280, height: 200 })),
          fps: RECORDING_FPS,
          startSec,
          speed: 1,
        });
        const plan: RenderPlan = {
          ...base,
          scenes: [
            title,
            {
              ...title,
              id: 's2',
              role: 'under-the-hood',
              startSec: 2,
              durationSec: 4,
              beats: [],
              visual: {
                type: 'recording',
                caption: null,
                frames: {
                  ...(await cut(up, out, frameDirFor(2, null), { width: 640, height: 300 })),
                  fps: RECORDING_FPS,
                  startSec: 0.5,
                  speed: 1,
                },
              },
            },
            {
              ...compare,
              visual: {
                type: 'before-after',
                caption: null,
                before: {
                  label: 'Before',
                  kind: 'recording',
                  frames: await panelFrames('before', up, starts.before + PANEL_CLIP_DELAY_SEC),
                },
                after: {
                  label: 'After',
                  kind: 'recording',
                  frames: await panelFrames('after', down, starts.after + PANEL_CLIP_DELAY_SEC),
                },
              },
            },
          ],
          outro: { ...base.outro, startSec: 12, durationSec: 1 },
        };
        const video = (
          await new ChromiumRenderer(config, { workers: 1 }).render(
            { plan, audioPath: null, outDir: out, quality: 'draft' },
            testContext({ config, home: out, runDir: out }).ctx,
          )
        ).videoPath;
        const frames = await grayFrames(video, W, H);
        const gray = (t: number, x: number, y: number): number => frames[Math.round(t * FPS)]![y * W + x]!;
        // The brightness is about 42 levels per second of clip, so a level tells the second of the clip.
        const LEVELS_PER_SEC = 42;
        // The recording scene starts at 2 s and its clip at 0.5 s into the scene: video second 3.5 is clip second 1.
        // Video time instead of scene time would show clip second 3.
        for (const [t, clipSec] of [
          [3.5, 1],
          [5, 2.5],
        ] as const) {
          expect(Math.abs(gray(t, 320, 175) - clipSec * LEVELS_PER_SEC), `video second ${t}`).toBeLessThan(
            14,
          );
        }
        // Each panel plays its own clip from its own start: the left one rises, the right one falls, and
        // neither shows the "Image unavailable" picture, which never changes.
        const before = [9, 10, 11].map((t) => gray(t, 170, 185));
        const after = [9, 10, 11].map((t) => gray(t, 470, 185));
        expect(before[1]!).toBeGreaterThan(before[0]! + 15);
        expect(before[2]!).toBeGreaterThan(before[1]! + 15);
        expect(after[1]!).toBeLessThan(after[0]! - 15);
        expect(after[2]!).toBeLessThan(after[1]! - 15);
        // The left clip has only run for about 0.75 s at video second 8: it is still dark, not at its end.
        expect(gray(8, 170, 185)).toBeLessThan(70);
      }, 180_000);
    });

    describe('highlights and a focus', () => {
      const W = 1280;
      const H = 720;
      const FPS = 12;
      type Frame = { rgb: Buffer };
      type Pixel = [number, number, number];
      const REC_DIR = 'recording-frames/s-6';

      /** A picture of four quarters: red top left, green top right, blue bottom left, yellow bottom right. */
      async function quartersPng(
        width: number,
        height: number,
      ): Promise<{ src: string; width: number; height: number }> {
        const path = join(dir, `quarters-${n++}.png`);
        const [w, h] = [width / 2, height / 2];
        const made = await runCommand(
          tools!.ffmpeg,
          [
            ...['-v', 'error', '-y', '-f', 'lavfi', '-i'],
            `color=c=0xE02020:size=${width}x${height},drawbox=x=${w}:y=0:w=${w}:h=${h}:color=0x20C020:t=fill,drawbox=x=0:y=${h}:w=${w}:h=${h}:color=0x2040E0:t=fill,drawbox=x=${w}:y=${h}:w=${w}:h=${h}:color=0xE0D020:t=fill`,
            ...['-frames:v', '1', path],
          ],
          { allowFailure: true, timeoutMs: 30_000 },
        );
        expect(made.code).toBe(0);
        const bytes = await readFile(path);
        return { src: `data:image/png;base64,${bytes.toString('base64')}`, width, height };
      }

      /** A clip of seven seconds that shows the same four quarters, with a white bar that crosses them from left to right every 3.2 s. */
      async function barClip(): Promise<string> {
        const path = join(dir, `bar-${n++}.mp4`);
        const made = await runCommand(
          tools!.ffmpeg,
          [
            ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xE02020:size=640x360:rate=12:duration=7'],
            ...['-f', 'lavfi', '-i', 'color=c=white:size=8x360:rate=12:duration=7'],
            '-filter_complex',
            "[0]drawbox=x=320:y=0:w=320:h=180:color=0x20C020:t=fill,drawbox=x=0:y=180:w=320:h=180:color=0x2040E0:t=fill,drawbox=x=320:y=180:w=320:h=180:color=0xE0D020:t=fill[bg];[bg][1]overlay=x='mod(t*200,640)':y=0,format=yuv420p",
            ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', path],
          ],
          { allowFailure: true, timeoutMs: 60_000 },
        );
        expect(made.code).toBe(0);
        return path;
      }

      /** One frame of the video as RGB, at second `t`. */
      async function frameAt(video: string, t: number): Promise<Frame> {
        const result = await runCommand(tools!.ffmpeg, [
          ...['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', video],
          ...['-vf', 'scale=in_range=tv:out_range=full:flags=accurate_rnd'],
          ...['-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        ]);
        return { rgb: result.stdoutBuffer };
      }
      const pixel = (f: Frame, x: number, y: number): Pixel => {
        const i = (y * W + x) * 3;
        return [f.rgb[i]!, f.rgb[i + 1]!, f.rgb[i + 2]!];
      };
      const QUARTER_COLORS: Pixel[] = [
        [0xe0, 0x20, 0x20],
        [0x20, 0xc0, 0x20],
        [0x20, 0x40, 0xe0],
        [0xe0, 0xd0, 0x20],
      ];
      const near = (a: Pixel, b: Pixel, within: number): boolean =>
        Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < within;
      /** The accent of the theme (#8c7bff), which no quarter has. */
      const isAccent = (p: Pixel): boolean => near(p, [0x8c, 0x7b, 0xff], 70);
      const isDark = (p: Pixel): boolean => p[0] < 40 && p[1] < 40 && p[2] < 40;
      const isWhite = (p: Pixel): boolean => p[0] > 215 && p[1] > 215 && p[2] > 215;
      /** A few pixels where two colours of the picture meet can look like the box. A real box has hundreds. */
      const STRAY = 12;

      type Box = { x0: number; y0: number; x1: number; y1: number };
      /** The smallest box around the pixels that have one of the four colours (the picture, whole or zoomed). */
      function pictureBox(f: Frame, within: { x0: number; x1: number } = { x0: 0, x1: W }): Box {
        const box: Box = { x0: W, y0: H, x1: 0, y1: 0 };
        for (let y = 0; y < H; y += 2) {
          for (let x = within.x0; x < within.x1; x += 2) {
            if (!QUARTER_COLORS.some((c) => near(pixel(f, x, y), c, 40))) continue;
            box.x0 = Math.min(box.x0, x);
            box.y0 = Math.min(box.y0, y);
            box.x1 = Math.max(box.x1, x);
            box.y1 = Math.max(box.y1, y);
          }
        }
        return box;
      }
      /** The pixels of a box that pass a test; the rim of the picture is left out, where the window's edge is. */
      function* pixelsOf(f: Frame, box: Box, test: (p: Pixel) => boolean): Generator<[number, number]> {
        for (let y = box.y0 + 8; y <= box.y1 - 8; y++) {
          for (let x = box.x0 + 8; x <= box.x1 - 8; x++) if (test(pixel(f, x, y))) yield [x, y];
        }
      }
      const count = (f: Frame, box: Box, test: (p: Pixel) => boolean): number =>
        [...pixelsOf(f, box, test)].length;
      /** Pixels of a rectangle that pass a test. */
      const countIn = (f: Frame, rect: Box, test: (p: Pixel) => boolean): number => {
        let found = 0;
        for (let y = Math.round(rect.y0); y <= Math.round(rect.y1); y++) {
          for (let x = Math.round(rect.x0); x <= Math.round(rect.x1); x++) if (test(pixel(f, x, y))) found++;
        }
        return found;
      };
      /** The accent or a dimmed accent (the "before" side steps back once "after" arrives); the green quarter has none of it. */
      const isBluish = (p: Pixel): boolean => p[2] > 150 && p[2] - p[1] > 70 && p[2] - p[0] > 40;
      /** The smallest box around the accent pixels of a picture: that of an unlabelled highlight is the highlight. */
      function accentBox(f: Frame, picture: Box): Box {
        const found: Box = { x0: W, y0: H, x1: 0, y1: 0 };
        for (const [x, y] of pixelsOf(f, picture, isAccent)) {
          found.x0 = Math.min(found.x0, x);
          found.y0 = Math.min(found.y0, y);
          found.x1 = Math.max(found.x1, x);
          found.y1 = Math.max(found.y1, y);
        }
        return found;
      }
      /** Where the box `at` (fractions of the picture) lies in a picture that is drawn in `picture`. */
      const placed = (picture: Box, at: { x: number; y: number; w: number; h: number }): Box => {
        const [w, h] = [picture.x1 - picture.x0, picture.y1 - picture.y0];
        return {
          x0: picture.x0 + at.x * w,
          y0: picture.y0 + at.y * h,
          x1: picture.x0 + (at.x + at.w) * w,
          y1: picture.y0 + (at.y + at.h) * h,
        };
      };
      const expectBoxAt = (found: Box, wanted: Box, label: string): void => {
        for (const key of ['x0', 'y0', 'x1', 'y1'] as const)
          expect(
            Math.abs(found[key] - wanted[key]),
            `${label}: ${key} ${JSON.stringify({ found, wanted })}`,
          ).toBeLessThan(9);
      };

      /**
       * The height of the label pill in pixels: its near-black fill is the largest connected area that is
       * about as wide as a short label and as tall as a line of text. The thin black lines of a box are
       * either long and thin or wrap the whole box, so they are not that.
       */
      function pillHeight(f: Frame, picture: Box): number {
        const [w, h] = [picture.x1 - picture.x0 + 1, picture.y1 - picture.y0 + 1];
        const seen = new Uint8Array(w * h);
        const dark = (x: number, y: number): boolean => isDark(pixel(f, picture.x0 + x, picture.y0 + y));
        let best: { size: number; height: number } | null = null;
        for (let start = 0; start < w * h; start++) {
          if (seen[start] || !dark(start % w, Math.floor(start / w))) continue;
          const stack = [start];
          seen[start] = 1;
          const found = { x0: w, y0: h, x1: 0, y1: 0, size: 0 };
          while (stack.length > 0) {
            const at = stack.pop()!;
            const [x, y] = [at % w, Math.floor(at / w)];
            found.size++;
            found.x0 = Math.min(found.x0, x);
            found.x1 = Math.max(found.x1, x);
            found.y0 = Math.min(found.y0, y);
            found.y1 = Math.max(found.y1, y);
            for (const [nx, ny] of [
              [x + 1, y],
              [x - 1, y],
              [x, y + 1],
              [x, y - 1],
            ] as const) {
              if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx] || !dark(nx, ny)) continue;
              seen[ny * w + nx] = 1;
              stack.push(ny * w + nx);
            }
          }
          const [width, height] = [found.x1 - found.x0 + 1, found.y1 - found.y0 + 1];
          if (width < 40 || width > 200 || height < 14 || height > 60) continue;
          if (!best || found.size > best.size) best = { size: found.size, height };
        }
        expect(best, 'a label pill').not.toBeNull();
        return best!.height;
      }

      const highlight = (over: object) => ({
        x: 0.55,
        y: 0.15,
        w: 0.3,
        h: 0.3,
        label: null,
        beat: 1,
        ...over,
      });
      const beats = (start: number, ...rel: number[]) =>
        rel.map((r, index) => ({ index, startSec: start + r, durationSec: 1, text: `Beat ${index}.` }));

      /** Scene starts, in seconds. */
      const AT = { plain: 0, zoom: 5, compare: 14, line: 21, pill: 24, rec: 30, phone: 37 };

      async function highlightsPlan(out: string): Promise<RenderPlan> {
        const [wide, tall] = [await quartersPng(640, 360), await quartersPng(400, 800)];
        const clip = await barClip();
        const made = await extractFrames(tools!.ffmpeg, {
          recording: {
            id: 'RC1',
            path: clip,
            caption: '',
            moment: 'other',
            durationSec: 7,
            width: 640,
            height: 360,
            codec: 'h264',
          },
          trim: { start: 0, end: 7 },
          zoom: null,
          box: { width: 1680, height: 624 },
          outDir: join(out, REC_DIR),
        });
        const base = minimalPlan(42, W, H, FPS);
        const scene = (id: string, startSec: number, durationSec: number, rel: number[], visual: object) => ({
          ...base.scenes[0]!,
          id,
          startSec,
          durationSec,
          beats: beats(startSec, ...rel),
          transitionIn: { type: 'none' as const, durationSec: 0 },
          visual: visual as RenderPlan['scenes'][number]['visual'],
        });
        return {
          ...base,
          // No narration cues: nothing but the scene is drawn over the picture.
          captions: { enabled: false, cues: [] },
          scenes: [
            scene('plain', AT.plain, 5, [0.8, 3], {
              type: 'screenshot',
              image: wide,
              caption: null,
              highlights: [highlight({ label: 'The count' })],
            }),
            scene('zoom', AT.zoom, 9, [2, 4], {
              type: 'screenshot',
              image: wide,
              caption: null,
              highlights: [highlight({ x: 0.6, y: 0.6, w: 0.25, h: 0.2, label: 'The count' })],
              focus: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
            }),
            // Three beats: the panels appear at 0.65 s and 2.35 s, the highlights on beat 1 (left) and beat 2 (right).
            scene('compare', AT.compare, 7, [0.8, 2.5, 4.5], {
              type: 'before-after',
              caption: null,
              before: {
                label: 'Before',
                kind: 'screenshot',
                image: wide,
                highlights: [highlight({ beat: 1 })],
              },
              after: {
                label: 'After',
                kind: 'screenshot',
                image: wide,
                highlights: [highlight({ beat: 2 })],
              },
            }),
            // A box without a label: nothing is dark in the picture but the black line around the box.
            scene('line', AT.line, 3, [0.4, 1.4], {
              type: 'screenshot',
              image: wide,
              caption: null,
              highlights: [highlight({})],
            }),
            // A label while the camera moves in: the label keeps its size.
            scene('pill', AT.pill, 6, [0.4, 2], {
              type: 'screenshot',
              image: wide,
              caption: null,
              highlights: [highlight({ x: 0.6, y: 0.12, w: 0.25, h: 0.25, label: 'The count', beat: 0 })],
              focus: { x: 0.5, y: 0, w: 0.5, h: 0.5 },
            }),
            scene('rec', AT.rec, 7, [0.8, 3], {
              type: 'recording',
              caption: null,
              frames: { dir: REC_DIR, ...made, fps: RECORDING_FPS, startSec: 0.5, speed: 1 },
              highlights: [highlight({ x: 0.6, y: 0.6, w: 0.25, h: 0.2 })],
              focus: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
            }),
            // A tall picture is drawn in a phone frame.
            scene('phone', AT.phone, 4, [0.5, 1.5], {
              type: 'screenshot',
              image: tall,
              caption: null,
              highlights: [highlight({})],
            }),
          ],
          outro: { ...base.outro, startSec: 41, durationSec: 1 },
        };
      }

      it('draws a highlight on its beat, zooms the camera into the focus, and gives the same video for one browser and for three', async () => {
        const render = async (workers: number): Promise<{ out: string; bytes: Buffer }> => {
          const out = await outDir();
          const plan = await highlightsPlan(out);
          const result = await new ChromiumRenderer(config, { workers }).render(
            { plan, audioPath: null, outDir: out, quality: 'draft' },
            testContext({ config, home: out, runDir: out }).ctx,
          );
          return { out, bytes: await readFile(result.videoPath) };
        };
        const single = await render(1);
        const video = join(single.out, 'video.mp4');
        const at = (scene: keyof typeof AT, t: number): Promise<Frame> => frameAt(video, AT[scene] + t);

        // A screenshot scene: the box is not there before its beat (second 3), and the box and its label are there after it.
        const [plainBefore, plainAfter] = [await at('plain', 2.5), await at('plain', 4.5)];
        const plainBox = pictureBox(plainBefore);
        expect(plainBox.x1 - plainBox.x0).toBeGreaterThan(500);
        expect(count(plainBefore, plainBox, isAccent)).toBeLessThan(STRAY);
        expect(count(plainBefore, plainBox, isDark)).toBeLessThan(STRAY);
        expect(count(plainAfter, plainBox, isAccent)).toBeGreaterThan(100);
        expect(count(plainAfter, plainBox, isDark)).toBeGreaterThan(300);

        // A scene with a focus on the yellow quarter: the whole picture first, then only that quarter fills the window.
        const [zoomStart, zoomBefore, zoomEnd] = [
          await at('zoom', 1.8),
          await at('zoom', 3),
          await at('zoom', 8.4),
        ];
        const zoomBox = pictureBox(zoomStart);
        const quarter = (f: Frame, color: Pixel): number => count(f, zoomBox, (p) => near(p, color, 40));
        const area = (zoomBox.x1 - zoomBox.x0 + 1) * (zoomBox.y1 - zoomBox.y0 + 1);
        for (const color of QUARTER_COLORS) expect(quarter(zoomStart, color)).toBeGreaterThan(area * 0.15);
        expect(count(zoomBefore, zoomBox, isAccent)).toBeLessThan(STRAY);
        expect(quarter(zoomEnd, QUARTER_COLORS[3]!)).toBeGreaterThan(area * 0.8);
        for (const color of QUARTER_COLORS.slice(0, 3))
          expect(quarter(zoomEnd, color)).toBeLessThan(area * 0.01);
        // The box that the camera got to stays on the picture, with lines that grew with it.
        expect(count(zoomEnd, zoomBox, isAccent)).toBeGreaterThan(count(plainAfter, plainBox, isAccent) / 4);
        expect(count(zoomEnd, zoomBox, isDark)).toBeGreaterThan(300);

        // Before and after, in a scene with three beats. The panels appear at 0.65 s and 2.35 s; the left
        // highlight is on beat 1 (from 2.35 s) and the right one on beat 2 (from 4.35 s), so each is
        // missing while its panel is already there.
        const [compareOne, compareTwo, compareEnd] = [
          await at('compare', 1.5),
          await at('compare', 3.5),
          await at('compare', 5.8),
        ];
        const left = pictureBox(compareEnd, { x0: 0, x1: W / 2 });
        const right = pictureBox(compareEnd, { x0: W / 2, x1: W });
        expect(left.x1 - left.x0).toBeGreaterThan(200);
        expect(right.x1 - right.x0).toBeGreaterThan(200);
        expect(pictureBox(compareOne, { x0: 0, x1: W / 2 }).x1).toBeGreaterThan(left.x1 - 12);
        // Around the box of each side: nothing of the accent until its beat.
        const around = (picture: Box): Box => {
          const box = placed(picture, highlight({}));
          return { x0: box.x0 - 10, y0: box.y0 - 10, x1: box.x1 + 10, y1: box.y1 + 10 };
        };
        const [leftBox, rightBox] = [around(left), around(right)];
        expect(pictureBox(compareTwo, { x0: W / 2, x1: W }).x1).toBeGreaterThan(right.x1 - 12);
        expect(countIn(compareOne, leftBox, isBluish)).toBe(0);
        expect(countIn(compareTwo, leftBox, isBluish)).toBeGreaterThan(100);
        expect(countIn(compareTwo, rightBox, isBluish)).toBe(0);
        expect(countIn(compareEnd, leftBox, isBluish)).toBeGreaterThan(100);
        expect(countIn(compareEnd, rightBox, isBluish)).toBeGreaterThan(100);

        // A box without a label: the black line right outside the box is what is dark, nothing else, and it is not there before the beat.
        const [lineBefore, lineAfter] = [await at('line', 0.9), await at('line', 2.5)];
        const linePicture = pictureBox(lineAfter);
        const lineBox = placed(linePicture, highlight({}));
        expect(count(lineBefore, linePicture, isDark)).toBeLessThan(STRAY);
        expectBoxAt(accentBox(lineAfter, linePicture), lineBox, 'unlabelled box');
        const ring = (p: Pixel): boolean => p[0] < 100 && p[1] < 100 && p[2] < 100;
        const onRing = [...pixelsOf(lineAfter, linePicture, ring)].filter(
          ([x, y]) =>
            x > lineBox.x0 - 8 &&
            x < lineBox.x1 + 8 &&
            y > lineBox.y0 - 8 &&
            y < lineBox.y1 + 8 &&
            !(x > lineBox.x0 + 2 && x < lineBox.x1 - 2 && y > lineBox.y0 + 2 && y < lineBox.y1 - 2),
        ).length;
        expect(onRing).toBeGreaterThan(100);
        expect(count(lineAfter, linePicture, ring)).toBe(onRing);

        // The label keeps its size on the screen while the camera goes in on the box.
        const [pillStart, pillEnd] = [await at('pill', 1.15), await at('pill', 5.3)];
        const pillPicture = pictureBox(pillStart);
        const [startHeight, endHeight] = [
          pillHeight(pillStart, pillPicture),
          pillHeight(pillEnd, pillPicture),
        ];
        expect(startHeight).toBeGreaterThan(18);
        expect(Math.abs(endHeight - startHeight)).toBeLessThanOrEqual(2);
        // The picture did get closer: the green quarter now fills the window.
        expect(count(pillEnd, pillPicture, (p) => near(p, QUARTER_COLORS[1]!, 40))).toBeGreaterThan(
          (pillPicture.x1 - pillPicture.x0) * (pillPicture.y1 - pillPicture.y0) * 0.6,
        );

        // A recording: the box is not there before its beat; the camera ends on the yellow quarter while the clip keeps playing.
        const [recBefore, recEarly, recLate] = [
          await at('rec', 2.4),
          await at('rec', 5.6),
          await at('rec', 6.4),
        ];
        const recPicture = pictureBox(recLate);
        expect(count(recBefore, recPicture, isAccent)).toBeLessThan(STRAY);
        expect(count(recLate, recPicture, isAccent)).toBeGreaterThan(100);
        const recArea = (recPicture.x1 - recPicture.x0 + 1) * (recPicture.y1 - recPicture.y0 + 1);
        expect(count(recLate, recPicture, (p) => near(p, QUARTER_COLORS[3]!, 60))).toBeGreaterThan(
          recArea * 0.7,
        );
        // The white bar is at 430 and then at 540 of 640 pixels of the clip, which is the yellow half: it moves to the right of the window.
        const barX = (f: Frame): number => {
          const y = recPicture.y0 + 24;
          const xs = [...pixelsOf(f, { ...recPicture, y1: y + 8, y0: y - 8 }, isWhite)].map(([x]) => x);
          expect(xs.length, 'the bar of the clip').toBeGreaterThan(3);
          return xs.reduce((a, b) => a + b, 0) / xs.length;
        };
        expect(barX(recLate) - barX(recEarly)).toBeGreaterThan(80);

        // A tall picture in a phone frame: the box lies on the picture, by fractions of the picture.
        const [phoneBefore, phoneAfter] = [await at('phone', 1), await at('phone', 3)];
        const phonePicture = pictureBox(phoneAfter);
        expect(phonePicture.x1 - phonePicture.x0).toBeLessThan((phonePicture.y1 - phonePicture.y0) / 1.5);
        expect(count(phoneBefore, phonePicture, isAccent)).toBeLessThan(STRAY);
        expectBoxAt(accentBox(phoneAfter, phonePicture), placed(phonePicture, highlight({})), 'phone');

        const parallel = await render(3);
        expect(parallel.bytes.equals(single.bytes)).toBe(true);
      }, 300_000);
    });

    it('renders still frames', async () => {
      const out = await outDir();
      const files = await renderStillFrames(
        minimalPlan(2, 960, 540, 24),
        [1.6],
        out,
        testContext({ config, home: out, runDir: out }).ctx,
      );
      expect(files).toHaveLength(1);
      expect(detectImage(await readFile(files[0]!))).toMatchObject({
        mime: 'image/png',
        width: 960,
        height: 540,
      });
    }, 60_000);

    describe('a log', () => {
      const logLines = [
        'first line of output',
        'second line',
        'third line ok',
        'PASS count is 3',
        'another',
        'last',
      ];
      const logPlan = (): RenderPlan => {
        const base = minimalPlan(10, 1280, 720, 24);
        return {
          ...base,
          scenes: [
            {
              ...base.scenes[0]!,
              durationSec: 9.5,
              beats: [{ index: 0, startSec: 4, durationSec: 3, text: 'The count is three.' }],
              visual: {
                type: 'log',
                caption: null,
                focus: [{ startLine: 4, endLine: 4, note: null, beat: 0 }],
                code: {
                  path: 'run.log',
                  language: 'log',
                  side: 'head',
                  masked: false,
                  truncated: false,
                  lines: logLines.map((t, i) => ({
                    kind: 'ctx' as const,
                    oldNumber: null,
                    newNumber: i + 1,
                    tokens: [{ t, c: null, s: 0 }],
                  })),
                },
              },
              badges: [{ kind: 'actual', text: 'Real output' }],
            },
          ],
        };
      };

      /** Mean grey level of a box of a PNG still. */
      async function meanGrey(
        file: string,
        box: { x: number; y: number; w: number; h: number },
      ): Promise<number> {
        const out = await runCommand(tools!.ffmpeg, [
          ...['-hide_banner', '-loglevel', 'error', '-i', file],
          ...['-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y},format=gray`],
          ...['-f', 'rawvideo', 'pipe:1'],
        ]);
        const bytes = out.stdoutBuffer;
        return bytes.reduce((sum, v) => sum + v, 0) / bytes.length;
      }

      it('dims the other lines and marks the cited line from its beat on', async () => {
        const out = await outDir();
        const [before, after] = await renderStillFrames(
          logPlan(),
          [3, 7],
          out,
          testContext({ config, home: out, runDir: out }).ctx,
        );
        // Lines 1 to 3, and the row of line 4 where the highlight is drawn.
        const others = { x: 405, y: 268, w: 200, h: 76 };
        const edge = { x: 395, y: 351, w: 490, h: 26 };
        expect(await meanGrey(after!, others)).toBeLessThan((await meanGrey(before!, others)) - 3);
        expect(await meanGrey(after!, edge)).toBeGreaterThan((await meanGrey(before!, edge)) + 5);
      }, 90_000);

      it('gives the same video for one browser and for three', async () => {
        const out = await outDir();
        const plan: RenderPlan = { ...logPlan(), width: 640, height: 360, fps: 12 };
        const render = async (workers: number) =>
          readFile(
            (
              await new ChromiumRenderer(config, { workers }).render(
                { plan, audioPath: null, outDir: out, quality: 'draft' },
                testContext({ config, home: out, runDir: out }).ctx,
              )
            ).videoPath,
          );
        const single = await render(1);
        expect((await render(3)).equals(single)).toBe(true);
      }, 120_000);
    });

    it('renders the first two seconds of a plan fixture, if there is one', async () => {
      const fixtures = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'plans');
      const names = (await readdir(fixtures).catch(() => [])).filter((name) => name.endsWith('.json')).sort();
      if (names.length === 0) return;
      const fixture = JSON.parse(await readFile(join(fixtures, names[0]!), 'utf8')) as RenderPlan;
      const plan: RenderPlan = { ...fixture, width: 1280, height: 720, fps: 24, durationSec: 2 };
      const out = await outDir();
      const result = await new ChromiumRenderer(config).render(
        { plan, audioPath: null, outDir: out, quality: 'draft' },
        testContext({ config, home: out, runDir: out }).ctx,
      );
      expect(result.durationSec).toBeCloseTo(2, 1);
      expect((await stat(result.videoPath)).size).toBeGreaterThan(10_000);
    }, 90_000);
  });
});
