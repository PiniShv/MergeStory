import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePng, pngHeader } from '../testing/png.ts';
import { detectImage, loadScreenshot, MAX_SCREENSHOT_BYTES } from './image.ts';

/** A JPEG skeleton with a JFIF segment and a baseline frame header (enough to read the size from). */
function makeJpeg(width: number, height: number): Buffer {
  const jfif = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.set([0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, sof, Buffer.from([0xff, 0xd9])]);
}

describe('detectImage', () => {
  it('reads PNG and JPEG sizes from the header', () => {
    expect(detectImage(makePng(640, 480))).toEqual({ mime: 'image/png', width: 640, height: 480 });
    expect(detectImage(makeJpeg(1280, 720))).toEqual({ mime: 'image/jpeg', width: 1280, height: 720 });
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
