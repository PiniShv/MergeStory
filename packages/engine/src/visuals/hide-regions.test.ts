import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import { detectImage } from '../core/image.ts';
import { runCommand } from '../core/process.ts';
import type { HiddenRegion } from '../core/types.ts';
import { testConfig } from '../testing/context.ts';
import {
  COVER_EDGE,
  COVER_FILL,
  coverEdge,
  coveredFrames,
  coverFilter,
  hideFilter,
  hideInScreenshot,
  regionRect,
} from './hide-regions.ts';
import { loadScreenshot } from './image.ts';

const region = (x: number, y: number, w: number, h: number): HiddenRegion => ({ x, y, w, h });

describe('regionRect', () => {
  it('rounds outwards to even sides and stays inside the picture', () => {
    expect(regionRect(region(0.101, 0.25, 0.3, 0.1), 100, 100)).toEqual({ x: 10, y: 24, w: 32, h: 12 });
    expect(regionRect(region(0.9, 0.9, 0.1, 0.1), 101, 101)).toEqual({ x: 90, y: 90, w: 11, h: 11 });
  });

  it('never gives a side under 2 pixels, and moves inwards at the far edge of the picture', () => {
    expect(regionRect(region(0.5, 0.5, 1e-30, 0.1), 100, 100)).toEqual({ x: 50, y: 50, w: 2, h: 10 });
    expect(regionRect(region(0.995, 0, 1e-30, 1e-30), 101, 101)).toEqual({ x: 99, y: 0, w: 2, h: 2 });
  });
});

describe('coverFilter', () => {
  it('sets every pixel to a constant and drops the alpha: a grey fill inside a light edge', () => {
    expect(coverEdge(960)).toBe(2);
    expect(coverEdge(3840)).toBe(6);
    expect(coverFilter({ x: 10, y: 20, w: 100, h: 40 }, 2)).toBe(
      'crop=96:36:12:22,format=rgb24,lutrgb=r=38:g=38:b=38,pad=100:40:2:2:color=0xb0b0b0',
    );
    // Not wider and higher than two edges: the fill only.
    expect(coverFilter({ x: 10, y: 20, w: 100, h: 4 }, 2)).toBe(
      'crop=100:4:10:20,format=rgb24,lutrgb=r=38:g=38:b=38',
    );
  });
});

describe('hideFilter', () => {
  it('splits once for any number of regions, so the time grows in a straight line', () => {
    const regions = Array.from({ length: 20 }, (_, i) =>
      region((i % 5) / 5, Math.floor(i / 5) / 4, 0.1, 0.1),
    );
    const filter = hideFilter(regions, 960, 540);
    expect(filter.match(/split/g)).toHaveLength(1);
    expect(filter.startsWith('split=21[o][c0]')).toBe(true);
    expect(filter.match(/overlay=/g)).toHaveLength(20);
  });

  it('covers a region without a time in every frame: its overlay has no time limit', () => {
    const filter = hideFilter([region(0, 0, 0.5, 0.5), region(0.5, 0.5, 0.5, 0.5)], 100, 100);
    expect(filter).not.toContain('enable');
    expect(filter).toContain('[o][m0]overlay=0:0:format=auto[v0]');
    expect(filter.endsWith('[v0][m1]overlay=50:50:format=auto')).toBe(true);
  });

  it('covers a region with a time only in its frames, by frame number', () => {
    const filter = hideFilter(
      [{ ...region(0, 0, 0.5, 0.5), from: 1, to: 2 }, region(0.5, 0.5, 0.5, 0.5)],
      100,
      100,
    );
    expect(filter).toContain("[o][m0]overlay=0:0:format=auto:enable='between(n,11,24)'[v0]");
    expect(filter.endsWith('[v0][m1]overlay=50:50:format=auto')).toBe(true);
  });
});

