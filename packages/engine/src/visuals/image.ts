/**
 * Screenshot loading. Images supplied by the caller are embedded in the render plan as data URLs,
 * so the browser runtime never needs file or network access.
 */
import { readFile, stat } from 'node:fs/promises';
import { MergeStoryError } from '../core/errors.ts';
import type { ResolvedImage } from '../core/render-plan.ts';

/** Largest screenshot file that is embedded. Bigger files make the plan slow to hand to the browser. */
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

/** Guards the browser against tiny files that decode to enormous bitmaps. */
const MAX_PIXELS = 40_000_000;

export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** JPEG start-of-frame markers that carry the image size (all SOFn except DHT, JPG and DAC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function pngInfo(buf: Buffer): ImageInfo | null {
  if (buf.length < 24) return null;
  if (!PNG_SIGNATURE.every((byte, i) => buf[i] === byte)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegInfo(buf: Buffer): ImageInfo | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1]!;
    if (marker === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    // Standalone markers have no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image or start of scan before any frame header
    const length = buf.readUInt16BE(pos + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      if (pos + 9 > buf.length) return null;
      return { mime: 'image/jpeg', height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + length;
  }
  return null;
}

/** Detect PNG or JPEG from the first bytes (never from the file name) and read the size from the header. */
export function detectImage(buf: Buffer): ImageInfo | null {
  const info = pngInfo(buf) ?? jpegInfo(buf);
  if (!info) return null;
  if (info.width < 1 || info.height < 1 || info.width * info.height > MAX_PIXELS) return null;
  return info;
}

/** Read a screenshot from disk and return it as a data URL. Throws a USAGE error for anything unusable. */
export async function loadScreenshot(path: string): Promise<ResolvedImage> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch (err) {
    throw new MergeStoryError('USAGE', 'A screenshot could not be read.', {
      hint: 'Pass the path of an existing PNG or JPEG file.',
      cause: err,
    });
  }
  if (size > MAX_SCREENSHOT_BYTES) {
    throw new MergeStoryError(
      'USAGE',
      `A screenshot is too large (${(size / 1024 / 1024).toFixed(1)} MiB; the limit is 4 MiB).`,
      { hint: 'Resize or recompress the image, or leave the screenshot out.' },
    );
  }
  const data = await readFile(path);
  const info = detectImage(data);
  if (!info) {
    throw new MergeStoryError('USAGE', 'A screenshot is not a valid PNG or JPEG image.', {
      hint: 'Only PNG and JPEG files are supported, up to 4 MiB and 40 megapixels.',
    });
  }
  return {
    src: `data:${info.mime};base64,${data.toString('base64')}`,
    width: info.width,
    height: info.height,
  };
}
