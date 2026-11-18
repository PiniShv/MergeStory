import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import { testConfig } from '../testing/context.ts';
import { ffmpegTo } from '../testing/media.ts';
import { makeJpeg, makePng, pngHeader } from '../testing/png.ts';
import { detectImage, loadScreenshot, MAX_SCREENSHOT_BYTES, MAX_SCREENSHOT_WIDTH } from './image.ts';

const tools = await resolveFfmpeg(testConfig()).catch(() => null);

/** A JPEG APP1 segment whose EXIF data holds only an orientation, in either byte order. */
function exif(orientation: number, order: 'MM' | 'II' = 'MM'): Buffer {
  const tiff = Buffer.alloc(26);
  const u16 = (value: number, at: number) =>
    order === 'II' ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at);
  const u32 = (value: number, at: number) =>
    order === 'II' ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at);
  tiff.write(order, 0, 'latin1');
  u16(42, 2);
  u32(8, 4); // the first folder of tags, right after this header
  u16(1, 8); // one tag in it
  u16(0x0112, 10); // orientation
  u16(3, 12); // SHORT
  u32(1, 14); // one value
  u16(orientation, 18);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(2 + 6 + tiff.length, 2);
  return Buffer.concat([head, Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

describe('detectImage', () => {
  it('reads PNG and JPEG sizes from the header', () => {
    expect(detectImage(makePng(640, 480))).toEqual({ mime: 'image/png', width: 640, height: 480 });
    expect(detectImage(makeJpeg(1280, 720))).toEqual({ mime: 'image/jpeg', width: 1280, height: 720 });
  });

  it('reads the size a browser draws a JPEG at, turned by its EXIF orientation', () => {
    const jpeg = makeJpeg(1280, 720);
    const withExif = (segment: Buffer, at = 2) =>
      Buffer.concat([jpeg.subarray(0, at), segment, jpeg.subarray(at)]);
    const turned = { mime: 'image/jpeg', width: 720, height: 1280 };
    expect(detectImage(withExif(exif(6)))).toEqual(turned);
    expect(detectImage(withExif(exif(8, 'II')))).toEqual(turned);
    // After the frame header, where some cameras write it.
    expect(detectImage(withExif(exif(5), jpeg.length - 2))).toEqual(turned);
    // Turned by a half, mirrored, not an orientation, or pointing outside its data: the size stays.
    const outside = exif(6);
    outside.writeUInt32BE(0xffff, 14);
    for (const segment of [exif(3), exif(2), exif(9), outside]) {
      expect(detectImage(withExif(segment))).toEqual({ mime: 'image/jpeg', width: 1280, height: 720 });
    }
  });

  it('rejects everything else, whatever the file name says', () => {
    expect(detectImage(Buffer.from('GIF89a......'))).toBeNull();
    expect(detectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImage(Buffer.from('plain text file'))).toBeNull();
    expect(detectImage(Buffer.alloc(0))).toBeNull();
    expect(detectImage(pngHeader(0, 10))).toBeNull();
    expect(detectImage(pngHeader(70000, 70000))).toBeNull();
    expect(detectImage(makeJpeg(10, 0))).toBeNull();
    expect(detectImage(makePng(640, 480).subarray(0, 20))).toBeNull();
    expect(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull();
  });
});

describe('loadScreenshot', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-image-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('embeds a PNG as a data URL with its size', async () => {
    const file = join(dir, 'shot.png');
    const png = makePng(32, 16);
    await writeFile(file, png);
    const image = await loadScreenshot(file, testConfig());
    expect(image.width).toBe(32);
    expect(image.height).toBe(16);
    expect(image.src).toBe(`data:image/png;base64,${png.toString('base64')}`);
  });

  it('detects the type from the bytes, not the extension', async () => {
    const file = join(dir, 'actually-jpeg.png');
    await writeFile(file, makeJpeg(100, 50));
    expect((await loadScreenshot(file, testConfig())).src.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('rejects files over 4 MiB without reading them', async () => {
    const file = join(dir, 'huge.png');
    await writeFile(file, Buffer.concat([makePng(8, 8), Buffer.alloc(MAX_SCREENSHOT_BYTES)]));
    await expect(loadScreenshot(file, testConfig())).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('too large'),
    });
  });

  it('rejects files that are not images, and missing files', async () => {
    const text = join(dir, 'notes.png');
    await writeFile(text, 'not an image');
    await expect(loadScreenshot(text, testConfig())).rejects.toMatchObject({ code: 'USAGE' });
    await expect(loadScreenshot(join(dir, 'missing.png'), testConfig())).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(loadScreenshot(dir, testConfig())).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('loadScreenshot: a picture wider than 2560 pixels', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-image-wide-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const wide = (size: string, file: string) =>
    ffmpegTo(tools!.ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${size}:rate=1:duration=1`,
      '-frames:v',
      '1',
      file,
    ]);
  const decoded = (src: string) => {
    const [, mime, data] = /^data:([^;]+);base64,(.*)$/.exec(src) ?? [];
    return { mime, info: detectImage(Buffer.from(data ?? '', 'base64')) };
  };

  it.skipIf(tools === null)(
    'is made 2560 wide, with the same shape and type, and the file is not changed',
    async (ctx) => {
      for (const [name, mime, size, height] of [
        ['wide.png', 'image/png', '3000x1500', 1280],
        ['wide.jpg', 'image/jpeg', '3000x1000', 853],
      ] as const) {
        const file = join(dir, name);
        if (!(await wide(size, file))) return ctx.skip();
        const before = await readFile(file);
        const image = await loadScreenshot(file, testConfig());
        expect(image, name).toMatchObject({ width: MAX_SCREENSHOT_WIDTH, height });
        expect(decoded(image.src), name).toEqual({
          mime,
          info: { mime, width: MAX_SCREENSHOT_WIDTH, height },
        });
        expect(await readFile(file), name).toEqual(before);
      }
    },
  );

  it.skipIf(tools === null)('is left alone at 2560 pixels, and made smaller from 2561', async () => {
    const exact = join(dir, 'exact.png');
    const exactBytes = makePng(MAX_SCREENSHOT_WIDTH, 4);
    await writeFile(exact, exactBytes);
    expect((await loadScreenshot(exact, testConfig())).src).toBe(
      `data:image/png;base64,${exactBytes.toString('base64')}`,
    );
    const over = join(dir, 'over.png');
    await writeFile(over, makePng(MAX_SCREENSHOT_WIDTH + 1, 4));
    expect(await loadScreenshot(over, testConfig())).toMatchObject({
      width: MAX_SCREENSHOT_WIDTH,
      height: 4,
    });
  });

  it.skipIf(tools === null)(
    'stops with an error that names the picture when FFmpeg cannot read it',
    async () => {
      const broken = join(dir, 'broken.png');
      // The header says 3000 pixels wide, and no picture data follows.
      await writeFile(broken, pngHeader(3000, 100));
      const error = await loadScreenshot(broken, testConfig(), 'Screenshot SS2 (broken.png)').catch(
        (e: unknown) => e,
      );
      // Not the last words: another FFmpeg version may fail in another way.
      expect(error).toMatchObject({ code: 'USAGE' });
      expect((error as Error).message).toContain('Screenshot SS2 (broken.png)');
      expect((error as Error).message).toContain('could not be made smaller');
    },
  );

  it('says that the smaller picture would be too large, and what to do, when FFmpeg writes more than the cap', async () => {
    const fake = join(dir, 'fake-big-ffmpeg.sh');
    await writeFile(fake, '#!/bin/sh\nhead -c 17000000 /dev/zero\n');
    await chmod(fake, 0o755);
    const file = join(dir, 'big-result.png');
    await writeFile(file, makePng(3000, 10));
    const error = await loadScreenshot(
      file,
      testConfig({ render: { ffmpegPath: fake, ffprobePath: fake } }),
      'Screenshot SS1 (big-result.png)',
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'USAGE',
      message:
        'Screenshot SS1 (big-result.png) is 3000 pixels wide and could not be made smaller: the smaller picture would be larger than 16 MB.',
      hint: expect.stringContaining('JPEG'),
    });
  });

  it('runs FFmpeg with only this file, only the picture type and only the two picture decoders', async () => {
    const calls = join(dir, 'calls.txt');
    const fake = join(dir, 'fake-ffmpeg.sh');
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${calls}'\nexit 1\n`);
    await chmod(fake, 0o755);
    for (const [name, type, bytes] of [
      ['a.png', 'png_pipe', makePng(3000, 10)],
      ['b.jpg', 'jpeg_pipe', makeJpeg(3000, 10)],
    ] as const) {
      const file = join(dir, name);
      await writeFile(file, bytes);
      await expect(
        loadScreenshot(file, testConfig({ render: { ffmpegPath: fake, ffprobePath: fake } })),
      ).rejects.toMatchObject({ code: 'USAGE' });
      const args = (await readFile(calls, 'utf8')).trim().split('\n');
      const argAfter = (flag: string) => args[args.indexOf(flag) + 1];
      expect(argAfter('-protocol_whitelist'), name).toBe('file');
      expect(argAfter('-f'), name).toBe(type);
      expect(argAfter('-codec_whitelist'), name).toBe('png,mjpeg');
      expect(argAfter('-max_pixels'), name).toBe('40000000');
      expect(argAfter('-i'), name).toBe(file);
      // The whitelists come before the input, where FFmpeg applies them to it.
      expect(
        Math.max(
          ...['-protocol_whitelist', '-f', '-codec_whitelist', '-max_pixels'].map((f) => args.indexOf(f)),
        ),
      ).toBeLessThan(args.indexOf('-i'));
      expect(args.at(-1)).toBe('pipe:1');
    }
  });
});