describe('coveredFrames', () => {
  it('covers every frame of 12 a second whose picture a player shows from one frame before to one frame after', () => {
    // Frame k shows the picture of the moment just before (k + 0.5) / 12 s.
    expect(coveredFrames({ ...region(0, 0, 1, 1), from: 1, to: 2 })).toEqual({ first: 11, last: 24 });
    expect(coveredFrames({ ...region(0, 0, 1, 1), from: 0, to: 0.01 })).toEqual({ first: 0, last: 0 });
    // A time exactly on the margin stays inside it.
    expect(coveredFrames({ ...region(0, 0, 1, 1), from: 0.125, to: 1.375 })).toEqual({ first: 0, last: 17 });
    expect(coveredFrames(region(0, 0, 1, 1))).toBeNull();
  });
});

const tools = await resolveFfmpeg(testConfig()).catch(() => null);

describe.skipIf(tools === null)('hiding in a screenshot', () => {
  const W = 300;
  const H = 180;
  // The word: stripes of black and white, 2 pixels wide, in this box. Elsewhere a gradient.
  const WORD = { x: 60, y: 80, w: 64, h: 16 };
  let dir: string;
  let png: string;
  let jpg: string;
  let original: Buffer;
  let ffmpeg: string;

  const raw = async (bytes: Buffer): Promise<Buffer> =>
    (
      await runCommand(
        ffmpeg,
        ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        { input: bytes, timeoutMs: 60_000 },
      )
    ).stdoutBuffer;
  const inside = (x: number, y: number, box: { x: number; y: number; w: number; h: number }) =>
    x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;

  beforeAll(async () => {
    ffmpeg = tools!.ffmpeg;
    dir = await mkdtemp(join(tmpdir(), 'mergestory-hide-'));
    const pixels = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = (y * W + x) * 3;
        const dark = inside(x, y, WORD) && (x >> 1) % 2 === 0;
        const value = inside(x, y, WORD) ? (dark ? 0 : 255) : -1;
        pixels[at] = value >= 0 ? value : (x * 7 + y) % 256;
        pixels[at + 1] = value >= 0 ? value : (y * 5) % 256;
        pixels[at + 2] = value >= 0 ? value : (x + y * 3) % 256;
      }
    }
    png = join(dir, 'shot.png');
    jpg = join(dir, 'shot.jpg');
    const make = (out: string, extra: string[]) =>
      runCommand(
        ffmpeg,
        [
          '-v',
          'error',
          '-y',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-s',
          `${W}x${H}`,
          '-i',
          'pipe:0',
          ...extra,
          out,
        ],
        { input: pixels, timeoutMs: 60_000 },
      );
    await make(png, ['-frames:v', '1']);
    await make(jpg, ['-frames:v', '1', '-q:v', '2']);
    original = await readFile(png);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const hide = (path: string, regions: HiddenRegion[]) =>
    hideInScreenshot(ffmpeg, path, detectImage(readFileSync(path))!, regions, 'SS1');

  it('changes no pixel outside the region of a PNG, and keeps the type and the size', async () => {
    const hidden = await hide(png, [region(WORD.x / W - 0.02, WORD.y / H - 0.05, 0.3, 0.2)]);
    expect(detectImage(hidden)).toMatchObject({ mime: 'image/png', width: W, height: H });
    const before = await raw(original);
    const after = await raw(hidden);
    const box = regionRect(region(WORD.x / W - 0.02, WORD.y / H - 0.05, 0.3, 0.2), W, H);
    let changedInside = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = (y * W + x) * 3;
        const same = before.subarray(at, at + 3).equals(after.subarray(at, at + 3));
        if (inside(x, y, box)) changedInside += same ? 0 : 1;
        else expect(same, `pixel ${x},${y}`).toBe(true);
      }
    }
    expect(changedInside).toBeGreaterThan(100);
  });

  it('puts only the hidden picture out: the bytes of the file are not in the result', async () => {
    const hidden = await hide(png, [region(0.1, 0.1, 0.5, 0.5)]);
    expect(hidden.equals(original)).toBe(false);
    expect(hidden.includes(original.subarray(60, 200))).toBe(false);
  });

  it('keeps a JPEG a JPEG of the same size', async () => {
    const hidden = await hide(jpg, [region(0.1, 0.1, 0.5, 0.5)]);
    expect(detectImage(hidden)).toMatchObject({ mime: 'image/jpeg', width: W, height: H });
    expect(hidden.equals(await readFile(jpg))).toBe(false);
  });

  it('hides every region of a list', async () => {
    const hidden = await hide(png, [region(0, 0, 0.2, 0.2), region(0.7, 0.7, 0.3, 0.3)]);
    const before = await raw(original);
    const after = await raw(hidden);
    const differs = (x: number, y: number) =>
      !before
        .subarray((y * W + x) * 3, (y * W + x) * 3 + 3)
        .equals(after.subarray((y * W + x) * 3, (y * W + x) * 3 + 3));
    expect(differs(10, 10)).toBe(true);
    expect(differs(W - 10, H - 10)).toBe(true);
    expect(differs(W / 2, H / 2)).toBe(false);
  });

  /** A program that stands in for FFmpeg. */
  async function fake(body: string): Promise<string> {
    const path = join(dir, `fake-${Math.random().toString(36).slice(2)}.sh`);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o700);
    return path;
  }

  it('stops with an error that names the screenshot when FFmpeg fails, and never returns the picture as it was', async () => {
    const failing = await fake('exit 1');
    const outcome = await loadScreenshot(
      png,
      testConfig({ render: { ffmpegPath: failing, ffprobePath: failing } }),
      'Screenshot SS2 (shot.png)',
      { id: 'SS2', regions: [region(0, 0, 1, 1)] },
    ).catch((err: unknown) => err);
    expect(outcome).toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('Screenshot SS2 (shot.png) cannot be shown with its hidden regions'),
    });
    // No FFmpeg at all is an error too, never the picture as it was.
    const missing = join(dir, 'missing-ffmpeg');
    await expect(
      loadScreenshot(png, testConfig({ render: { ffmpegPath: missing, ffprobePath: missing } }), 'x', {
        id: 'SS2',
        regions: [region(0, 0, 1, 1)],
      }),
    ).rejects.toMatchObject({ code: 'FFMPEG_NOT_FOUND' });
  });

  it('refuses an answer that is not a picture of the same size', async () => {
    const other = join(dir, 'other.png');
    await runCommand(
      ffmpeg,
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=64x64', '-frames:v', '1', other],
      {
        timeoutMs: 60_000,
      },
    );
    const program = await fake(`cat '${other}'`);
    await expect(
      hideInScreenshot(program, png, detectImage(original)!, [region(0, 0, 1, 1)], 'SS1'),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not a picture of the same type and size'),
    });
    const garbage = await fake('echo not a picture');
    await expect(
      hideInScreenshot(garbage, png, detectImage(original)!, [region(0, 0, 1, 1)], 'SS1'),
    ).rejects.toMatchObject({
      code: 'USAGE',
    });
  });

  it('loads a screenshot as it is when no region is given', async () => {
    const plain = await loadScreenshot(png, testConfig());
    expect(plain.src).toBe(`data:image/png;base64,${original.toString('base64')}`);
  });

  it('reads only one picture of a known format: a list that names a picture next to it is not followed', async () => {
    // Without the input limits FFmpeg would read this text as a list, open shot.png and answer with a picture of the right size.
    for (const [name, target, mime] of [
      ['list.png', 'shot.png', 'image/png'],
      ['list.jpg', 'shot.jpg', 'image/jpeg'],
    ] as const) {
      const list = join(dir, name);
      await writeFile(list, `ffconcat version 1.0\nfile '${target}'\n`);
      await expect(
        hideInScreenshot(ffmpeg, list, { mime, width: W, height: H }, [region(0, 0, 1, 1)], 'SS1'),
        name,
      ).rejects.toMatchObject({ code: 'USAGE' });
    }
  });
});

