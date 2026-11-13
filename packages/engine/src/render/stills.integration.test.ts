/**
 * Golden stills: the dark and light looks, drawn through the theme loader (as midnight and paper) and
 * compared with stills made before themes existed. Real browser and FFmpeg; the test skips itself
 * when either is missing.
 *
 * Only flat areas are compared (backgrounds, cards, glows, the stage gradient): pixels whose whole
 * neighbourhood is even in the golden. Text edges differ between browser builds and systems by up
 * to 80 levels, so they are left out; a colour change in a flat area is what this test catches.
 *
 * After an intended change of the look, write new goldens with MERGESTORY_UPDATE_STILLS=1.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import { runCommand } from '../core/process.ts';
import type { RenderPlan } from '../core/render-plan.ts';
import { loadTheme } from '../core/theme.ts';
import { testConfig, testContext } from '../testing/context.ts';
import { locateBrowser } from './browser.ts';
import { BROWSER_ARGS, renderStillFrames } from './chromium-renderer.ts';
import { fontFacesCss } from './fonts.ts';
import { buildPageHtml, PlanPage } from './page.ts';
import { loadRuntimeBundle } from './runtime-bundle.ts';

const tools = await resolveFfmpeg(testConfig()).catch(() => null);
const browser = await locateBrowser(testConfig()).catch(() => null);
const available = tools !== null && browser !== null;

const PLANS = fileURLToPath(new URL('../../assets/preview/', import.meta.url));
const GOLDENS = fileURLToPath(new URL('../../test/fixtures/stills/', import.meta.url));
const UPDATE = process.env.MERGESTORY_UPDATE_STILLS === '1';

/** Frames that show the glows, the gradients, the cards, the badges and the end card. */
const FRAMES = { core: [4, 25.5, 39.5], templates: [4.5, 27, 41.5] } as const;
/** Stills are drawn at 640x360 and compared at 160x90, where a pixel is the mean of 4x4. */
const DRAWN = { width: 640, height: 360 };
const COMPARED = { width: 160, height: 90 };
/** A pixel is flat when every channel of its 3x3 neighbourhood stays within this range. */
const FLAT_RANGE = 6;

/** A sample plan in a theme. */
async function samplePlan(name: keyof typeof FRAMES, themeName: string): Promise<RenderPlan> {
  const plan = JSON.parse(await readFile(join(PLANS, `${name}-sample.json`), 'utf8')) as RenderPlan;
  const theme = await loadTheme(themeName);
  Object.assign(plan, { theme: theme.base, colors: theme.colors, ...DRAWN });
  // All four badges on the first scene, so their colours are drawn too.
  if (name === 'templates') {
    plan.scenes[0]!.badges = (['simulated', 'actual', 'masked', 'reported'] as const).map((kind) => ({
      kind,
      text: '',
    }));
  }
  return plan;
}

/** RGB bytes of an image, shrunk to the compared size by averaging. */
async function pixels(file: string): Promise<Buffer> {
  const { width, height } = COMPARED;
  const result = await runCommand(tools!.ffmpeg, [
    ...['-hide_banner', '-loglevel', 'error', '-i', file],
    ...['-vf', `scale=${width}:${height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  ]);
  return result.stdoutBuffer;
}

/** Channel differences on the pixels that are flat in the golden and have only flat neighbours. */
function flatDifferences(golden: Buffer, candidate: Buffer): number[] {
  const { width: w, height: h } = COMPARED;
  const flat = new Uint8Array(w * h);
  const at = (x: number, y: number, c: number) => golden[(y * w + x) * 3 + c]!;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let even = true;
      for (let c = 0; c < 3 && even; c++) {
        let lo = 255;
        let hi = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            lo = Math.min(lo, at(x + dx, y + dy, c));
            hi = Math.max(hi, at(x + dx, y + dy, c));
          }
        }
        even = hi - lo <= FLAT_RANGE;
      }
      flat[y * w + x] = even ? 1 : 0;
    }
  }
  const out: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let inside = true;
      for (let dy = -1; dy <= 1 && inside; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (!flat[(y + dy) * w + x + dx]) inside = false;
      }
      if (!inside) continue;
      const i = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) out.push(Math.abs(golden[i + c]! - candidate[i + c]!));
    }
  }
  return out;
}

describe.skipIf(!available)('golden stills', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-stills-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const theme of ['dark', 'light'] as const) {
    it(`draws the ${theme} look as before, through the theme loader`, async () => {
      for (const name of ['core', 'templates'] as const) {
        const times = [...FRAMES[name]];
        const out = join(dir, `${theme}-${name}`);
        const { ctx } = testContext({ home: out, runDir: out });
        const files = await renderStillFrames(await samplePlan(name, theme), times, out, ctx);
        for (const [i, file] of files.entries()) {
          const golden = join(GOLDENS, `${theme}-${name}-${times[i]!.toFixed(1)}.png`);
          if (UPDATE) {
            const { width, height } = COMPARED;
            await runCommand(tools!.ffmpeg, [
              '-loglevel',
              'error',
              '-y',
              '-i',
              file,
              '-vf',
              `scale=${width}:${height}:flags=area`,
              golden,
            ]);
            continue;
          }
          const diffs = flatDifferences(await pixels(golden), await pixels(file));
          const label = `${theme} ${name} at ${times[i]} s`;
          // Enough of the frame is compared, so a broken mask cannot pass by comparing nothing.
          expect(diffs.length / (COMPARED.width * COMPARED.height * 3), label).toBeGreaterThan(0.25);
          expect(Math.max(...diffs), label).toBeLessThanOrEqual(6);
          expect(diffs.filter((d) => d > 2).length / diffs.length, label).toBeLessThan(0.01);
        }
      }
    }, 120_000);
  }

  it('draws a theme without a single request: the page stays offline', async () => {
    const instance = await chromium.launch({
      executablePath: browser!.path,
      headless: true,
      args: BROWSER_ARGS,
    });
    try {
      const html = buildPageHtml({ runtimeJs: await loadRuntimeBundle(), fontsCss: await fontFacesCss() });
      const page = await PlanPage.open(instance, await samplePlan('templates', 'terminal'), html);
      for (const time of FRAMES.templates) await page.seek(time);
      expect(page.blockedRequests).toBe(0);
      expect(page.pageErrors).toEqual([]);
      await page.close();
    } finally {
      await instance.close();
    }
  }, 60_000);
});
