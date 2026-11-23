/**
 * Hiding parts of a real picture. A region is covered by one opaque block of constant colours: no
 * pixel of the picture under it reaches the result, so the cover is the same whatever was under it. A
 * blur or a mosaic is not used, because a blurred or pixelated text can sometimes be read back. FFmpeg
 * does the work, for a screenshot here and for the frames of a recording in recording-frames.ts, and the
 * picture as it was is never kept anywhere but in the caller's own file.
 */
import { abortedError, MergeStoryError } from '../core/errors.ts';
import { detectImage, type ImageInfo } from '../core/image.ts';
import { shownName } from '../core/media-probe.ts';
import { runCommand } from '../core/process.ts';
import { RECORDING_FPS } from '../core/recording-frames.ts';
import type { HiddenRegion } from '../core/types.ts';

/** The fill of a cover (#262626) and its edge (#b0b0b0): neutral greys, so a colour matrix cannot tint them. */
export const COVER_FILL = 0x26;
export const COVER_EDGE = 0xb0;
/** The picture limit that every call on a caller's picture sets. */
const MAX_PIXELS = 40_000_000;
const HIDE_TIMEOUT_MS = 60_000;

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A region in pixels of a picture of this size. The sides are even, rounded outwards, so a little more
 * is hidden and never less, and never under 2 pixels: at the far edge of the picture it moves inwards.
 */
export function regionRect(region: HiddenRegion, width: number, height: number): PixelRect {
  const side = (start: number, length: number, size: number): [number, number] => {
    const from = 2 * Math.floor((start * size) / 2);
    const to = Math.min(size, 2 * Math.ceil(((start + length) * size) / 2));
    return to - from >= 2 ? [from, to - from] : [Math.max(0, Math.min(from, size - 2)), Math.min(2, size)];
  };
  const [x, w] = side(region.x, region.w, width);
  const [y, h] = side(region.y, region.h, height);
  return { x, y, w, h };
}

/** The edge of a cover, in pixels of the source: thicker on a large picture, so it still shows when the picture is drawn small. */
export function coverEdge(pictureWidth: number): number {
  return Math.max(2, 2 * Math.round(pictureWidth / 1280));
}

/**
 * The part of the filter that turns the region into its cover. The crop only gives frames of the right
 * size and time: every pixel is then set to a constant, and `rgb24` drops any alpha, so the cover is opaque.
 */
export function coverFilter(rect: PixelRect, edge: number): string {
  const fill = `lutrgb=r=${COVER_FILL}:g=${COVER_FILL}:b=${COVER_FILL}`;
  if (rect.w <= 2 * edge || rect.h <= 2 * edge) {
    return `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},format=rgb24,${fill}`;
  }
  const hex = COVER_EDGE.toString(16);
  return [
    `crop=${rect.w - 2 * edge}:${rect.h - 2 * edge}:${rect.x + edge}:${rect.y + edge}`,
    'format=rgb24',
    fill,
    `pad=${rect.w}:${rect.h}:${edge}:${edge}:color=0x${hex}${hex}${hex}`,
  ].join(',');
}

/**
 * The frames of a recording's cut that a region with `from` and `to` covers, by number from the clip's
 * start. The cut has RECORDING_FPS frames a second, and frame k shows the picture that a player shows just
 * before (k + 0.5) / RECORDING_FPS seconds (the rate step takes the nearest picture). So the cover is on
 * every frame whose picture a player shows from one frame before `from` to one frame after `to`.
 */
export function coveredFrames(region: HiddenRegion): { first: number; last: number } | null {
  if (region.from === undefined || region.to === undefined) return null;
  // The small slack keeps a time that lies exactly on the margin inside it, whatever the rounding.
  return {
    first: Math.max(0, Math.ceil((region.from - 1 / RECORDING_FPS) * RECORDING_FPS - 0.5 - 1e-6)),
    last: Math.floor((region.to + 1 / RECORDING_FPS) * RECORDING_FPS - 0.5 + 1e-6),
  };
}

/**
 * The FFmpeg filter that hides these regions in a picture of this size: one split, one cover per region,
 * and the overlays in series, so the time grows in a straight line with the number of regions. A region
 * with `from` and `to` is covered only in its frames (coveredFrames), so for a recording this filter must
 * come right after the step to RECORDING_FPS frames a second, on frames counted from the clip's start.
 */