describe.skipIf(tools === null)('the cover keeps nothing of the picture under it', () => {
  const W = 160;
  const H = 96;
  // The region, and the "text" inside it: two patterns of stripes that differ everywhere they are drawn.
  const REGION = region(0.25, 0.25, 0.5, 0.5);
  const BOX = regionRect(REGION, W, H);
  let dir: string;
  let ffmpeg: string;

  type Alpha = 'opaque' | 'clear' | 'half';
  /** RGBA pixels: a gradient outside the region, stripes of text inside it. */
  function pixels(text: 0 | 1, alpha: Alpha): Buffer {
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = (y * W + x) * 4;
        const inText = x >= BOX.x + 4 && x < BOX.x + BOX.w - 4 && y >= BOX.y + 4 && y < BOX.y + BOX.h - 4;
        const ink = inText && ((x + y * text) >> 1) % 2 === text;
        out[at] = ink ? 0 : (x * 3) % 256;
        out[at + 1] = ink ? 0 : (y * 5) % 256;
        out[at + 2] = ink ? 0 : 200;
        out[at + 3] = alpha === 'opaque' || ink ? 255 : alpha === 'clear' ? 0 : 128 + (x % 64);
      }
    }
    return out;
  }
  /** PNG colour types: 0 grey, 2 RGB, 3 palette, 4 grey and alpha, 6 RGBA. */
  const SOURCES: { name: string; alpha: Alpha; args: string[]; colourType: number; depth: number }[] = [
    { name: 'RGB', alpha: 'opaque', args: ['-pix_fmt', 'rgb24'], colourType: 2, depth: 8 },
    { name: 'RGBA, clear background', alpha: 'clear', args: ['-pix_fmt', 'rgba'], colourType: 6, depth: 8 },
    { name: 'RGBA, half transparent', alpha: 'half', args: ['-pix_fmt', 'rgba'], colourType: 6, depth: 8 },
    {
      name: 'palette with a transparent colour',
      alpha: 'clear',
      args: [
        '-vf',
        'split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128',
        '-pix_fmt',
        'pal8',
      ],
      colourType: 3,
      depth: 8,
    },
    { name: 'grey with alpha', alpha: 'clear', args: ['-pix_fmt', 'ya8'], colourType: 4, depth: 8 },
    { name: '16 bits', alpha: 'half', args: ['-pix_fmt', 'rgba64be'], colourType: 6, depth: 16 },
  ];

  const encode = async (input: Buffer, out: string, args: string[]): Promise<boolean> =>
    (
      await runCommand(
        ffmpeg,
        [
          '-v',
          'error',
          '-y',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          '-s',
          `${W}x${H}`,
          '-i',
          'pipe:0',
          ...args,
          '-frames:v',
          '1',
          out,
        ],
        { input, timeoutMs: 60_000, allowFailure: true },
      )
    ).code === 0;
  const rgba = async (bytes: Buffer): Promise<Buffer> =>
    (
      await runCommand(
        ffmpeg,
        ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
        {
          input: bytes,
          timeoutMs: 60_000,
        },
      )
    ).stdoutBuffer;
  const hide = (path: string) =>
    hideInScreenshot(ffmpeg, path, detectImage(readFileSync(path))!, [REGION], 'SS1');
  const inBox = (x: number, y: number) => x >= BOX.x && x < BOX.x + BOX.w && y >= BOX.y && y < BOX.y + BOX.h;

  beforeAll(async () => {
    ffmpeg = tools!.ffmpeg;
    dir = await mkdtemp(join(tmpdir(), 'mergestory-cover-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const source of SOURCES) {
    it(`PNG, ${source.name}: two pictures with different text give the same picture, and the cover is opaque`, async (ctx) => {
      const files = [join(dir, `${source.name}-0.png`), join(dir, `${source.name}-1.png`)];
      for (const [text, file] of files.entries()) {
        if (!(await encode(pixels(text as 0 | 1, source.alpha), file, source.args))) ctx.skip();
        const head = readFileSync(file);
        // Only the kind of PNG this case is about: FFmpeg may write another kind.
        if (head[24] !== source.depth || head[25] !== source.colourType) ctx.skip();
        if (source.colourType === 3 && !head.includes('tRNS')) ctx.skip();
      }
      const before = await Promise.all(files.map((file) => rgba(readFileSync(file))));
      expect(before[0]!.equals(before[1]!)).toBe(false);
      const after = await Promise.all(files.map(async (file) => rgba(await hide(file))));
      expect(after[0]!.equals(after[1]!)).toBe(true);
      // Every pixel of the region is opaque, so it looks the same laid over white and over black.
      const picture = after[0]!;
      for (let y = BOX.y; y < BOX.y + BOX.h; y++) {
        for (let x = BOX.x; x < BOX.x + BOX.w; x++) {
          const at = (y * W + x) * 4;
          const alpha = picture[at + 3]!;
          expect(alpha, `alpha at ${x},${y}`).toBe(255);
          for (let c = 0; c < 3; c++) {
            const over = (bg: number) => Math.round((picture[at + c]! * alpha + bg * (255 - alpha)) / 255);
            expect(over(255)).toBe(over(0));
            expect([COVER_FILL, COVER_EDGE]).toContain(picture[at + c]);
          }
        }
      }
    });
  }

  it('JPEG: every pixel of the region is close to the two greys of the cover, whatever the text was', async (ctx) => {
    for (const text of [0, 1] as const) {
      const file = join(dir, `text-${text}.jpg`);
      if (!(await encode(pixels(text, 'opaque'), file, ['-q:v', '2']))) ctx.skip();
      const after = await rgba(await hide(file));
      let worst = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!inBox(x, y)) continue;
          for (let c = 0; c < 3; c++) {
            const value = after[(y * W + x) * 4 + c]!;
            worst = Math.max(worst, Math.min(Math.abs(value - COVER_FILL), Math.abs(value - COVER_EDGE)));
          }
        }
      }
      expect(worst, `text ${text}`).toBeLessThan(24);
    }
  });
});

