/** A reproduction scene drawn by the real runtime in a real browser. The test skips itself when the browser or FFmpeg is missing. */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import { frameDirForStep, RECORDING_BOX, RECORDING_FPS } from '../core/recording-frames.ts';
import type { MergeStoryRuntimeApi, RenderPlan, ReproResolved } from '../core/render-plan.ts';
import { testConfig, testContext } from '../testing/context.ts';
import { makeClip } from '../testing/media.ts';
import { makePng } from '../testing/png.ts';
import { extractLastFrame } from '../visuals/recording-frames.ts';
import { locateBrowser } from './browser.ts';
import { BROWSER_ARGS, ChromiumRenderer } from './chromium-renderer.ts';
import { fontFacesCss } from './fonts.ts';
import { planWithMedia } from './media.ts';
import { buildPageHtml } from './page.ts';
import { loadRuntimeBundle } from './runtime-bundle.ts';

type Host = { __MERGESTORY__: MergeStoryRuntimeApi };
const tools = await resolveFfmpeg(testConfig()).catch(() => null);
const browser = await locateBrowser(testConfig()).catch(() => null);

/** Runs in the page: what each row of the reproduction looks like now. */
const ROWS_SCRIPT = `Array.from(document.querySelectorAll('.ms-rp__row')).map((row) => {
  const chip = row.querySelector('.ms-rp__chip');
  const thumb = row.querySelector('.ms-rp__thumb');
  const shown = Array.from(row.querySelectorAll('img')).filter((img) => getComputedStyle(img).display !== 'none');
  return {
    opacity: Number(getComputedStyle(row).opacity),
    chip: chip ? chip.textContent : null,
    chipColor: chip ? getComputedStyle(chip).color : null,
    chipIcon: chip ? chip.querySelector('svg') !== null : false,
    thumbWidth: thumb ? thumb.offsetWidth : null,
    pictures: shown.map((img) => img.src.slice(0, 15)),
  };
})`;