export function hideFilter(regions: readonly HiddenRegion[], width: number, height: number): string {
  const edge = coverEdge(width);
  const rects = regions.map((region) => regionRect(region, width, height));
  const covers = rects.map((rect, i) => `[c${i}]${coverFilter(rect, edge)}[m${i}]`);
  const when = (region: HiddenRegion): string => {
    const frames = coveredFrames(region);
    return frames ? `:enable='between(n,${frames.first},${frames.last})'` : '';
  };
  const overlays = rects.map(
    (rect, i) =>
      `[${i === 0 ? 'o' : `v${i - 1}`}][m${i}]overlay=${rect.x}:${rect.y}:format=auto${when(regions[i]!)}${i === rects.length - 1 ? '' : `[v${i}]`}`,
  );
  return [
    `split=${regions.length + 1}[o]${rects.map((_, i) => `[c${i}]`).join('')}`,
    ...covers,
    ...overlays,
  ].join(';');
}

/** Why a screenshot that is stored turned is refused when it has hidden regions. */
export function turnedReason(orientation: number): string {
  return `it is stored turned (EXIF orientation ${orientation}), so a region could land in the wrong place. Save it upright first`;
}

/**
 * The screenshot at `path` with the regions hidden, as the bytes of a picture of the same type (PNG
 * stays PNG, JPEG stays JPEG). `info` is what the caller read from the file. Throws USAGE, naming the
 * screenshot, when FFmpeg fails or answers with anything but the same size: it never gives back the
 * picture as it was.
 */
export async function hideInScreenshot(
  ffmpeg: string,
  path: string,
  info: ImageInfo,
  regions: readonly HiddenRegion[],
  id: string,
  signal?: AbortSignal,
  // The covered picture is made this wide when it is wider, in the same call, so a cover is always drawn on the stored pixels.
  scale?: { scaleTo: number; maxBytes: number },
): Promise<Buffer> {
  const refuse = (reason: string, cause?: unknown): MergeStoryError =>
    new MergeStoryError(
      'USAGE',
      `Screenshot ${id} (${shownName(path)}) cannot be shown with its hidden regions: ${reason}.`,
      { hint: 'Nothing was shown. Fix the file or the regions, or leave the screenshot out.', cause },
    );
  // A picture stored turned is drawn turned, and FFmpeg versions do not agree on turning it, so a region could miss.
  if (info.orientation !== undefined) throw refuse(turnedReason(info.orientation));
  const png = info.mime === 'image/png';
  // A JPEG is encoded again, so its pixels outside the regions change a little. A PNG keeps them exactly.
  // shortcut: a JPEG outside the regions is not byte for byte the same, upgrade when a lossless JPEG edit is needed.
  const result = await runCommand(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-protocol_whitelist',
      'file',
      '-f',
      png ? 'png_pipe' : 'jpeg_pipe',
      '-codec_whitelist',
      'png,mjpeg',
      '-max_pixels',
      String(MAX_PIXELS),
      '-i',
      path,
      '-vf',
      hideFilter(regions, info.width, info.height) + (scale ? `,scale=${scale.scaleTo}:-1` : ''),
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      png ? 'png' : 'mjpeg',
      ...(png ? [] : ['-q:v', '2']),
      'pipe:1',
    ],
    {
      timeoutMs: HIDE_TIMEOUT_MS,
      allowFailure: true,
      signal,
      ...(scale ? { maxOutputBytes: scale.maxBytes } : {}),
    },
  ).catch((err: unknown) => {
    if (signal?.aborted) throw abortedError(err);
    throw refuse(
      err instanceof Error && err.name === 'TimedOutError' ? 'it took too long' : 'FFmpeg stopped',
      err,
    );
  });
  if (result.code !== 0) throw refuse('FFmpeg reported an error');
  const out = detectImage(result.stdoutBuffer);
  // A file that changed after it was read must not put a region in the wrong place.
  const width = scale ? scale.scaleTo : info.width;
  const height = scale ? Math.round((info.height * width) / info.width) : info.height;
  if (
    !out ||
    out.mime !== info.mime ||
    out.width !== width ||
    Math.abs(out.height - height) > (scale ? 1 : 0)
  ) {
    throw refuse('the result is not a picture of the same type and size');
  }
  return result.stdoutBuffer;
}
