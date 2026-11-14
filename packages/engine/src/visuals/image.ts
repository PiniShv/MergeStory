/**
 * Screenshot loading. Images supplied by the caller are embedded in the render plan as data URLs,
 * so the browser runtime never needs file or network access.
 */
import { readFile, stat } from 'node:fs/promises';
import { MergeStoryError } from '../core/errors.ts';
import { detectImage } from '../core/image.ts';
import type { ResolvedImage } from '../core/render-plan.ts';

export { detectImage, type ImageInfo } from '../core/image.ts';

/** Largest screenshot file that is embedded. Bigger files make the plan slow to hand to the browser. */
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

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