describe.skipIf(tools === null)('hiding in a screenshot that is wider than 2560 pixels', () => {
  let dir: string;
  // The region is the middle fifth of the picture; the two pictures differ only inside it.
  const REGION = region(0.4, 0.4, 0.2, 0.2);
  const make = async (name: string, mark: string): Promise<string> => {
    const out = join(dir, name);
    await runCommand(
      tools!.ffmpeg,
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=3000x600:rate=1:duration=1',
        '-vf',
        mark,
        '-frames:v',
        '1',
        out,
      ],
      { timeoutMs: 60_000 },
    );
    return out;
  };
  const rgb = async (src: string): Promise<Buffer> =>
    (
      await runCommand(
        tools!.ffmpeg,
        ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        { input: Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'), timeoutMs: 60_000 },
      )
    ).stdoutBuffer;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-hide-wide-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('covers the region on the stored picture, then makes it 2560 wide, with nothing of what was under it', async () => {
    const a = await make('a.png', 'drawbox=x=1300:y=260:w=200:h=60:color=black:t=fill');
    const b = await make('b.png', 'drawbox=x=1500:y=300:w=100:h=40:color=red:t=fill');
    const config = testConfig();
    const hide = { id: 'SS1', regions: [REGION] };
    const first = await loadScreenshot(a, config, 'Screenshot SS1 (a.png)', hide);
    const second = await loadScreenshot(b, config, 'Screenshot SS1 (b.png)', hide);
    expect(first).toMatchObject({ width: 2560, height: 512 });
    const [one, two] = [await rgb(first.src), await rgb(second.src)];
    // The same pixels for two pictures that differ only under the cover: nothing of it was kept.
    expect(one.equals(two)).toBe(true);
    const at = (x: number, y: number) => one.subarray((y * 2560 + x) * 3, (y * 2560 + x) * 3 + 3);
    // The middle of the region is the fill, and a point left of it is not.
    expect([...at(1280, 256)].every((v) => Math.abs(v - COVER_FILL) <= 2)).toBe(true);
    expect([...at(1000, 256)].every((v) => Math.abs(v - COVER_FILL) <= 2)).toBe(false);
    // The original picture is not in what is returned.
    expect(first.src.includes((await readFile(a)).subarray(100, 300).toString('base64'))).toBe(false);
  });

  it('is refused, naming the picture, when FFmpeg cannot do it', async () => {
    const a = await make('c.png', 'null');
    const fake = join(dir, 'fake.sh');
    await writeFile(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(
      loadScreenshot(
        a,
        testConfig({ render: { ffmpegPath: fake, ffprobePath: fake } }),
        'Screenshot SS1 (c.png)',
        {
          id: 'SS1',
          regions: [REGION],
        },
      ),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('Screenshot SS1 (c.png) cannot be shown with its hidden regions'),
    });
  });
});
