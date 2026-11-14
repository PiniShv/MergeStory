/** PNG or JPEG, told from the first bytes of a file (never from its name), with the size a browser draws it at. */

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

/** True for an animated PNG (APNG): one with an animation chunk (acTL) before its image data. Browsers play those. */
export function isAnimatedPng(buf: Buffer): boolean {
  if (!pngInfo(buf)) return false;
  for (let pos = 8; pos + 8 <= buf.length; pos += 12 + buf.readUInt32BE(pos)) {
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
  }
  return false;
}

/** The orientation, 1 to 8, in the EXIF data (a TIFF header and its first folder of tags) of a JPEG; 1 when none. */
function exifOrientation(tiff: Buffer): number {
  const order = tiff.toString('latin1', 0, 2);
  if (tiff.length < 8 || (order !== 'II' && order !== 'MM')) return 1;
  const u16 = (at: number) => (order === 'II' ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (order === 'II' ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (u16(2) !== 42 || ifd + 2 > tiff.length) return 1;
  for (let i = 0, count = u16(ifd); i < count && ifd + 14 + i * 12 <= tiff.length; i++) {
    const entry = ifd + 2 + i * 12;
    // Tag 0x0112 holds one SHORT (type 3), first in its 4-byte value field.
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpegInfo(buf: Buffer): ImageInfo | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let size: { width: number; height: number } | null = null;
  let orientation: number | null = null;
  let pos = 2;
  // Every header up to the image data: the EXIF orientation may come after the frame header.
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) break;
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
    if (marker === 0xd9 || marker === 0xda) break; // end of image, or start of scan: no more headers
    const length = buf.readUInt16BE(pos + 2);
    if (length < 2) break;
    if (isStartOfFrame(marker)) {
      if (pos + 9 > buf.length) break;
      size ??= { width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5) };
    } else if (
      marker === 0xe1 &&
      orientation === null &&
      buf.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0'
    ) {
      orientation = exifOrientation(buf.subarray(pos + 10, pos + 2 + length));
    }
    pos += 2 + length;
  }
  if (!size) return null;
  // Browsers draw a JPEG turned by its EXIF orientation; 5 to 8 turn it a quarter, so width and height swap.
  const turned = (orientation ?? 1) >= 5;
  return {
    mime: 'image/jpeg',
    width: turned ? size.height : size.width,
    height: turned ? size.width : size.height,
  };
}

/** Detect PNG or JPEG from the first bytes (never from the file name) and read the size from the header. */
export function detectImage(buf: Buffer): ImageInfo | null {
  const info = pngInfo(buf) ?? jpegInfo(buf);
  if (!info) return null;
  if (info.width < 1 || info.height < 1 || info.width * info.height > MAX_PIXELS) return null;
  return info;
}