describe.skipIf(tools === null || browser === null)('a reproduction scene, drawn by the real runtime', () => {
  let dir: string;
  let plan: RenderPlan;
  const config = testConfig({ quality: 'draft' });
  // The beats of the three narrated steps; the fourth shares the beat of the third.
  const BEATS = [0.8, 3, 5];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-repro-'));
    const clip = join(dir, 'clip.mp4');
    expect(await makeClip(tools!.ffmpeg, clip, { seconds: 2, size: '640x360' })).toBe(true);
    const frameDir = frameDirForStep(1, 3);
    await mkdir(join(dir, frameDir), { recursive: true });
    const made = await extractLastFrame(tools!.ffmpeg, {
      recording: {
        id: 'RC1',
        path: clip,
        caption: '',
        moment: 'other',
        durationSec: 2,
        width: 640,
        height: 360,
        codec: 'h264',
      },
      trim: { start: 1.75, end: 2 },
      zoom: null,
      box: RECORDING_BOX.thumb,
      outDir: join(dir, frameDir),
    });
    const png = makePng(320, 180, [200, 80, 60]);
    const steps: ReproResolved['steps'] = [
      { number: 1, text: 'Open the basket page', result: 'expected', beat: 0, thumb: null },
      {
        number: 2,
        text: 'Type 2 and 3',
        result: 'bug',
        beat: 1,
        thumb: {
          kind: 'screenshot',
          image: { src: `data:image/png;base64,${png.toString('base64')}`, width: 320, height: 180 },
        },
      },
      {
        number: 3,
        text: 'With the fix, the page says 5 items',
        result: 'fixed',
        beat: 2,
        thumb: {
          kind: 'recording',
          frames: { dir: frameDir, ...made, fps: RECORDING_FPS, startSec: 0, speed: 1 },
        },
      },
      { number: 4, text: 'The page says 5 items', result: 'actual', beat: 2, thumb: null },
    ];
    plan = {
      version: 1,
      width: 640,
      height: 360,
      fps: 12,
      durationSec: 10,
      theme: 'dark',
      meta: {
        title: 'A reproduction',
        repoLabel: 'example/shop',
        changeLabel: 'PR #1',
        headShort: '3f9c2ab',
        stats: { files: 1, additions: 1, deletions: 1 },
        engineVersion: '1.0.0',
      },
      captions: { enabled: false, cues: [] },
      chapters: [{ title: 'The bug', startSec: 0 }],
      scenes: [
        {
          id: 's1',
          role: 'reproduction',
          title: 'The bug',
          startSec: 0,
          durationSec: 9.5,
          transitionIn: { type: 'none', durationSec: 0 },
          beats: BEATS.map((startSec, index) => ({ index, startSec, durationSec: 1.5, text: 'A line.' })),
          visual: {
            type: 'repro',
            title: 'The basket total is wrong',
            environment: 'Chrome on a laptop',
            steps,
          },
          refs: [],
          badges: [],
        },
      ],
      outro: { startSec: 9.5, durationSec: 0.5, tagline: 'Every change has a story.', lines: [] },
    };
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The page with the plan loaded: show a time, read what the rows look like. */
  async function withPage<T>(use: (show: (t: number) => Promise<RowState[]>) => Promise<T>) {
    const instance = await chromium.launch({
      executablePath: browser!.path,
      headless: true,
      args: BROWSER_ARGS,
    });
    try {
      const context = await instance.newContext({ viewport: { width: 640, height: 360 }, offline: true });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setContent(
        buildPageHtml({ runtimeJs: await loadRuntimeBundle(), fontsCss: await fontFacesCss() }),
      );
      const paged = await planWithMedia(plan, dir, 0, 10);
      await page.evaluate((p) => (globalThis as unknown as Host).__MERGESTORY__.load(p), paged);
      const result = await use(async (t) => {
        await page.evaluate((time) => (globalThis as unknown as Host).__MERGESTORY__.seek(time), t);
        return (await page.evaluate(ROWS_SCRIPT)) as RowState[];
      });
      expect(errors).toEqual([]);
      return result;
    } finally {
      await instance.close();
    }
  }
  interface RowState {
    opacity: number;
    chip: string | null;
    chipColor: string | null;
    chipIcon: boolean;
    thumbWidth: number | null;
    pictures: string[];
  }

  it('shows a row only from its beat, with its result in words, an icon and a picture', async () => {
    await withPage(async (show) => {
      // Before the first beat (0.8 s, less the lead): no row. Then one row, then every row.
      expect((await show(0.3)).map((r) => r.opacity)).toEqual([0, 0, 0, 0]);
      expect((await show(2)).map((r) => r.opacity)).toEqual([1, 0, 0, 0]);
      expect((await show(4)).map((r) => r.opacity)).toEqual([1, 1, 0, 0]);
      const rows = await show(9);
      expect(rows.map((r) => r.opacity)).toEqual([1, 1, 1, 1]);
      expect(rows.map((r) => r.chip)).toEqual(['Expected', 'Bug', 'Fixed', 'Actual']);
      // The two results that matter have an icon and their fixed colours (the removed and added lines); the others have neither.
      expect(rows.map((r) => r.chipIcon)).toEqual([false, true, true, false]);
      expect(rows[1]!.chipColor).toBe('rgb(255, 107, 129)');
      expect(rows[2]!.chipColor).toBe('rgb(61, 220, 151)');
      // A screenshot and the last picture of a recording; a step without a capture has no frame.
      expect(rows.map((r) => r.pictures)).toEqual([[], ['data:image/png;'], ['data:image/jpeg'], []]);
      // About 150 pixels wide in the 1920 layout, the picture fitted without distortion.
      for (const row of [rows[1]!, rows[2]!]) expect(row.thumbWidth!).toBeGreaterThan(140);
      for (const row of [rows[1]!, rows[2]!]) expect(row.thumbWidth!).toBeLessThanOrEqual(150);
    });
  }, 90_000);

  it('gives the same video for one browser and for three', async () => {
    const render = async (workers: number): Promise<Buffer> => {
      // The frames are read from the output folder, which is where the plan's frame folders are.
      const result = await new ChromiumRenderer(config, { workers }).render(
        { plan, audioPath: null, outDir: dir, quality: 'draft' },
        testContext({ config, home: dir, runDir: dir }).ctx,
      );
      return readFile(result.videoPath);
    };
    const single = await render(1);
    const parallel = await render(3);
    expect(parallel.equals(single)).toBe(true);
  }, 120_000);
});
