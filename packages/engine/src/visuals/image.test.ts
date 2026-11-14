import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeJpeg, makePng, pngHeader } from '../testing/png.ts';
import { detectImage, loadScreenshot, MAX_SCREENSHOT_BYTES } from './image.ts';

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
    const image = await loadScreenshot(file);
    expect(image.width).toBe(32);
    expect(image.height).toBe(16);
    expect(image.src).toBe(`data:image/png;base64,${png.toString('base64')}`);
  });

  it('detects the type from the bytes, not the extension', async () => {
    const file = join(dir, 'actually-jpeg.png');
    await writeFile(file, makeJpeg(100, 50));
    expect((await loadScreenshot(file)).src.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('rejects files over 4 MiB without reading them', async () => {
    const file = join(dir, 'huge.png');
    await writeFile(file, Buffer.concat([makePng(8, 8), Buffer.alloc(MAX_SCREENSHOT_BYTES)]));
    await expect(loadScreenshot(file)).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('too large'),
    });
  });

  it('rejects files that are not images, and missing files', async () => {
    const text = join(dir, 'notes.png');
    await writeFile(text, 'not an image');
    await expect(loadScreenshot(text)).rejects.toMatchObject({ code: 'USAGE' });
    await expect(loadScreenshot(join(dir, 'missing.png'))).rejects.toMatchObject({ code: 'USAGE' });
    await expect(loadScreenshot(dir)).rejects.toMatchObject({ code: 'USAGE' });
  });
});
