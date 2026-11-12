/**
 * ChromiumRenderer: RenderPlan -> MP4.
 *
 * The runtime in a headless browser draws any time of the plan on request. The frames are cut into
 * fixed-length segments; several browsers capture segments in parallel, each segment streams its
 * JPEG frames into its own FFmpeg process, and the segments are joined without re-encoding while the
 * narration is added. Frames that did not change are not captured again.
 *
 * Output depends only on the plan: segment boundaries do not move with the number of workers, and
 * every segment is drawn in ascending order by a page that has not drawn anything before. Chromium
 * can draw a frame slightly differently depending on the frames drawn before it (layer raster
 * scale), so reusing a page across segments would make the bytes depend on which worker got which
 * segment. Partial raster is off for the same reason.
 */
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { resolveFfmpeg } from '../core/binaries.ts';
import { type Config, QUALITY_PRESETS } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { abortedError, assertNotAborted, MergeStoryError } from '../core/errors.ts';
import { randomToken } from '../core/ids.ts';
import type { Logger } from '../core/logger.ts';
import type { Renderer, RenderInput, RenderOutput } from '../core/providers.ts';
import type { RenderPlan } from '../core/render-plan.ts';
import { RUN_FILE } from '../core/run-folder.ts';
import { detectImage } from '../visuals/image.ts';
import { locateBrowser, SHORT_FRAME_HINT } from './browser.ts';
import { concatAndMux, concatListText, probeDuration, SegmentEncoder, segmentEncodeArgs } from './ffmpeg.ts';
import { fontFacesCss } from './fonts.ts';
import { buildPageHtml, type CaptureFormat, fitWindow, PlanPage } from './page.ts';
import { loadPlaywright } from './playwright.ts';
import { loadRuntimeBundle } from './runtime-bundle.ts';

/**
 * Browser flags. Partial raster is off so pixels no longer depend on the order of seeks; text hinting
 * and subpixel text are off so glyphs look the same on every platform; name lookups are refused so
 * a browser that is not a headless shell cannot reach out in the background.
 */
export const BROWSER_ARGS = [
  '--disable-partial-raster',
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--disable-breakpad',
  '--host-resolver-rules=MAP * ~NOTFOUND',
];

/** Fixed encoder thread count, so the same plan always encodes to the same bytes. */
const ENCODER_THREADS = 2;
/** Most browsers started automatically; more did not help in measurements. */
const MAX_AUTO_WORKERS = 6;
/** Rough memory one worker needs (browser plus encoder). */
const BYTES_PER_WORKER = 1.5 * 1024 ** 3;
const SEGMENT_ATTEMPTS = 2;
const POSTER_OFFSET_SEC = 1.5;
const POSTER_QUALITY = 92;
const PROGRESS_STEP = 0.02;

export interface Segment {
  index: number;
  /** First frame (inclusive) and end frame (exclusive). */
  start: number;
  end: number;
}

/** Number of frames for a plan: its duration at the frame rate, at least one. */
export function frameCountFor(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(durationSec * fps));
}

/** Fixed segments of four seconds (two keyframe intervals), whatever the machine. */
export function planSegments(frames: number, fps: number): Segment[] {
  const length = fps * 4;
  const segments: Segment[] = [];
  for (let start = 0, index = 0; start < frames; start += length, index++) {
    segments.push({ index, start, end: Math.min(frames, start + length) });
  }
  return segments;
}

/** Parallel browsers: the configured number, else half the CPUs, limited by memory and by 6. */
export function chooseWorkers(
  configured: number | null | undefined,
  segmentCount: number,
  cpuCount: number = cpus().length,
  memoryBytes: number = totalmem(),
): number {
  const byCpu = Math.max(1, Math.floor(cpuCount / 2));
  const byMemory = Math.max(1, Math.floor(memoryBytes / BYTES_PER_WORKER));
  const automatic = Math.min(MAX_AUTO_WORKERS, byCpu, byMemory);
  return Math.max(1, Math.min(Math.max(1, segmentCount), configured ?? automatic));
}

/** When the poster is taken: shortly after the title scene's heading appears. */
export function posterTimeFor(plan: RenderPlan, frames: number): number {
  const scene = plan.scenes.find((s) => s.visual.type === 'title') ?? plan.scenes[0];
  const last = (frames - 1) / plan.fps;
  if (!scene) return Math.min(POSTER_OFFSET_SEC, last);
  const latest = scene.startSec + Math.max(0, scene.durationSec - 0.2);
  return Math.max(0, Math.min(scene.startSec + POSTER_OFFSET_SEC, latest, last));
}

