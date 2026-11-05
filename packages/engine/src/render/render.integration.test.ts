/**
 * Integration tests: real browser, real FFmpeg. They skip themselves when either is missing.
 *
 * Most tests use a tiny stand-in runtime whose frames are a pure function of the frame number, so
 * they check the renderer (order, timing, colour, segments, audio, clean-up) without depending on
 * the scene templates. One test renders with the real runtime.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import { runCommand } from '../core/process.ts';
import type { RenderPlan } from '../core/render-plan.ts';
import type { ProgressEvent } from '../core/types.ts';
import { testConfig, testContext } from '../testing/context.ts';
import { probeMedia } from '../testing/media.ts';
import { memoryReader, sample, sampleFiles, sampleNarration } from '../testing/sample-change.ts';
import { detectImage } from '../visuals/image.ts';
import { buildRenderPlan, buildTimeline } from '../visuals/index.ts';
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
