// Captures the basket page before and after the fix, the way a person uses it.
// usage: node capture.mjs <output folder>
// Writes before.png, after.png, before.mp4 and after.mp4, a folder screenshots/ with the same two
// pictures and a captions.json (for --screenshots-dir), and count.json: where the text of the item
// count ends up in each picture, as fractions of it. Needs a Chrome or Chromium
// (MERGESTORY_BROWSER_PATH) and FFmpeg (MERGESTORY_FFMPEG_PATH, or ffmpeg on the PATH). Nothing is written inside the repository.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const out = process.argv[2];
if (!out) {
  console.error('usage: node capture.mjs <output folder>');
  process.exit(1);
}
const browserPath = process.env.MERGESTORY_BROWSER_PATH;
if (!browserPath) {
  console.error('Set MERGESTORY_BROWSER_PATH to a Chrome or Chromium executable, then run this again.');
  process.exit(1);
}
const ffmpeg = process.env.MERGESTORY_FFMPEG_PATH || 'ffmpeg';
const here = fileURLToPath(new URL('.', import.meta.url));
const outDir = resolve(out);
mkdirSync(outDir, { recursive: true });
const shots = join(outDir, 'screenshots');
mkdirSync(shots, { recursive: true });

const VIEWPORT = { width: 960, height: 540 };
// Where the text of the item count is at the end, as fractions of the picture: a font that is wider or
// taller than the one of the machine that made the storyboard shows in this file.
const counts = {};

const browser = await chromium.launch({ executablePath: browserPath, headless: true });
// A small window, so the text stays large when the video shows it in a frame.
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

for (const side of ['before', 'after']) {
  await page.goto(pathToFileURL(join(here, side === 'before' ? 'base' : 'feature', 'index.html')).href);
  const work = mkdtempSync(join(tmpdir(), 'bugfix-frames-'));
  let n = 0;
  // A recording is a screenshot after each step, repeated for as long as the step should last (10 frames a second).
  const hold = async (frames) => {
    const png = await page.screenshot();
    for (let i = 0; i < frames; i++) writeFileSync(join(work, `f-${String(n++).padStart(4, '0')}.png`), png);
  };
  const type = async (selector, value) => {
    await page.locator(selector).click();
    await hold(8);
    await page.locator(selector).fill('');
    await hold(6);
    await page.locator(selector).pressSequentially(value);
    await hold(28);
  };
  await hold(18);
  await type('#qty-mix', '2');
  await type('#qty-bar', '3');
  await hold(14);
  await page.screenshot({ path: join(outDir, `${side}.png`) });
  // The box of the text itself: the element is as wide as the whole page.
  const text = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('count'));
    const { x, y, width, height } = range.getBoundingClientRect();
    return { x, y, width, height };
  });
  counts[side] = {
    x: text.x / VIEWPORT.width,
    y: text.y / VIEWPORT.height,
    w: text.width / VIEWPORT.width,
    h: text.height / VIEWPORT.height,
  };
  copyFileSync(join(outDir, `${side}.png`), join(shots, `${side === 'before' ? 1 : 2}-${side}.png`));
  try {
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-loglevel',
        'error',
        '-framerate',
        '10',
        '-i',
        join(work, 'f-%04d.png'),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        join(outDir, `${side}.mp4`),
      ],
      { stdio: 'inherit' },
    );
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.error(
      `FFmpeg could not be started (${ffmpeg}). Set MERGESTORY_FFMPEG_PATH to an ffmpeg executable.`,
    );
    process.exit(1);
  }
  rmSync(work, { recursive: true, force: true });
}
await browser.close();
writeFileSync(join(outDir, 'count.json'), `${JSON.stringify(counts, null, 2)}\n`);
writeFileSync(
  join(shots, 'captions.json'),
  JSON.stringify({
    '1-before.png': { caption: 'The basket before the fix', side: 'before' },
    '2-after.png': { caption: 'The basket after the fix', side: 'after' },
  }),
);
console.log(`Captures written to ${outDir}`);