function assertPlan(plan: RenderPlan): void {
  const even = (n: number): boolean => Number.isInteger(n) && n > 0 && n % 2 === 0;
  if (!even(plan.width) || !even(plan.height)) {
    throw new MergeStoryError(
      'RENDER_FAILED',
      `The video size ${plan.width}x${plan.height} must be even numbers.`,
      {
        hint: 'H.264 with 4:2:0 colour needs an even width and height.',
      },
    );
  }
  if (!Number.isInteger(plan.fps) || plan.fps < 1 || plan.fps > 120) {
    throw new MergeStoryError('RENDER_FAILED', `The frame rate ${plan.fps} is not supported (1 to 120).`);
  }
  if (!Number.isFinite(plan.durationSec) || plan.durationSec <= 0) {
    throw new MergeStoryError('RENDER_FAILED', 'The render plan has no duration.');
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof MergeStoryError && err.code === 'ABORTED';
}

interface RunSetup {
  plan: RenderPlan;
  ffmpeg: string;
  executablePath: string;
  html: string;
  segments: Segment[];
  segmentPath: (segment: Segment) => string;
  workers: number;
  crf: number;
  x264Preset: string;
  jpeg: CaptureFormat;
  reuseStaticFrames: boolean;
  launch: BrowserLauncher;
  ctx: RunContext;
}

/** One render: workers capture segments from a shared queue. */
class RenderRun {
  frames: number;
  reusedFrames = 0;
  posterJpeg: Buffer | null = null;
  private readonly setup: RunSetup;
  private nextSegment = 0;
  private done = 0;
  private reported = 0;
  private failure: Error | null = null;
  private posterClaimed = false;
  private readonly encoders = new Set<SegmentEncoder>();
  private readonly browsers = new Set<Browser>();

  constructor(setup: RunSetup, frames: number) {
    this.setup = setup;
    this.frames = frames;
  }

  async execute(): Promise<void> {
    const { ctx, workers } = this.setup;
    const onAbort = (): void => this.fail(abortedError());
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    try {
      await Promise.all(
        Array.from({ length: workers }, (_, id) =>
          this.worker(id).catch((err: unknown) =>
            this.fail(err instanceof Error ? err : new Error(String(err))),
          ),
        ),
      );
      if (this.failure) throw this.failure;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      for (const encoder of this.encoders) encoder.kill();
      await Promise.allSettled([...this.browsers].map((browser) => browser.close()));
    }
  }

  /** Record the first failure and stop everything else. */
  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    for (const encoder of this.encoders) encoder.kill();
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  private advance(frames: number): void {
    this.done += frames;
    const progress = Math.min(1, this.done / this.frames);
    if (progress - this.reported >= PROGRESS_STEP || (progress >= 1 && this.reported < 1)) {
      this.reported = progress;
      this.setup.ctx.progress({
        stage: 'render',
        status: 'progress',
        progress,
        message: `Rendering frames (${Math.min(this.done, this.frames)} of ${this.frames})`,
      });
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const { executablePath, launch } = this.setup;
    let browser: Browser;
    try {
      browser = await launch(executablePath, this.setup.ctx.logger);
    } catch (err) {
      throw browserStartError(err);
    }
    this.browsers.add(browser);
    return browser;
  }

  private async closeBrowser(browser: Browser | null): Promise<void> {
    if (!browser) return;
    this.browsers.delete(browser);
    await browser.close().catch(() => undefined);
  }

  /** A new page in a new browser context, so no earlier frame can influence what it draws. */
  private async openPage(browser: Browser, workerId: number): Promise<PlanPage> {
    const { plan, html, ctx } = this.setup;
    return PlanPage.open(browser, plan, html, ctx.logger.child({ worker: workerId }));
  }

  private async closePage(page: PlanPage): Promise<void> {
    const logger = this.setup.ctx.logger;
    if (page.pageErrors.length > 0) {
      logger.warn('The render page reported errors.', {
        count: page.pageErrors.length,
        first: page.pageErrors[0]?.slice(0, 200),
      });
    }
    if (page.blockedRequests > 0) {
      logger.warn('The render page tried to make network requests; all were blocked.', {
        count: page.blockedRequests,
      });
    }
    await page.close();
  }

  private takeSegment(): Segment | null {
    return this.setup.segments[this.nextSegment++] ?? null;
  }

  private async worker(id: number): Promise<void> {
    let browser: Browser | null = null;
    const finishing: Promise<void>[] = [];
    try {
      for (;;) {
        this.throwIfFailed();
        const segment = this.takeSegment();
        if (!segment) break;
        for (let attempt = 1; ; attempt++) {
          try {
            browser ??= await this.launchBrowser();
            const page = await this.openPage(browser, id);
            try {
              finishing.push((await this.captureSegment(page, segment)).finished);
            } finally {
              await this.closePage(page);
            }
            break;
          } catch (err) {
            if (this.failure || isAbort(err) || attempt >= SEGMENT_ATTEMPTS) throw err;
            this.setup.ctx.logger.warn(
              'A render worker failed; restarting its browser and retrying the segment.',
              {
                worker: id,
                segment: segment.index,
                error: err instanceof Error ? err.message : String(err),
              },
            );
            await this.closeBrowser(browser);
            browser = null;
          }
        }
      }
      // The poster comes from the first worker that has a browser and nothing left to do.
      if (browser && !this.posterClaimed) {
        this.posterClaimed = true;
        try {
          const page = await this.openPage(browser, id);
          try {
            await page.seek(posterTimeFor(this.setup.plan, this.frames));
            this.posterJpeg = await page.capture({
              format: 'jpeg',
              quality: POSTER_QUALITY,
              optimizeForSpeed: false,
            });
          } finally {
            await this.closePage(page);
          }
        } catch (err) {
          // The poster is optional: a failure here must not cost the finished segments.
          if (this.failure || isAbort(err)) throw err;
          this.setup.ctx.logger.warn('The poster could not be captured; the video has no poster.', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await Promise.all(finishing);
    } finally {
      await this.closeBrowser(browser);
    }
  }

  /**
   * Capture one segment into a new encoder. Resolves when all frames are written; `finished`
   * settles when the encoder is done, so the next segment can start meanwhile.
   */
  private async captureSegment(page: PlanPage, segment: Segment): Promise<{ finished: Promise<void> }> {
    const { plan, ffmpeg, segmentPath, crf, x264Preset, jpeg, reuseStaticFrames } = this.setup;
    const encoder = SegmentEncoder.start(
      ffmpeg,
      segmentEncodeArgs({
        fps: plan.fps,
        crf,
        x264Preset,
        gop: plan.fps * 2,
        threads: ENCODER_THREADS,
        outPath: segmentPath(segment),
      }),
    );
    this.encoders.add(encoder);
    let counted = 0;
    let reused = 0;
    try {
      let previous: Buffer | null = null;
      for (let frame = segment.start; frame < segment.end; frame++) {
        this.throwIfFailed();
        const dirty = await page.seek(frame / plan.fps);
        let bytes: Buffer;
        if (!dirty && previous && reuseStaticFrames) {
          bytes = previous;
          reused++;
        } else {
          bytes = await page.capture(jpeg);
          if (previous === null && segment.index === 0) this.checkFrameSize(bytes);
          previous = bytes;
        }
        await encoder.write(bytes);
        counted++;
        this.advance(1);
      }
    } catch (err) {
      encoder.kill();
      this.encoders.delete(encoder);
      this.done -= counted; // a retry counts these frames again
      throw err;
    }
    this.reusedFrames += reused;
    const finished = encoder.finish().then(
      () => {
        this.encoders.delete(encoder);
      },
      (err: unknown) => {
        this.encoders.delete(encoder);
        const error = err instanceof Error ? err : new Error(String(err));
        this.fail(error);
        throw error;
      },
    );
    // The worker awaits `finished` later; this keeps an early failure from being reported as unhandled.
    finished.catch(() => undefined);
    return { finished };
  }

  private checkFrameSize(jpegBytes: Buffer): void {
    const { plan } = this.setup;
    const info = detectImage(jpegBytes);
    if (!info || info.width !== plan.width || info.height !== plan.height) {
      throw new MergeStoryError(
        'RENDER_FAILED',
        `The browser captured a ${info ? `${info.width}x${info.height}` : 'unreadable'} frame instead of ${plan.width}x${plan.height}.`,
        { hint: SHORT_FRAME_HINT },
      );
    }
  }
}

/**
 * Start the browser, draw one blank frame and return its size. "mergestory doctor" uses it to find a
 * browser that draws short frames before a render does.
 */
export async function captureTestFrame(
  executablePath: string,
  logger: Logger,
  width = 1280,
  height = 720,
): Promise<{ width: number; height: number } | null> {
  let browser: Browser;
  try {
    browser = await launchChromium(executablePath, logger);
  } catch (err) {
    throw browserStartError(err);
  }
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      offline: true,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.setContent('<!doctype html><body style="margin:0;background:#fff"></body>');
    await fitWindow(cdp, width, height);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    return detectImage(Buffer.from(data, 'base64'));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export interface ChromiumRendererOptions {
  /** Replaces the bundled runtime script. Used by tests. */
  runtimeJs?: string;
  /** Replaces the worker count. */
  workers?: number;
  /** Replaces the browser launcher. Used by tests. */
  launch?: BrowserLauncher;
}

/** Starts a browser. The logger is for notes about how it was started. */
export type BrowserLauncher = (executablePath: string, logger: Logger) => Promise<Browser>;

/**
 * The browser keeps its sandbox on, because it draws images from the change. It cannot start with the
 * sandbox as root (as in many containers), so it is turned off there.
 */
export function browserSandbox(uid: number | undefined = process.getuid?.()): boolean {
  return uid !== 0;
}

/** What Chromium prints when the machine refuses it a sandbox. */
const NO_SANDBOX = /no usable sandbox|sandbox helper/i;

/**
 * Starts the browser with its sandbox where the machine allows one. Some do not allow it for a normal
 * user either: Ubuntu 23.10 and later block the user namespaces that a downloaded Chromium needs. There
 * the browser starts without the sandbox, as it does for root, and the user gets a warning.
 */
export async function launchWithSandbox(
  launch: (sandbox: boolean) => Promise<Browser>,
  logger: Logger,
  uid: number | undefined = process.getuid?.(),
): Promise<Browser> {
  if (!browserSandbox(uid)) {
    logger.debug('Running as root, so the browser starts without its sandbox.');
    return launch(false);
  }
  try {
    return await launch(true);
  } catch (err) {
    if (!(err instanceof Error && NO_SANDBOX.test(err.message))) throw err;
    logger.warn(
      'This machine does not allow the browser sandbox, so the browser runs without it. ' +
        'Google Chrome installed from its package can usually use the sandbox: set MERGESTORY_BROWSER_PATH to it.',
    );
    return launch(false);
  }
}

const launchChromium: BrowserLauncher = async (executablePath, logger) => {
  const { chromium } = await loadPlaywright();
  return launchWithSandbox(
    (chromiumSandbox) =>
      chromium.launch({
        executablePath,
        headless: true,
        chromiumSandbox,
        args: BROWSER_ARGS,
        timeout: 90_000,
        // The CLI handles Ctrl-C itself and cancels the run through its abort signal.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      }),
    logger,
  );
};

/** The error for a browser that did not start. A launcher passed in by a caller has no sandbox fallback. */
function browserStartError(err: unknown): MergeStoryError {
  const sandbox = err instanceof Error && NO_SANDBOX.test(err.message);
  return new MergeStoryError('RENDER_FAILED', 'The browser could not be started.', {
    hint: `${sandbox ? 'This machine does not allow the browser sandbox. Google Chrome installed from its package can usually use it. ' : ''}Set MERGESTORY_BROWSER_PATH to a working Chrome or Chromium, or run "mergestory doctor".`,
    cause: err,
  });
}

export class ChromiumRenderer implements Renderer {
  readonly id = 'chromium';
  private readonly config: Config;
  private readonly options: ChromiumRendererOptions;

  constructor(config: Config, options: ChromiumRendererOptions = {}) {
    this.config = config;
    this.options = options;
  }

  async render(input: RenderInput, ctx: RunContext): Promise<RenderOutput> {
    const { plan } = input;
    assertNotAborted(ctx.signal);
    assertPlan(plan);
    const preset = QUALITY_PRESETS[input.quality] ?? QUALITY_PRESETS.standard;
    const { ffmpeg, ffprobe } = await resolveFfmpeg(this.config);
    const browser = await locateBrowser(this.config);
    const [runtimeJs, fontsCss] = await Promise.all([
      this.options.runtimeJs ?? loadRuntimeBundle(),
      fontFacesCss(),
    ]);
    const html = buildPageHtml({ runtimeJs, fontsCss });

    const outDir = resolve(input.outDir);
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const audioPath = input.audioPath ? resolve(input.audioPath) : null;
    if (audioPath) {
      const found = await stat(audioPath).then(
        (s) => s.isFile(),
        () => false,
      );
      if (!found)
        throw new MergeStoryError('RENDER_FAILED', 'The audio track was not found.', {
          hint: 'Re-run the narration step.',
        });
    }

    const frames = frameCountFor(plan.durationSec, plan.fps);
    const segments = planSegments(frames, plan.fps);
    const workers = this.options.workers ?? chooseWorkers(this.config.render.concurrency, segments.length);
    const tmpDir = join(outDir, `.render-${randomToken(4)}`);
    await mkdir(tmpDir, { mode: 0o700 });
    const segmentFile = (segment: Segment): string =>
      join(tmpDir, `segment-${String(segment.index).padStart(4, '0')}.mp4`);
    const started = performance.now();
    const videoPath = join(outDir, RUN_FILE.video);
    const posterFile = join(outDir, RUN_FILE.poster);
    try {
      const run = new RenderRun(
        {
          plan,
          ffmpeg,
          executablePath: browser.path,
          html,
          segments,
          segmentPath: segmentFile,
          workers,
          crf: preset.crf,
          x264Preset: preset.x264Preset,
          jpeg: { format: 'jpeg', quality: preset.jpegQuality, optimizeForSpeed: true },
          reuseStaticFrames: this.config.render.reuseStaticFrames,
          launch: this.options.launch ?? launchChromium,
          ctx,
        },
        frames,
      );
      await run.execute();
      assertNotAborted(ctx.signal);

      const listPath = join(tmpDir, 'segments.txt');
      await writeFile(listPath, concatListText(segments.map(segmentFile)), { mode: 0o600 });
      const assembled = join(tmpDir, RUN_FILE.video);
      await concatAndMux(
        ffmpeg,
        { listPath, audioPath, outPath: assembled, durationSec: frames / plan.fps },
        ctx.signal,
      );
      await rename(assembled, videoPath);
      if (run.posterJpeg) await writeFile(posterFile, run.posterJpeg, { mode: 0o600 });

      const [durationSec, size] = await Promise.all([
        probeDuration(ffprobe, videoPath, ctx.signal),
        stat(videoPath),
      ]);
      const seconds = (performance.now() - started) / 1000;
      ctx.logger.debug('Render finished', {
        frames,
        reusedFrames: run.reusedFrames,
        workers,
        segments: segments.length,
        seconds: Number(seconds.toFixed(1)),
        fps: Number((frames / seconds).toFixed(1)),
      });
      return {
        videoPath,
        posterPath: run.posterJpeg ? posterFile : null,
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        durationSec,
        frames,
        reusedFrames: run.reusedFrames,
        sizeBytes: size.size,
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}

function stillName(timeSec: number): string {
  return `frame-${timeSec.toFixed(2).padStart(7, '0')}.png`;
}

/** Render single frames to PNG files. Returns the written paths in the order of `timesSec`. */
export async function renderStillFrames(
  plan: RenderPlan,
  timesSec: number[],
  outDir: string,
  ctx: RunContext,
  options: ChromiumRendererOptions = {},
): Promise<string[]> {
  assertPlan(plan);
  for (const time of timesSec) {
    if (!Number.isFinite(time) || time < 0) {
      throw new MergeStoryError('USAGE', `A preview time is not valid: ${time}`, {
        hint: 'Times are seconds from the start.',
      });
    }
  }
  const executable = await locateBrowser(ctx.config);
  const [runtimeJs, fontsCss] = await Promise.all([options.runtimeJs ?? loadRuntimeBundle(), fontFacesCss()]);
  const html = buildPageHtml({ runtimeJs, fontsCss });
  const target = resolve(outDir);
  await mkdir(target, { recursive: true, mode: 0o700 });

  let browser: Browser;
  try {
    browser = await (options.launch ?? launchChromium)(executable.path, ctx.logger);
  } catch (err) {
    throw browserStartError(err);
  }
  try {
    const page = await PlanPage.open(browser, plan, html, ctx.logger);
    const written: string[] = [];
    for (const time of timesSec) {
      assertNotAborted(ctx.signal);
      const clamped = Math.min(time, plan.durationSec);
      await page.seek(clamped);
      const png = await page.capture({ format: 'png', optimizeForSpeed: false });
      const file = join(target, stillName(clamped));
      await writeFile(file, png, { mode: 0o600 });
      written.push(file);
    }
    return written;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
