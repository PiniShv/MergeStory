/**
 * Screenshot loading. Images supplied by the caller are embedded in the render plan as data URLs,
 * so the browser runtime never needs file or network access.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveFfmpeg } from '../core/binaries.ts';
import type { Config } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import { detectImage, type ImageInfo } from '../core/image.ts';
import { runCommand } from '../core/process.ts';
import type { ResolvedImage } from '../core/render-plan.ts';

export { detectImage, type ImageInfo } from '../core/image.ts';

/** Largest screenshot file that is embedded. Bigger files make the plan slow to hand to the browser. */
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

/** A picture wider than this is made this wide before it is embedded, so a full-page capture does not slow the render. */
export const MAX_SCREENSHOT_WIDTH = 2560;
const SHRINK_TIMEOUT_MS = 60_000;
/** The most that the smaller picture may be. A picture that is made smaller can be a larger file (a PNG with fine detail), so a big result is possible. */
const MAX_SHRUNK_BYTES = 4 * MAX_SCREENSHOT_BYTES;

/**
 * Make a picture 2560 pixels wide with FFmpeg and return it as the same type of picture. FFmpeg reads
 * only this file, only as the detected picture type and only with the two picture decoders; the answer
 * comes through a pipe. The result is checked. `name` is how the messages call the picture.
 */
async function shrink(ffmpeg: string, path: string, info: ImageInfo, name: string): Promise<Buffer> {
  const capMiB = MAX_SHRUNK_BYTES / 1024 / 1024;
  const refuse = (reason: string, cause?: unknown, tooBig = false): MergeStoryError =>
    new MergeStoryError(
      'USAGE',
      `${name} is ${info.width} pixels wide and could not be made smaller: ${reason}.`,
      {
        hint: tooBig
          ? `Save the picture as a JPEG or crop it, or leave it out.`
          : `Make it ${MAX_SCREENSHOT_WIDTH} pixels wide or less yourself, or leave it out.`,
        cause,
      },
    );
  const png = info.mime === 'image/png';
  const result = await runCommand(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-protocol_whitelist',
      'file',
      '-f',
      png ? 'png_pipe' : 'jpeg_pipe',
      '-codec_whitelist',
      'png,mjpeg',
      '-max_pixels',
      '40000000',
      '-i',
      resolve(path),
      '-vf',
      `scale=${MAX_SCREENSHOT_WIDTH}:-1`,
      '-frames:v',
      '1',
      ...(png ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', '2']),
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    { timeoutMs: SHRINK_TIMEOUT_MS, allowFailure: true, maxOutputBytes: MAX_SHRUNK_BYTES },
  ).catch((err: unknown) => {
    if (err instanceof Error && err.name === 'OutputTooLargeError') {
      throw refuse(`the smaller picture would be larger than ${capMiB} MB`, err, true);
    }
    throw refuse(
      err instanceof Error && err.name === 'TimedOutError' ? 'it took too long' : 'FFmpeg stopped',
      err,
    );
  });
  if (result.code !== 0) throw refuse('FFmpeg reported an error');
  const made = detectImage(result.stdoutBuffer);
  const height = Math.round((info.height * MAX_SCREENSHOT_WIDTH) / info.width);
  if (made?.mime !== info.mime || made.width !== MAX_SCREENSHOT_WIDTH || Math.abs(made.height - height) > 1) {
    throw refuse('the result is not a picture of the right size');
  }
  return result.stdoutBuffer;
}

/**
 * Read a screenshot from disk and return it as a data URL. Throws a USAGE error for anything unusable.
 * A picture wider than 2560 pixels is made that wide first (the file itself is not changed); `name` is
 * how the error calls the picture ("Screenshot SS1 (page.png)").
 */
export async function loadScreenshot(
  path: string,
  config: Pick<Config, 'render'>,
  name = 'A screenshot',
): Promise<ResolvedImage> {
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
  if (info.width > MAX_SCREENSHOT_WIDTH) {
    const smaller = await shrink((await resolveFfmpeg(config)).ffmpeg, path, info, name);
    const made = detectImage(smaller) as ImageInfo;
    return {
      src: `data:${made.mime};base64,${smaller.toString('base64')}`,
      width: made.width,
      height: made.height,
    };
  }
  return {
    src: `data:${info.mime};base64,${data.toString('base64')}`,
    width: info.width,
    height: info.height,
  };
}
